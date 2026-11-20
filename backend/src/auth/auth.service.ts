import {
  BadGatewayException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppSessionService } from '../app-session/app-session.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { SchoolLinksService } from '../school-links/school-links.service';
import type { MeSchool } from '../school-links/school-links.service';
import { householdAdoptionEnabled } from '../common/adoption-flag';
import {
  createMashovAxios,
  isUpstreamUnreachable,
  resolveMashovBaseUrl,
} from '../common/http/mashov-http';
import {
  connectionStudentWhere,
  linkStudentsToConnection,
} from '../common/student-links';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 900; // 15 minutes

interface MashovLoginResponse {
  credential: {
    userId: string;
    displayName: string;
    semel: number;
    year: number;
  };
  accessToken: {
    userSettings: { detailsState: number };
    schoolSettings: {
      schoolName: string;
      schoolYear: number;
    };
    children: Array<{
      childGuid: string;
      familyName: string;
      privateName: string;
      classCode: string;
      classNum: number;
      gender: string;
      groups: number[];
    }>;
    /**
     * Children no longer enrolled. Element shape is undocumented, so it is
     * parsed defensively — `childGuid`, else `guid`, else a bare string.
     */
    inactiveChildren?: unknown[];
    userSchoolYears?: number[];
    username: string;
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly mashovBaseUrl: string;
  /** Shared Mashov client: applies the egress proxy and the abort-signal timeout. */
  private readonly http: AxiosInstance;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly appSessionService: AppSessionService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    private readonly schoolYearService: SchoolYearService,
    private readonly schoolLinksService: SchoolLinksService,
  ) {
    this.mashovBaseUrl = resolveMashovBaseUrl(
      this.configService.get<string>('MASHOV_BASE_URL'),
    );
    this.http = createMashovAxios(this.mashovBaseUrl);
  }

  async getSchools(): Promise<unknown[]> {
    const response = await this.http.get<unknown[]>('/api/schools');
    return response.data;
  }

