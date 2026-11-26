import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosInstance, AxiosResponse } from "axios";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "./encryption.service";
import {
  createMashovAxios,
  resolveMashovBaseUrl,
} from "../common/http/mashov-http";
import { SchoolYearService } from "../common/school-year/school-year.service";
import {
  connectionStudentWhere,
  linkStudentsToConnection,
} from '../common/student-links';
import { MASHOV_CSRF_TOKEN } from '../common/mashov-login/mashov-login-body';
import { readResponseHeader } from '../common/mashov-login/mashov-login-headers';

interface LoginChild {
  childGuid: string;
  familyName: string;
  privateName: string;
  classCode: string;
  classNum: number;
  gender: string;
  groups: number[];
}

interface LoginResponse {
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
    children: LoginChild[];
    /** Children no longer enrolled. Element shape is undocumented. */
    inactiveChildren?: unknown[];
    userSchoolYears?: number[];
    username: string;
  };
}

export interface RosterResult {
  created: number;
  updated: number;
  deactivated: number;
}

export interface RosterRefreshResult extends RosterResult {
  year: number;
}

/**
 * How long a successful `students` sync keeps the self-heal path quiet. The
 * signal is the `syncRun` table — the same one freshness already reads — so no
 * new column is needed.
 *
 * 24 hours, not the hour it used to be. This runs on the REQUEST path, off
 * `/children` and `/dashboard`, and with the `students` cron deleted it would
 * otherwise be the de-facto roster scheduler: a full upstream login per
 * household per hour of browsing, which is the opposite of the point. The
 * roster changes about once a year, it is refreshed by the `login` set on every
 * sign-in, and `NotificationWindowTask` refreshes it daily for households that
 * opted into notifications. This is the backstop behind all three — it exists
 * because a stale roster once left children on last year's class for five
 * months, and matches the `students` policy TTL in `source-policy.ts`.
 */
export const ROSTER_TTL_MINUTES = 24 * 60;

const STUDENTS_SOURCE = 'students';

interface SessionCookies {
  csrfToken: string;
  mashovAuthToken: string;
  uniquId: string;
}

interface ConnectionLogin {
  cookies: SessionCookies;
  loginData: LoginResponse;
  roster: RosterResult;
}

interface ConnectionSession {
  csrfToken: string;
  cookies: SessionCookies;
  authPromise: Promise<ConnectionLogin> | null;
  isAuthenticating: boolean;
}

