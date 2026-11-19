import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EncryptionService } from '../session/encryption.service';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { SyncService } from '../sync/sync.service';
import { ConnectionService } from '../connection/connection.service';
import { MashovCredentialValidatorService } from '../common/mashov-login/mashov-credential-validator.service';
import { resolveSchoolLabels } from '../common/school-label';
import {
  connectionStudentWhere,
  linkStudentsToConnection,
} from '../common/student-links';

/**
 * How many schools one household may connect.
 *
 * Every per-student sync task fans out across active connections, so this
 * bounds the upstream call volume against an API that rate-limits. Four is
 * well past any real family and still a bound.
 */
export const MAX_ACTIVE_LINKS = 4;

const LINK_RATE_LIMIT_MAX = 5;
const LINK_RATE_LIMIT_WINDOW_SECONDS = 900; // 15 minutes

/**
 * One connected Mashov account, as the management screen needs it.
 *
 * Never carries the password, in any form. `username` is shown because a
 * parent with two accounts needs to tell them apart; the encrypted password
 * exists only in `household_connection`.
 */
export interface SchoolLink {
  id: string;
  semel: number;
  schoolName: string;
  shortLabel: string;
  schoolYear: number;
  username: string;
  childrenCount: number;
  isPrimary: boolean;
  lastLoginAt: string | null;
  /** `null` means the first sync has not finished -- the UI says so. */
  lastSyncAt: string | null;
  active: boolean;
}

/** The slice of a link `GET /auth/me` carries, for every page's badges. */
export interface MeSchool {
  id: string;
  semel: number;
  schoolName: string;
  shortLabel: string;
  schoolYear: number;
}

@Injectable()
export class SchoolLinksService {
  private readonly logger = new Logger(SchoolLinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
    private readonly schoolYearService: SchoolYearService,
    private readonly validator: MashovCredentialValidatorService,
    private readonly syncService: SyncService,
    private readonly connectionService: ConnectionService,
  ) {}