  async checkRateLimit(ip: string): Promise<void> {
    const key = `ratelimit:login:${ip}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }
    if (count > RATE_LIMIT_MAX) {
      throw Object.assign(new Error('Too many login attempts'), { statusCode: 429 });
    }
  }

  async login(
    semel: number,
    username: string,
    password: string,
    ip: string,
  ): Promise<{ sessionToken: string; isFirstLogin: boolean }> {
    await this.checkRateLimit(ip);

    // The year is resolved, not configured: Mashov scopes the whole session to
    // the year in this body, so a stale year silently freezes every later GET.
    const candidate = await this.schoolYearService.resolveForSchool(Number(semel));

    // Deliberately NOT keyed on the year — keying on it stranded existing
    // connections on the year they were created with, which is what froze
    // production on 2025/26. School + username is the stable identity, and it
    // is now a unique key, so this is a findUnique rather than a findFirst.
    const existingConnBeforeLogin = await this.prisma.householdConnection.findUnique({
      where: { schoolCode_username: { schoolCode: Number(semel), username } },
      select: { id: true, mashovUniqueId: true, userId: true },
    });

    let year = candidate.year;
    let loginData: MashovLoginResponse;
    let newUniqueId: string | undefined;

    try {
      let attempt = await this.postLogin(
        Number(semel),
        year,
        username,
        password,
        existingConnBeforeLogin?.mashovUniqueId ?? null,
      );

      // Phase 2: Mashov is the authority. Its cookies are year-scoped, so a
      // corrected year needs a fresh login — reusing the first login's cookies
      // would reproduce the frozen-year bug a year later. Capped at one retry.
      const reconciled = this.schoolYearService.reconcileFromLogin(year, attempt.data);
      if (reconciled.changed) {
        this.logger.warn(
          `Mashov reports active year=${reconciled.year} for semel=${semel}, re-logging in (sent ${year})`,
        );
        // The resolver caches per semel for 6h. Leaving the vetoed candidate in
        // the cache makes every sign-in for the rest of that window pay two
        // full logins against a rate-limited upstream.
        this.schoolYearService.invalidate(Number(semel));
        try {
          const corrected = await this.postLogin(
            Number(semel),
            reconciled.year,
            username,
            password,
            existingConnBeforeLogin?.mashovUniqueId ?? null,
          );
          year = reconciled.year;
          attempt = corrected;
        } catch (retryErr) {
          // The first login already succeeded, so the credentials are good.
          // Reporting this as INVALID_CREDENTIALS would send the parent off to
          // retype a password that was correct — the same lie this method
          // refuses to tell about an unreachable upstream.
          this.logger.error(
            `Re-login at year=${reconciled.year} failed for semel=${semel}; keeping the year ${year} session: ${
              retryErr instanceof Error ? retryErr.message : 'unknown error'
            }`,
          );
        }
      }

      loginData = attempt.data;
      newUniqueId = attempt.newUniqueId;
    } catch (err) {
      // Never report an upstream outage as bad credentials — the user would be
      // sent off to retype a password that was correct all along.
      if (isUpstreamUnreachable(err)) {
        this.logger.error(
          `Mashov login unreachable for semel=${semel}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        throw new BadGatewayException({
          error: {
            code: 'UPSTREAM_ERROR',
            message: 'Mashov is not reachable right now. Please try again shortly.',
            details: [],
          },
        });
      }
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        throw new UnauthorizedException({
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid credentials, please try again',
            details: [],
          },
        });
      }
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials, please try again',
          details: [],
        },
      });
    }

    const mashovUserId = loginData.credential?.userId;
    const displayName = loginData.credential?.displayName ?? username;
    const schoolSettings = loginData.accessToken?.schoolSettings;

    if (!mashovUserId) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials, please try again',
          details: [],
        },
      });
    }

    const encryptedPassword = this.encryptionService.encrypt(password);

    // ADOPTION.
    //
    // Mashov issues a separate account per school, with a different
    // `credential.userId` for each. Without this, signing in with the second
    // school's credentials creates a SECOND AppUser, a second session and a
    // second household -- so a parent who linked school B from inside their
    // session, then signed out and back in with B's password, would land in an
    // empty app with no way back to their own children.
    //
    // The credentials have already been validated by Mashov above, so reaching
    // here at all proves the caller holds this school's password. That is the
    // whole authorisation: see ADR-0029 for the trust model and why unlink is
    // the reversal.
    // Read before the branch, because the branch needs it: an adoption is a
    // connection owned by a household that is NOT the one this credential maps
    // to. Without the comparison the branch fires on every returning sign-in
    // and returns before the upsert below, which is the only place
    // `displayName` is refreshed from the credential.
    const existingUser = await this.prisma.appUser.findUnique({
      where: { mashovUserId },
    });
    // `=== null`, matching `isFirstLogin` below: Prisma's `findUnique` answers
    // `null`, never `undefined`, and spelling both guards the same way keeps
    // that invariant in the code rather than only in Prisma's contract.
    const ownsConnection =
      existingUser !== null && existingConnBeforeLogin?.userId === existingUser.id;

    if (this.adoptionEnabled() && existingConnBeforeLogin?.userId && !ownsConnection) {
      const ownerId = existingConnBeforeLogin.userId;
      this.logger.log(
        `Adopting sign-in for semel=${semel} into existing household ${ownerId}`,
      );

      await this.prisma.householdConnection.update({
        where: { id: existingConnBeforeLogin.id },
        data: {
          encryptedPassword,
          schoolYear: year,
          schoolName: schoolSettings?.schoolName,
          upstreamUserId: mashovUserId,
          lastLoginAt: new Date(),
          active: true,
          ...(newUniqueId ? { mashovUniqueId: newUniqueId } : {}),
        },
      });

      await this.persistLoginRoster(loginData, existingConnBeforeLogin.id);

      const sessionToken = await this.appSessionService.createSession(ownerId, ip);
      // `false` is correct: this household has signed in before, and the
      // first-login sync screen would be wrong -- the data is already here.
      return { sessionToken, isFirstLogin: false };
    }

    // Upsert AppUser
    const appUser = await this.prisma.appUser.upsert({
      where: { mashovUserId },
      create: {
        mashovUserId,
        semel: Number(semel),
        username,
        displayName,
      },
      update: {
        username,
        displayName,
      },
    });

    const isFirstLogin = existingUser === null;

    // The household this session belongs to. Normally the AppUser just
    // upserted -- but if this user's only connection was absorbed into another
    // household, follow the pointer exactly ONE hop. One hop, not a loop: a
    // cycle would hang the login, and a chain long enough to matter means the
    // data is already wrong. Bailing to the original is the safe answer,
    // because it is the household whose password was just proven.
    const ownerId = await this.resolveMergedOwner(appUser.id, appUser.mergedIntoUserId);

    // Upsert HouseholdConnection with userId
    const existingConn = existingConnBeforeLogin;

    // Captured, not discarded: the children written below belong to THIS
    // connection, and until they carry its id nothing in the schema says which
    // household owns them.
    let connectionId: string;

    if (existingConn) {
      connectionId = existingConn.id;
      await this.prisma.householdConnection.update({
        where: { id: existingConn.id },
        data: {
          username,
          encryptedPassword,
          // This is the mechanism that advances an existing connection with no
          // admin action: the 13 sync crons read conn.schoolYear, not the env.
          schoolYear: year,
          schoolName: schoolSettings?.schoolName,
          upstreamUserId: mashovUserId,
          lastLoginAt: new Date(),
          active: true,
          userId: ownerId,
          ...(newUniqueId ? { mashovUniqueId: newUniqueId } : {}),
        },
      });
    } else {
      const created = await this.prisma.householdConnection.create({
        data: {
          schoolCode: Number(semel),
          schoolYear: year,
          username,
          encryptedPassword,
          schoolName: schoolSettings?.schoolName,
          upstreamUserId: mashovUserId,
          lastLoginAt: new Date(),
          active: true,
          userId: ownerId,
          ...(newUniqueId ? { mashovUniqueId: newUniqueId } : {}),
        },
      });
      connectionId = created.id;
    }

    await this.persistLoginRoster(loginData, connectionId);

    // Create session
    const sessionToken = await this.appSessionService.createSession(ownerId, ip);

    return { sessionToken, isFirstLogin };
  }

  /**
   * Is sign-in allowed to attach to an existing household?
   *
   * On by default: without it, linking a second school is a trap -- the parent
   * can add it, but signing back in with its password drops them into an empty
   * app. The switch exists so the behaviour can be turned off in one env var
   * if adoption ever proves to be the wrong call, not as an opt-in.
   */
  private adoptionEnabled(): boolean {
    return householdAdoptionEnabled();
  }

  /**
   * Follow a merge pointer exactly one hop.
   *
   * A cycle -- including a self-pointer -- would hang the login, and a chain
   * long enough to matter means the data is already wrong. Bailing to the
   * original is the safe answer: it is the household whose password was just
   * proven.
   */
  private async resolveMergedOwner(
    appUserId: string,
    mergedIntoUserId: string | null,
  ): Promise<string> {
    if (!mergedIntoUserId || mergedIntoUserId === appUserId) return appUserId;

    const target = await this.prisma.appUser.findUnique({
      where: { id: mergedIntoUserId },
      select: { id: true, mergedIntoUserId: true },
    });

    if (!target) {
      this.logger.warn(
        `AppUser ${appUserId} points at merged household ${mergedIntoUserId}, which does not exist; keeping its own`,
      );
      return appUserId;
    }

    // One hop only. A pointer that itself points on is a chain we refuse to
    // walk rather than risk looping.
    if (target.mergedIntoUserId && target.mergedIntoUserId !== target.id) {
      this.logger.warn(
        `Merge chain from ${appUserId} via ${mergedIntoUserId} goes further; stopping at the first hop`,
      );
    }

    return target.id;
  }

  /**
   * The children from a login response, stamped with the connection that
   * fetched them.
   *
   * Shared by the normal path and by adoption, so the two cannot drift about
   * what a login persists.
   */
  private async persistLoginRoster(
    loginData: MashovLoginResponse,
    connectionId: string,
  ): Promise<void> {
    const children = loginData.accessToken?.children ?? [];
    for (const child of children) {
      const fields = {
        privateName: child.privateName,
        familyName: child.familyName,
        fullName: `${child.privateName} ${child.familyName}`,
        classCode: child.classCode,
        classNum: child.classNum,
        gender: child.gender,
        groupsRaw: child.groups as unknown as import('@prisma/client').Prisma.InputJsonValue,
        isActive: true,
        lastSeenInRosterAt: new Date(),
        rawPayload: child as unknown as import('@prisma/client').Prisma.InputJsonValue,
        householdConnectionId: connectionId,
      };

      await this.prisma.student.upsert({
        where: { studentGuid: child.childGuid },
        create: { studentGuid: child.childGuid, ...fields },
        update: fields,
      });
    }

    // The visibility edge (ADR-0031): the stamp above routes upstream calls,
    // this grants the connection a view. It must be a set, because two parents
    // with their own accounts at one school list the same children and a lone
    // stamp made the second to sign in evict the first.
    await linkStudentsToConnection(
      this.prisma,
      connectionId,
      children
        .map((child) => child.childGuid)
        .filter((guid): guid is string => typeof guid === 'string' && guid.length > 0),
    );

    const inactiveGuids = this.parseInactiveChildGuids(
      loginData.accessToken?.inactiveChildren,
    );
    if (inactiveGuids.length > 0) {
      await this.prisma.student.updateMany({
        where: {
          studentGuid: { in: inactiveGuids },
          // Scoped like persistRoster's equivalent sweep: `inactiveChildren`
          // is school-local, so one school must not be able to retire a child
          // it does not list. Since ADR-0031 that is the link rather than the
          // routing stamp -- a child two parents share carries only one stamp.
          ...connectionStudentWhere(connectionId),
        },
        data: { isActive: false },
      });
    }
  }

  /**
   * One `POST /api/login`. Separated out because the year reconciliation may
   * need to run it twice, and both attempts share the same error handling.
   */
  private async postLogin(
    semel: number,
    year: number,
    username: string,
    password: string,
    storedUniqueId: string | null,
  ): Promise<{ data: MashovLoginResponse; newUniqueId: string | undefined }> {
    const csrfToken = '9c690c16-d0c8-ed43-9314-d622077e2e26';

    const loginBody = {
      semel,
      year,
      username,
      password,
      IsBiometric: false,
      appName: 'info.mashov.students',
      apiVersion: '3.20210425',
      appVersion: 3.20210425,
      appBuild: 3.20210425,
      deviceUuid: 'chrome',
      devicePlatform: 'chrome',
      deviceManufacturer: 'mac',
      deviceModel: 'desktop',
      deviceVersion: '145.0.0.0',
    };

    const extraHeaders: Record<string, string> = {};
    if (storedUniqueId) {
      extraHeaders['Cookie'] = `uniquId=${storedUniqueId}`;
    }

    const response = await this.http.post<MashovLoginResponse>('/api/login', loginBody, {
      headers: {
        'X-Csrf-Token': csrfToken,
        'Content-Type': 'application/json',
        Referer: `${this.mashovBaseUrl}/students/login`,
        ...extraHeaders,
      },
    });

    let newUniqueId: string | undefined;
    const setCookie = response.headers?.['set-cookie'];
    if (setCookie) {
      const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
      for (const c of cookieList) {
        const nameValue = c.split(';')[0] ?? '';
        const eqIdx = nameValue.indexOf('=');
        if (eqIdx !== -1 && nameValue.substring(0, eqIdx).trim() === 'uniquId') {
          newUniqueId = nameValue.substring(eqIdx + 1).trim();
          break;
        }
      }
    }

    return { data: response.data, newUniqueId };
  }

  /** `inactiveChildren` is undocumented; accept every plausible element shape. */
  private parseInactiveChildGuids(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const guid = record.childGuid ?? record.guid ?? record.studentGuid;
          return typeof guid === 'string' ? guid : null;
        }
        return null;
      })
      .filter((guid): guid is string => Boolean(guid));
  }

  async getMe(userId: string): Promise<{
    mashovUserId: string;
    username: string;
    displayName: string;
    schools: MeSchool[];
  }> {
    const appUser = await this.prisma.appUser.findUnique({
      where: { id: userId },
    });

    if (!appUser) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'User not found', details: [] },
      });
    }

    // Every school, newest sign-in first. `['me']` is already fetched in the
    // app shell, so this is the cheap read every page's school badge needs --
    // GET /school-links carries only the management-only fields on top.
    const schools = await this.schoolLinksService.listMeSchools(userId);

    // `connectedSchool` used to ride along here as `schools[0]` under a
    // singular name. Deleted in T14: a household with two schools has no
    // primary one, so there was no query that could have made it honest.
    return {
      mashovUserId: appUser.mashovUserId,
      username: appUser.username,
      displayName: appUser.displayName,
      schools,
    };
  }
}