@Injectable()
export class MashovSessionService {
  private readonly logger = new Logger(MashovSessionService.name);
  private readonly baseUrl: string;
  private readonly httpClient: AxiosInstance;
  /**
   * Per-connection session cache keyed by `connectionId:year`.
   *
   * The year is part of the key because Mashov scopes a whole session to the
   * year in the login body. Keyed on the connection alone, a caller asking for
   * one year is handed another caller's cookies and reads that year's data
   * while stamping its own — and the wrong-year response is a valid 200, so
   * neither the 401/403 retry nor any error path can notice.
   */
  private readonly connectionSessions = new Map<string, ConnectionSession>();
  /** Last roster counts per `connectionId:year`, written by every login. */
  private readonly lastRosterByConnection = new Map<string, RosterResult>();
  /** Last login payload per `connectionId:year`, for year reconciliation. */
  private readonly lastLoginByConnection = new Map<string, LoginResponse>();
  /**
   * Dedupes concurrent self-heal refreshes. Without it a page-load storm fires
   * one upstream login per request.
   */
  private readonly inFlightRosterRefresh = new Map<string, Promise<void>>();
  /** `inactiveChildren` is undocumented; log one raw sample, once. */
  private hasLoggedInactiveChildrenShape = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly schoolYearService: SchoolYearService,
  ) {
    this.baseUrl = resolveMashovBaseUrl(
      this.configService.get<string>("MASHOV_BASE_URL"),
    );
    this.httpClient = createMashovAxios(this.baseUrl);
  }

  // async bootstrap(): Promise<string> {
  //   this.logger.debug("Bootstrapping CSRF token from login page");
  //   const response = await this.httpClient.get("/students/login", {
  //     maxRedirects: 5,
  //   });

  //   const csrfHeader = response.headers["x-csrf-token"] as string | undefined;
  //   const csrfToken = csrfHeader ?? randomUUID();

  //   if (!csrfHeader) {
  //     this.logger.warn(
  //       "X-Csrf-Token not found on /students/login, using generated token",
  //     );
  //   }

  //   this.csrfToken = csrfToken;
  //   this.logger.debug("CSRF token acquired successfully");
  //   return csrfToken;
  // }

  /**
   * Keeps the roster from going stale. The old version short-circuited on
   * `activeStudents > 0`, so it only ever fired when the `student` table was
   * completely empty — which is why `classCode`/`classNum` stayed on last
   * year's class for five months while every cron reported success.
   */
  async ensureStudentsAvailable(userId?: string): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      return;
    }

    // The connection is resolved BEFORE the TTL probe so the probe can be
    // scoped to it. A global probe let one household's successful roster sync
    // suppress another household's self-heal indefinitely — the same gating
    // failure the `activeStudents > 0` short-circuit used to cause.
    const connection = await this.prisma.householdConnection.findFirst({
      where: { active: true, ...(userId ? { userId } : {}) },
      orderBy: { lastLoginAt: "desc" },
    });

    // No connection, nothing to refresh as. This used to fall back to the
    // shared env account, which is gone.
    //
    // A no-op rather than a throw: both callers are page reads
    // (`ChildrenService.getChildren`, `DashboardService.getDashboard`) and a
    // user mid-setup, or one whose only connection was just deactivated, would
    // get a 500 dashboard instead of an empty one.
    //
    // Returns BEFORE the TTL probe, and deliberately records no `syncRun`. The
    // run below exists to stop a *failing upstream refresh* from re-firing on
    // every request; here there is no upstream call to amplify. Recording one
    // would also write an owner-less `students` row, which the branch-wide
    // NULL rule then admits into every connection's snapshot -- satisfying the
    // gate on behalf of connections that do not exist.
    if (!connection) {
      this.logger.debug(
        `No active household connection for ${userId ?? "this request"}; skipping roster refresh`,
      );
      return;
    }

    const lastRun = await this.prisma.syncRun.findFirst({
      where: {
        source: STUDENTS_SOURCE,
        status: "success",
        householdConnectionId: connection.id,
      },
      orderBy: { endedAt: "desc" },
      select: { endedAt: true },
    });

    if (
      lastRun?.endedAt &&
      Date.now() - new Date(lastRun.endedAt).getTime() <
        ROSTER_TTL_MINUTES * 60 * 1000
    ) {
      return;
    }

    const dedupeKey = connection.id;
    const existing = this.inFlightRosterRefresh.get(dedupeKey);
    if (existing) {
      return existing;
    }

    // The TTL gate above reads `syncRun` rows under `students`, but this path
    // is not `StudentsTask` and so opened none of its own. Without recording
    // one, a failing roster cron leaves the gate permanently unsatisfied and
    // every request that reaches here performs a full upstream login — an
    // unbounded login amplifier on the request path.
    const startedAt = new Date();
    const refresh = this.refreshRosterForConnection(connection.id)
      .then(() => this.recordRosterRun(connection.id, startedAt, null))
      .catch(async (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to refresh student roster: ${msg}`);
        await this.recordRosterRun(connection.id, startedAt, msg);
      })
      .finally(() => {
        this.inFlightRosterRefresh.delete(dedupeKey);
      });

    this.inFlightRosterRefresh.set(dedupeKey, refresh);
    return refresh;
  }

  /**
   * Records the self-heal roster refresh as a `students` sync run. Written
   * with Prisma directly rather than through `SyncRunService`, which lives in
   * `SyncModule` — and `SyncModule` already imports this one, so injecting it
   * would close an import cycle.
   */
  private async recordRosterRun(
    connectionId: string,
    startedAt: Date,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await this.prisma.syncRun.create({
        data: {
          source: STUDENTS_SOURCE,
          status: errorMessage ? "failed" : "success",
          startedAt,
          endedAt: new Date(),
          errorMessage,
          householdConnectionId: connectionId,
        },
      });
    } catch (error) {
      // Bookkeeping must never fail the self-heal it is recording.
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not record the students sync run: ${msg}`);
    }
  }

  /**
   * Force-relogins a connection and re-reads `accessToken.children[]`. This is
   * the only place the roster can change: children exist nowhere else in the
   * Mashov API, so without a re-login a child who moves up a grade keeps last
   * year's `classCode` forever.
   */
  async refreshRosterForConnection(
    connectionId: string,
    yearOverride?: number,
  ): Promise<RosterRefreshResult> {
    const connection = await this.prisma.householdConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new Error(`Household connection not found: ${connectionId}`);
    }

    const password = this.encryptionService.decrypt(connection.encryptedPassword);
    const attemptedYear = yearOverride ?? connection.schoolYear;

    await this.getAuthHeadersForConnection(
      connection.id,
      connection.schoolCode,
      attemptedYear,
      connection.username,
      password,
      true,
    );

    const attemptedKey = this.sessionKey(connection.id, attemptedYear);
    const login = this.lastLoginByConnection.get(attemptedKey);
    const roster =
      this.lastRosterByConnection.get(attemptedKey) ??
      { created: 0, updated: 0, deactivated: 0 };

    // Mashov is the authority on which year is active, on THIS path too — not
    // only on interactive sign-in. Without the write-back, a rollover that
    // advanced a connection on the calendar alone would be re-applied by the
    // next daily cron even after Mashov said otherwise, and the family's data
    // would flip-flop every morning until the year actually opened.
    let year = attemptedYear;
    if (login) {
      const reconciled = this.schoolYearService.reconcileFromLogin(attemptedYear, login);
      if (reconciled.year !== connection.schoolYear) {
        this.logger.warn(
          `Mashov reports active year=${reconciled.year} for connection ${connection.id} (asked for ${attemptedYear}, stored ${connection.schoolYear}); persisting it`,
        );
        await this.prisma.householdConnection.update({
          where: { id: connection.id },
          data: { schoolYear: reconciled.year },
        });
      }
      year = reconciled.year;

      // The cached cookies are scoped to the year we asked for, so a corrected
      // year needs a fresh session or every later GET reads the wrong year.
      if (reconciled.year !== attemptedYear) {
        this.schoolYearService.invalidate(connection.schoolCode);
        // forceRefresh below only evicts the corrected year's key, so the
        // superseded year's cookies have to go explicitly. Leaving them would
        // let a later caller asking for the year Mashov rejected be served a
        // session it already said was wrong.
        this.connectionSessions.delete(attemptedKey);
        this.lastLoginByConnection.delete(attemptedKey);
        this.lastRosterByConnection.delete(attemptedKey);
        await this.getAuthHeadersForConnection(
          connection.id,
          connection.schoolCode,
          reconciled.year,
          connection.username,
          password,
          true,
        );
      }
    }

    return { ...roster, year };
  }

  /**
   * Upserts `accessToken.children[]` and deactivates `inactiveChildren`.
   *
   * Deliberately does NOT deactivate the complement (students in neither
   * list): `Student` has no FK to a connection, so the complement includes
   * other households' children.
   */
  async persistRoster(
    data: LoginResponse,
    semel: number,
    year: number,
    /**
     * The connection whose login produced this roster, or `null` for the
     * shared env-credential session, which has no connection to attribute
     * children to.
     *
     * `null` means "leave the column alone", never "write null": blanking an
     * existing stamp would un-own every child on the next boot, and
     * MailInboxTask refuses to reconcile while any row is unstamped.
     */
    connectionId: string | null = null,
  ): Promise<RosterResult> {
    const children = data.accessToken?.children ?? [];
    const guids = children
      .map((child) => this.readChildGuid(child))
      .filter((guid): guid is string => Boolean(guid));

    const existing =
      guids.length > 0
        ? await this.prisma.student.findMany({
            where: { studentGuid: { in: guids } },
            select: { studentGuid: true, householdConnectionId: true },
          })
        : [];
    const existingGuids = new Set(existing.map((row) => row.studentGuid));
    const ownerByGuid = new Map(
      existing.map((row) => [row.studentGuid, row.householdConnectionId]),
    );

    let created = 0;
    let updated = 0;

    for (const child of children) {
      const studentGuid = this.readChildGuid(child);
      if (!studentGuid) {
        this.logger.warn(
          `Skipping a child with no recognisable guid in the login payload for semel=${semel}`,
        );
        continue;
      }

      // A child who turns up under a different connection has moved school.
      // The stamp has to follow them or every per-student cron keeps asking
      // the old school and collecting a 403 every twelve minutes -- and this
      // log line is the only trace of the move anywhere, since `Student`
      // records no history.
      const previousOwner = ownerByGuid.get(studentGuid) ?? null;
      if (connectionId && previousOwner && previousOwner !== connectionId) {
        this.logger.warn(
          `Child ${studentGuid} moved from connection ${previousOwner} to ${connectionId}; re-stamping ownership`,
        );
      }

      const fields = {
        privateName: child.privateName,
        familyName: child.familyName,
        fullName: `${child.privateName} ${child.familyName}`,
        classCode: child.classCode,
        classNum: child.classNum,
        gender: child.gender,
        groupsRaw:
          child.groups as unknown as import("@prisma/client").Prisma.InputJsonValue,
        isActive: true,
        lastSeenInRosterAt: new Date(),
        rawPayload:
          child as unknown as import("@prisma/client").Prisma.InputJsonValue,
        ...(connectionId ? { householdConnectionId: connectionId } : {}),
      };

      await this.prisma.student.upsert({
        where: { studentGuid },
        create: { studentGuid, ...fields },
        update: fields,
      });

      if (existingGuids.has(studentGuid)) {
        updated += 1;
      } else {
        created += 1;
      }
    }

    // The visibility edge (ADR-0031). The stamp above says which connection to
    // ASK for this child; this says who may SEE them, and it has to be a set:
    // two parents with their own Mashov accounts at one school list the same
    // children, and a single stamp meant whichever synced second took them
    // away from the other until the next cycle flipped it back.
    //
    // Only for a real connection. The shared env-credential session has nobody
    // to grant a view to.
    if (connectionId) {
      await linkStudentsToConnection(this.prisma, connectionId, guids);
    }

    const inactiveGuids = this.parseInactiveChildGuids(
      data.accessToken?.inactiveChildren,
    );
    let deactivated = 0;
    if (inactiveGuids.length > 0) {
      const result = await this.prisma.student.updateMany({
        where: {
          studentGuid: { in: inactiveGuids },
          // Scoped to this connection's own children, plus not-yet-stamped
          // ones. `inactiveChildren` is school-local, so one school must not
          // be able to deactivate a child it does not own. The shared
          // env-session path has no connection and stays unscoped, which is
          // the behaviour it has always had.
          ...(connectionId ? connectionStudentWhere(connectionId) : {}),
        },
        data: { isActive: false },
      });
      deactivated = result.count;
    }

    this.logger.debug(
      `Roster persisted for semel=${semel} year=${year}: created=${created} updated=${updated} deactivated=${deactivated}`,
    );

    return { created, updated, deactivated };
  }

  private readChildGuid(child: LoginChild): string | null {
    const record = child as unknown as Record<string, unknown>;
    const guid = record.childGuid ?? record.guid ?? record.studentGuid;
    return typeof guid === "string" && guid.length > 0 ? guid : null;
  }

  private parseInactiveChildGuids(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) return [];

    if (!this.hasLoggedInactiveChildrenShape) {
      this.hasLoggedInactiveChildrenShape = true;
      this.logger.log(
        `inactiveChildren raw sample: ${JSON.stringify(value[0])}`,
      );
    }

    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const guid = record.childGuid ?? record.guid ?? record.studentGuid;
          return typeof guid === "string" ? guid : null;
        }
        return null;
      })
      .filter((guid): guid is string => Boolean(guid));
  }

  /**
   * The years this household has records for, or null when the login did not
   * say. `apis/post-api-login.md` documents the field as always present, but
   * an empty or junk array is treated as "did not say" rather than "none".
   */
  private enrolledSchoolYears(data: LoginResponse): number[] | null {
    const raw = data.accessToken?.userSchoolYears;
    if (!Array.isArray(raw)) return null;
    const years = raw
      .map((entry) => Number(entry))
      .filter((year) => Number.isInteger(year) && year > 0);
    return years.length > 0 ? years : null;
  }

  /**
   * Authenticate with explicit credentials and return auth headers.
   * Results are cached in-memory per connectionId; on 401/403 the caller
   * should call this method again with forceRefresh=true.
   */
  async getAuthHeadersForConnection(
    connectionId: string,
    semel: number,
    year: number,
    username: string,
    password: string,
    forceRefresh = false,
  ): Promise<Record<string, string>> {
    const sessionKey = this.sessionKey(connectionId, year);

    if (forceRefresh) {
      this.connectionSessions.delete(sessionKey);
    }

    const cached = this.connectionSessions.get(sessionKey);
    if (cached && !cached.isAuthenticating) {
      return this.buildHeaders(cached.cookies, cached.csrfToken);
    }

    // If already authenticating, wait for the in-flight promise
    if (cached?.isAuthenticating && cached.authPromise) {
      const login = await cached.authPromise;
      return this.buildHeaders(login.cookies, login.cookies.csrfToken);
    }

    const placeholder: ConnectionSession = {
      csrfToken: '',
      cookies: { csrfToken: '', mashovAuthToken: '', uniquId: '' },
      isAuthenticating: true,
      authPromise: null,
    };
    this.connectionSessions.set(sessionKey, placeholder);

    const connRecord = await this.prisma.householdConnection.findUnique({
      where: { id: connectionId },
      select: { mashovUniqueId: true, schoolYear: true, devicePass: true },
    });
    const storedUniqueId = connRecord?.mashovUniqueId ?? undefined;

    // A login reaching BACKWARDS is a history backfill, and must not touch
    // anything that describes the present. Reaching forwards is the rollover
    // offering a candidate year, which does need the roster read at it.
    const isHistorical =
      connRecord?.schoolYear !== undefined && Number(year) < connRecord.schoolYear;

    const authPromise = this.establishConnectionLogin({
      semel,
      year,
      username,
      password,
      connectionId,
      storedUniqueId,
      isHistorical,
      storedDevicePass: connRecord?.devicePass ?? null,
    });
    placeholder.authPromise = authPromise;

    try {
      const { cookies } = await authPromise;
      const csrfToken = cookies.csrfToken;
      this.connectionSessions.set(sessionKey, {
        csrfToken,
        cookies,
        isAuthenticating: false,
        authPromise: null,
      });
      return this.buildHeaders(cookies, csrfToken);
    } catch (err) {
      this.connectionSessions.delete(sessionKey);
      throw err;
    }
  }

  /**
   * Forget everything cached for one connection.
   *
   * There was no eviction anywhere, so a deleted connection's upstream cookies
   * lived in this process until a restart -- and a parent who unlinked a
   * school and re-linked it would be served a session authenticated with
   * credentials that no longer existed in the database.
   *
   * Every cache here is keyed `connectionId:year`, so the prefix catches every
   * year the connection ever logged in at, including a history backfill's.
   */
  invalidateConnection(connectionId: string): void {
    const prefix = `${connectionId}:`;
    let evicted = 0;

    for (const map of [
      this.connectionSessions,
      this.lastRosterByConnection,
      this.lastLoginByConnection,
    ] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
          evicted += 1;
        }
      }
    }

    // Keyed on the bare connection id, not `connectionId:year`.
    this.inFlightRosterRefresh.delete(connectionId);

    this.logger.debug(
      `Evicted ${evicted} cached session entr${evicted === 1 ? 'y' : 'ies'} for connection ${connectionId}`,
    );
  }

  /** Cache key for everything a connection login produces: both ends matter. */
  private sessionKey(connectionId: string, year: number): string {
    return `${connectionId}:${Number(year)}`;
  }

  private buildHeaders(cookies: SessionCookies, csrfToken: string): Record<string, string> {
    const cookieString = [
      `Csrf-Token=${cookies.csrfToken}`,
      `MashovAuthToken=${cookies.mashovAuthToken}`,
      `uniquId=${cookies.uniquId}`,
    ].join('; ');
    return { 'X-Csrf-Token': csrfToken, Cookie: cookieString };
  }

  /**
   * One connection login, by whichever route works.
   *
   * Prefers Mashov's trusted-device re-login (`POST /api/loginDevice`, an empty
   * body plus a `devicePass` header) when we hold a `devicePass`, and falls
   * back to the password login otherwise or when it fails.
   *
   * That preference is the load-bearing half of MFA support: sixteen cron tasks
   * re-login here, and a password login against an MFA-protected account
   * re-opens the challenge every time. Without this path the parent signs in
   * once and then watches their data go stale overnight, with no error anyone
   * can see.
   *
   * A HISTORICAL login never takes it: `/api/loginDevice` carries no year at
   * all, so it would hand back the live session rather than the year the
   * backfill asked for.
   */
  private async establishConnectionLogin(input: {
    semel: number;
    year: number;
    username: string;
    password: string;
    connectionId?: string;
    storedUniqueId?: string;
    isHistorical: boolean;
    storedDevicePass: string | null;
  }): Promise<ConnectionLogin> {
    if (input.storedDevicePass && !input.isHistorical) {
      try {
        return await this.loginWithDevicePass(
          input.semel,
          input.year,
          input.username,
          input.storedDevicePass,
          input.connectionId,
          input.storedUniqueId,
        );
      } catch (err) {
        // A revoked or rotated-out devicePass must degrade to the route that
        // still works, not fail the sync task. Logged at warn because a
        // permanent failure here means every re-login pays a password login
        // and an MFA account will start re-challenging.
        this.logger.warn(
          `Trusted-device login failed for connection ${input.connectionId ?? '(none)'}; falling back to password login: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    }

    return this.loginWithCredentials(
      input.semel,
      input.year,
      input.username,
      input.password,
      input.connectionId,
      input.storedUniqueId,
      input.isHistorical,
    );
  }

  /**
   * `POST /api/loginDevice`: a session with no password and no MFA challenge.
   *
   * It takes no year, so it cannot be asked for one -- the session it returns is
   * whatever Mashov considers current. `finishConnectionLogin` therefore
   * persists the roster under the year the CALLER asked for, which
   * `reconcileFromLogin` corrects on the next pass if they disagree. Transient
   * and self-healing, and the password path has the same shape; it is why a
   * historical backfill is excluded from this route entirely (see
   * `establishConnectionLogin`), since there the mismatch would be permanent.
   */
  private async loginWithDevicePass(
    semel: number,
    year: number,
    username: string,
    encryptedDevicePass: string,
    connectionId?: string,
    storedUniqueId?: string,
  ): Promise<ConnectionLogin> {
    const devicePass = this.encryptionService.decrypt(encryptedDevicePass);

    const extraHeaders: Record<string, string> = { devicePass };
    if (storedUniqueId) {
      extraHeaders['Cookie'] = `uniquId=${storedUniqueId}`;
    }

    const response: AxiosResponse<LoginResponse> = await this.httpClient.post(
      '/api/loginDevice',
      {},
      { headers: { ...this.loginHeaders(), ...extraHeaders } },
    );

    return this.finishConnectionLogin(response, semel, year, username, connectionId, false);
  }

  private async loginWithCredentials(
    semel: number,
    year: number,
    username: string,
    password: string,
    connectionId?: string,
    storedUniqueId?: string,
    /**
     * A login for a year earlier than the connection's own. `Student` has no
     * `schoolYear` — identity is stable across years — so persisting a roster
     * read at a dead year would stamp the live children with that year's
     * `classCode`/`classNum` and set `isActive: true` on children who have
     * since left. Writing `mashovUniqueId` back may also evict the live
     * session upstream. So a historical login reads data and nothing else.
     */
    isHistorical = false,
  ): Promise<ConnectionLogin> {
    const csrfToken = MASHOV_CSRF_TOKEN;

    const loginBody = {
      semel: Number(semel),
      year: Number(year),
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

    const response: AxiosResponse<LoginResponse> = await this.httpClient.post(
      '/api/login',
      loginBody,
      { headers: { ...this.loginHeaders(csrfToken), ...extraHeaders } },
    );

    return this.finishConnectionLogin(
      response,
      semel,
      year,
      username,
      connectionId,
      isHistorical,
    );
  }

  /** The headers every connection login sends. */
  private loginHeaders(csrfToken: string = MASHOV_CSRF_TOKEN): Record<string, string> {
    return {
      'X-Csrf-Token': csrfToken,
      'Content-Type': 'application/json',
      Referer: `${this.baseUrl}/students/login`,
      'sec-ch-ua-platform': '"macOS"',
      'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      'sec-ch-ua-mobile': '?0',
    };
  }

  /**
   * Everything a connection login does once the response is in hand: parse the
   * session cookies, persist the device identity, refresh the roster, and prime
   * the per-connection caches.
   *
   * Shared by the password login and the trusted-device login so the two cannot
   * drift about what a login persists -- in particular about writing back the
   * `devicePass`, which Mashov may rotate on either route.
   */
  private async finishConnectionLogin(
    response: AxiosResponse<LoginResponse>,
    semel: number,
    year: number,
    username: string,
    connectionId: string | undefined,
    isHistorical: boolean,
  ): Promise<ConnectionLogin> {
    const setCookieHeader = response.headers['set-cookie'];
    if (!setCookieHeader) {
      throw new Error('No Set-Cookie header in login response for connection');
    }

    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const parsed: Partial<SessionCookies> = {};

    for (const cookie of cookies) {
      const nameValue = cookie.split(';')[0];
      if (!nameValue) continue;
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx === -1) continue;
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();
      if (name === 'Csrf-Token') parsed.csrfToken = value;
      else if (name === 'MashovAuthToken') parsed.mashovAuthToken = value;
      else if (name === 'uniquId') parsed.uniquId = value;
    }

    if (!parsed.csrfToken || !parsed.mashovAuthToken || !parsed.uniquId) {
      throw new Error(
        `Missing required session cookies for connection login. Got: ${Object.keys(parsed).join(', ')}`,
      );
    }

    if (connectionId && parsed.uniquId && !isHistorical) {
      const enrolledYears = this.enrolledSchoolYears(response.data);
      // Mashov may rotate the devicePass on any login, including a
      // trusted-device one. Keeping a stale value would fail the NEXT
      // re-login, and sync would silently drop back to a password that may no
      // longer exist -- so whatever came back is written through.
      const devicePass = readDevicePassHeader(response.headers);
      await this.prisma.householdConnection.update({
        where: { id: connectionId },
        data: {
          mashovUniqueId: parsed.uniquId,
          // Only when Mashov actually sent them: writing [] over a known list
          // would make the backfill skip every year instead of falling back to
          // the capped window.
          ...(enrolledYears ? { schoolYears: enrolledYears } : {}),
          // Encrypted like `encryptedPassword` -- it is a credential, and it
          // alone is enough to get a session.
          ...(devicePass
            ? { devicePass: this.encryptionService.encrypt(devicePass) }
            : {}),
        },
      });
    }

    // Persist the roster on every login EXCEPT a historical one. The old
    // version read `response.headers` and discarded `response.data`, throwing
    // `accessToken.children[]` away — the single reason a child's class never
    // updated. See `isHistorical` for why the backfill is the one exception.
    const roster = isHistorical
      ? { created: 0, updated: 0, deactivated: 0 }
      : await this.persistRoster(
          response.data,
          Number(semel),
          Number(year),
          connectionId ?? null,
        );
    if (connectionId) {
      const key = this.sessionKey(connectionId, Number(year));
      this.lastRosterByConnection.set(key, roster);
      this.lastLoginByConnection.set(key, response.data);
    }

    this.logger.debug(`Connection session established for semel=${semel} username=${username}`);
    return { cookies: parsed as SessionCookies, loginData: response.data, roster };
  }
}

/**
 * The `devicePass` response header, whatever case the transport chose.
 *
 * Axios lowercases header names on the Node adapter but not everywhere, and
 * Mashov's own bundle spells it mixed-case. A case-sensitive read would
 * silently return nothing and quietly disable the trusted-device path -- which
 * surfaces a day later as "MFA accounts stopped syncing" rather than as an
 * error anyone can see.
 */
function readDevicePassHeader(headers: unknown): string | undefined {
  return readResponseHeader(headers as Record<string, unknown> | undefined, 'devicepass');
}