  /**
   * Link another Mashov account to this household.
   *
   * Does NOT wait for a sync. The roster arrives in the login response, so the
   * children are persisted here and the connection is immediately usable; the
   * rest of the data takes minutes, and holding an HTTP request open for it
   * would time out at the proxy and tell the parent it failed.
   */
  async createLink(
    userId: string,
    input: { semel: number; username: string; password: string },
  ): Promise<SchoolLink> {
    const semel = Number(input.semel);

    // Checked before reaching upstream: no point spending a Mashov login, or
    // a rate-limit slot, on a school that cannot be added. Split in two
    // because only the first half is free: it reads this household's own rows
    // and so costs nothing to refuse, while the foreign-owner check queries
    // across every household and must stay behind the limit.
    await this.assertLinkableFromOwnLinks(userId, semel, input.username);

    await this.checkRateLimit(userId);

    await this.assertNoForeignOwner(userId, semel, input.username);

    // This school's year is resolved independently. It can legitimately differ
    // from the household's other school -- that is the whole reason the year
    // is per connection.
    const candidate = (await this.schoolYearService.resolveForSchool(semel)).year;

    let year = candidate;
    let login = await this.validator.validate({
      semel,
      year,
      username: input.username,
      password: input.password,
    });

    // Mashov is the authority on which year is active, and its cookies are
    // year-scoped, so a corrected year needs a fresh login. Capped at one
    // retry, exactly as sign-in does it.
    const reconciled = this.schoolYearService.reconcileFromLogin(year, login.data);
    if (reconciled.changed) {
      this.logger.warn(
        `Mashov reports active year=${reconciled.year} for semel=${semel} (sent ${year}); re-logging in`,
      );
      this.schoolYearService.invalidate(semel);
      try {
        login = await this.validator.validate({
          semel,
          year: reconciled.year,
          username: input.username,
          password: input.password,
        });
        year = reconciled.year;
      } catch (retryErr) {
        // The first login already succeeded, so the credentials are good.
        // Reporting this as INVALID_CREDENTIALS would send the parent off to
        // retype a password that was correct.
        this.logger.error(
          `Re-login at year=${reconciled.year} failed for semel=${semel}; keeping year ${year}: ${
            retryErr instanceof Error ? retryErr.message : 'unknown error'
          }`,
        );
      }
    }

    const children = login.data.accessToken?.children ?? [];

    // Refused BEFORE anything is persisted. A childless connection shows up as
    // a school with no children and a filter chip that matches nothing, which
    // a parent cannot diagnose and cannot act on.
    if (children.length === 0) {
      const inactiveCount = Array.isArray(login.data.accessToken?.inactiveChildren)
        ? login.data.accessToken.inactiveChildren.length
        : 0;
      if (inactiveCount > 0) {
        throw new UnprocessableEntityException({
          error: {
            code: 'NO_ACTIVE_CHILDREN',
            message: 'Every child in this account is inactive at the school',
            details: [],
          },
        });
      }
      throw new UnprocessableEntityException({
        error: {
          code: 'NO_CHILDREN_FOUND',
          message: 'No children found in this account',
          details: [],
        },
      });
    }

    const connectionId = await this.persistLink({
      userId,
      semel,
      year,
      username: input.username,
      password: input.password,
      login,
    });

    // Fired, not awaited. The response returns as soon as the children exist;
    // the frontend then watches /sync/status for this school.
    void this.syncService
      .refreshAll({ connectionId })
      .catch((error: unknown) =>
        this.logger.error(
          `Background refresh for new connection ${connectionId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );

    const links = await this.listLinks(userId);
    const created = links.find((link) => link.id === connectionId);
    if (!created) {
      throw new Error(`Link ${connectionId} vanished immediately after being created`);
    }
    return created;
  }

  /**
   * Re-validate and store new credentials for one school.
   *
   * Delegates to ConnectionService, which already owned this logic and its
   * UPSTREAM_ERROR / INVALID_CREDENTIALS split.
   */
  async updateLink(
    userId: string,
    connectionId: string,
    body: { username?: string; password?: string },
  ): Promise<SchoolLink> {
    await this.assertOwned(userId, connectionId);
    await this.connectionService.updateConnection(
      userId,
      body.username,
      body.password,
      connectionId,
    );

    const links = await this.listLinks(userId);
    const updated = links.find((link) => link.id === connectionId);
    if (!updated) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: 'No such school is connected to this account',
          details: [],
        },
      });
    }
    return updated;
  }

  /** Unlink one school, or every school. */
  async deleteLink(userId: string, connectionId?: string): Promise<void> {
    if (connectionId) await this.assertOwned(userId, connectionId);
    await this.connectionService.deleteConnection(userId, connectionId);
  }

  /**
   * 404 for a school this household does not have.
   *
   * 404 rather than 403: a 403 would confirm the id names a real connection,
   * which is exactly what a stranger holding an id must not learn.
   */
  private async assertOwned(userId: string, connectionId: string): Promise<void> {
    const owned = await this.prisma.householdConnection.findFirst({
      where: { id: connectionId, userId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: 'No such school is connected to this account',
          details: [],
        },
      });
    }
  }

  /**
   * Why a school might not be addable, judged from the caller's OWN links.
   *
   * CONNECTION_ALREADY_LINKED is the same account twice. SCHOOL_ALREADY_LINKED
   * is a second account at a school the household already has -- the schema
   * permits it, but it would duplicate every child and break the
   * one-chip-per-school model, so it is refused rather than half-supported.
   *
   * Separate from `assertNoForeignOwner` so the call site can run this one
   * before the rate limit: every refusal here is decided from rows the caller
   * already owns, which tells them nothing they did not know and costs no
   * upstream call.
   */
  private async assertLinkableFromOwnLinks(
    userId: string,
    semel: number,
    username: string,
  ): Promise<void> {
    const existing = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      select: { id: true, schoolCode: true, username: true },
    });

    if (existing.some((row) => row.schoolCode === semel && row.username === username)) {
      throw new ConflictException({
        error: {
          code: 'CONNECTION_ALREADY_LINKED',
          message: 'This account is already linked',
          details: [],
        },
      });
    }

    if (existing.some((row) => row.schoolCode === semel)) {
      throw new ConflictException({
        error: {
          code: 'SCHOOL_ALREADY_LINKED',
          message: 'This school is already linked to the account',
          details: [],
        },
      });
    }

    if (existing.length >= MAX_ACTIVE_LINKS) {
      throw new ConflictException({
        error: {
          code: 'LIMIT_REACHED',
          message: `At most ${MAX_ACTIVE_LINKS} schools can be linked`,
          details: [],
        },
      });
    }
  }

  /**
   * Refuse an account another household already owns.
   *
   * Behind the rate limit on purpose, unlike the checks above: this lookup is
   * an existence oracle on `(schoolCode, username)` across every household on
   * the deployment, so an authenticated caller who could probe it without
   * bound could enumerate parent usernames school by school.
   */
  private async assertNoForeignOwner(
    userId: string,
    semel: number,
    username: string,
  ): Promise<void> {
    // A connection that exists but belongs to nobody -- unlinked earlier, or
    // created by a first sign-in that was never adopted -- is re-parented
    // rather than refused, which is what makes unlink-then-relink work.
    const orphan = await this.prisma.householdConnection.findUnique({
      where: { schoolCode_username: { schoolCode: semel, username } },
      select: { userId: true },
    });
    if (orphan?.userId && orphan.userId !== userId) {
      throw new ConflictException({
        error: {
          code: 'CONNECTION_ALREADY_LINKED',
          message: 'This account is already linked',
          details: [],
        },
      });
    }
  }

  /**
   * The connection row and its children, in the same shape sign-in writes.
   *
   * One upsert on (schoolCode, username) -- the identity key -- so an orphaned
   * row from an earlier unlink is adopted rather than duplicated.
   */
  private async persistLink(args: {
    userId: string;
    semel: number;
    year: number;
    username: string;
    password: string;
    login: { data: MashovLoginPayloadLike; newUniqueId: string | undefined };
  }): Promise<string> {
    const { userId, semel, year, username, password, login } = args;
    const schoolSettings = login.data.accessToken?.schoolSettings;
    const enrolledYears = login.data.accessToken?.userSchoolYears;

    const connection = await this.prisma.householdConnection.upsert({
      where: { schoolCode_username: { schoolCode: semel, username } },
      create: {
        schoolCode: semel,
        schoolYear: year,
        username,
        encryptedPassword: this.encryption.encrypt(password),
        schoolName: schoolSettings?.schoolName,
        upstreamUserId: login.data.credential?.userId,
        lastLoginAt: new Date(),
        active: true,
        userId,
        linkedByUserId: userId,
        linkedAt: new Date(),
        ...(login.newUniqueId ? { mashovUniqueId: login.newUniqueId } : {}),
        ...(enrolledYears ? { schoolYears: enrolledYears } : {}),
      },
      update: {
        schoolYear: year,
        encryptedPassword: this.encryption.encrypt(password),
        schoolName: schoolSettings?.schoolName,
        upstreamUserId: login.data.credential?.userId,
        lastLoginAt: new Date(),
        active: true,
        userId,
        linkedByUserId: userId,
        linkedAt: new Date(),
        ...(login.newUniqueId ? { mashovUniqueId: login.newUniqueId } : {}),
        ...(enrolledYears ? { schoolYears: enrolledYears } : {}),
      },
    });

    const children = login.data.accessToken?.children ?? [];
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
        householdConnectionId: connection.id,
      };

      await this.prisma.student.upsert({
        where: { studentGuid: child.childGuid },
        create: { studentGuid: child.childGuid, ...fields },
        update: fields,
      });
    }

    // The visibility edge (ADR-0031). A child the other parent's connection
    // already lists gains a SECOND link here rather than having its stamp
    // taken over, which is what made linking evict the other parent's view.
    await linkStudentsToConnection(
      this.prisma,
      connection.id,
      children
        .map((child) => child.childGuid)
        .filter((guid): guid is string => typeof guid === 'string' && guid.length > 0),
    );

    const inactiveGuids = parseInactiveChildGuids(login.data.accessToken?.inactiveChildren);
    if (inactiveGuids.length > 0) {
      await this.prisma.student.updateMany({
        where: {
          studentGuid: { in: inactiveGuids },
          // The children this school lists, or unlinked ones. A school must
          // not be able to retire a child it does not list.
          ...connectionStudentWhere(connection.id),
        },
        data: { isActive: false },
      });
    }

    return connection.id;
  }

  /**
   * Rate limit, per user rather than per IP.
   *
   * This endpoint brute-forces upstream Mashov credentials from inside an
   * authenticated session, which is a capability sign-in's IP limit does not
   * cover. Same shape as AuthService.checkRateLimit.
   */
  private async checkRateLimit(userId: string): Promise<void> {
    const key = `ratelimit:school-link:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, LINK_RATE_LIMIT_WINDOW_SECONDS);
    }
    if (count > LINK_RATE_LIMIT_MAX) {
      // 429, not 409. The frontend maps the `code`, so the Hebrew message is
      // unaffected -- but a throttle is not a conflict to anything keying off
      // the status, a proxy retry policy included. `AuthService` reaches the
      // same status via a bare Error its controller re-wraps; done here
      // instead, so the envelope the frontend keys on travels with it.
      throw new HttpException(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many attempts. Please try again in fifteen minutes.',
            details: [],
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Every school a household has connected, newest sign-in first.
   *
   * One method feeds both `GET /school-links` and `me.schools`: the badges on
   * every page need the cheap slice, the management screen needs the counts
   * and timestamps, and two implementations of "which schools are these"
   * would drift.
   */
  async listLinks(userId: string): Promise<SchoolLink[]> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      orderBy: [{ lastLoginAt: 'desc' }, { createdAt: 'asc' }],
    });

    if (connections.length === 0) return [];

    const labels = resolveSchoolLabels(connections);

    // Counted per connection in one grouped query rather than one per row,
    // over the visibility edge: "how many children does this school list for
    // me". The routing stamp would undercount a child the other parent's
    // connection happens to hold (ADR-0031).
    const counts = await this.prisma.studentConnection.groupBy({
      by: ['householdConnectionId'],
      where: {
        householdConnectionId: { in: connections.map((connection) => connection.id) },
        student: { isActive: true },
      },
      _count: { _all: true },
    });
    const countByConnection = new Map(
      counts.map((row) => [row.householdConnectionId, row._count._all]),
    );

    // `lastSyncAt` is the newest SUCCESSFUL run for that connection. A failed
    // run must not read as a finished sync: the UI shows "מסנכרן נתונים…"
    // while this is null, and a parent watching a school that cannot sync
    // should keep seeing that rather than a reassuring timestamp.
    const lastRuns = await this.prisma.syncRun.groupBy({
      by: ['householdConnectionId'],
      where: {
        status: 'success',
        householdConnectionId: { in: connections.map((connection) => connection.id) },
      },
      _max: { endedAt: true },
    });
    const lastSyncByConnection = new Map(
      lastRuns.map((row) => [row.householdConnectionId, row._max.endedAt]),
    );

    return connections.map((connection, index) => ({
      id: connection.id,
      semel: connection.schoolCode,
      schoolName: connection.schoolName ?? String(connection.schoolCode),
      shortLabel: labels.get(connection.id) ?? String(connection.schoolCode),
      schoolYear: connection.schoolYear,
      username: connection.username,
      childrenCount: countByConnection.get(connection.id) ?? 0,
      // The most recently used school. It is a display hint only -- nothing
      // reads it for scoping, and the deprecated `connectedSchool` is built
      // from the same first element.
      isPrimary: index === 0,
      lastLoginAt: connection.lastLoginAt?.toISOString() ?? null,
      lastSyncAt: lastSyncByConnection.get(connection.id)?.toISOString() ?? null,
      active: connection.active,
    }));
  }

  /** The same list, reduced to what a badge needs. */
  async listMeSchools(userId: string): Promise<MeSchool[]> {
    const links = await this.listLinks(userId);
    return links.map((link) => ({
      id: link.id,
      semel: link.semel,
      schoolName: link.schoolName,
      shortLabel: link.shortLabel,
      schoolYear: link.schoolYear,
    }));
  }
}

/** The slice of a login payload persisting a link needs. */
interface MashovLoginPayloadLike {
  credential?: { userId?: string };
  accessToken?: {
    schoolSettings?: { schoolName?: string };
    children?: Array<{
      childGuid: string;
      familyName: string;
      privateName: string;
      classCode: string;
      classNum: number;
      gender: string;
      groups: number[];
    }>;
    inactiveChildren?: unknown[];
    userSchoolYears?: number[];
  };
}

/** `inactiveChildren` is undocumented; accept every plausible element shape. */
function parseInactiveChildGuids(value: unknown): string[] {
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
