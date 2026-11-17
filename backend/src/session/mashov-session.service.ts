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
 */
export const ROSTER_TTL_MINUTES = 60;

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
  private csrfToken: string | null = null;
  private sessionCookies: SessionCookies | null = null;
  private isAuthenticating = false;
  private authPromise: Promise<void> | null = null;
  private readonly httpClient: AxiosInstance;
  /** Per-connection session cache keyed by householdConnection.id */
  private readonly connectionSessions = new Map<string, ConnectionSession>();
  /** Last roster counts per connection, written by every connection login. */
  private readonly lastRosterByConnection = new Map<string, RosterResult>();
  /** Last login payload per connection, so the year can be reconciled from it. */
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

  async login(): Promise<void> {
    const csrfToken = "9c690c16-d0c8-ed43-9314-d622077e2e26";

    const semel = this.configService.get<number>("MASHOV_SEMEL");
    const username = this.configService.get<string>("MASHOV_USERNAME");
    const password = this.configService.get<string>("MASHOV_PASSWORD");

    // `year` is deliberately absent from this guard: MASHOV_YEAR is now an
    // optional break-glass override, and requiring it here would mean the app
    // cannot boot without the very constant that froze the school year.
    if (!semel || !username || !password) {
      throw new Error(
        "Missing required Mashov credentials in environment variables",
      );
    }

    const year = (await this.schoolYearService.resolveForSchool(Number(semel))).year;

    const stored = await this.prisma.householdConnection.findFirst({
      where: { schoolCode: Number(semel), username },
      select: { mashovUniqueId: true },
    });
    const storedUniqueId = stored?.mashovUniqueId ?? null;

    const loginBody = {
      semel: Number(semel),
      year: Number(year),
      username,
      password,
      IsBiometric: false,
      appName: "info.mashov.students",
      apiVersion: "3.20210425",
      appVersion: 3.20210425,
      appBuild: 3.20210425,
      deviceUuid: "chrome",
      devicePlatform: "chrome",
      deviceManufacturer: "mac",
      deviceModel: "desktop",
      deviceVersion: "145.0.0.0",
    };

    const extraHeaders: Record<string, string> = {};
    if (storedUniqueId) {
      extraHeaders["Cookie"] = `uniquId=${storedUniqueId}`;
    }

    const response: AxiosResponse<LoginResponse> = await this.httpClient.post(
      "/api/login",
      loginBody,
      {
        headers: {
          "X-Csrf-Token": csrfToken,
          "Content-Type": "application/json",
          Referer: `${this.baseUrl}/students/login`,
          "sec-ch-ua-platform": '"macOS"',
          "sec-ch-ua":
            '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
          "sec-ch-ua-mobile": "?0",
          ...extraHeaders,
        },
      },
    );

    this.extractAndStoreCookies(
      response.headers as Record<string, string | string[]>,
    );

    await this.persistRoster(response.data, Number(semel), year);
    await this.parseAndPersistHousehold(
      response.data,
      Number(semel),
      Number(year),
      username,
      password,
    );

    if (this.sessionCookies?.uniquId) {
      await this.prisma.householdConnection.updateMany({
        where: { schoolCode: Number(semel), username },
        data: { mashovUniqueId: this.sessionCookies.uniquId },
      });
    }

    this.logger.log("Mashov session established successfully");
  }

  private extractAndStoreCookies(
    headers: Record<string, string | string[]>,
  ): void {
    const setCookieHeader = headers["set-cookie"];
    if (!setCookieHeader) {
      throw new Error("No Set-Cookie header in login response");
    }

    const cookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : [setCookieHeader];
    const parsed: Partial<SessionCookies> = {};

    for (const cookie of cookies) {
      const nameValue = cookie.split(";")[0];
      if (!nameValue) continue;
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx === -1) continue;
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();

      if (name === "Csrf-Token") parsed.csrfToken = value;
      else if (name === "MashovAuthToken") parsed.mashovAuthToken = value;
      else if (name === "uniquId") parsed.uniquId = value;
    }

    if (!parsed.csrfToken || !parsed.mashovAuthToken || !parsed.uniquId) {
      throw new Error(
        `Missing required session cookies. Got: ${Object.keys(parsed).join(", ")}`,
      );
    }

    this.sessionCookies = parsed as SessionCookies;
    this.csrfToken = parsed.csrfToken;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (!this.sessionCookies || !this.csrfToken) {
      await this.ensureAuthenticated();
    }

    if (!this.sessionCookies || !this.csrfToken) {
      throw new Error("Failed to establish Mashov session");
    }

    const cookieString = [
      `Csrf-Token=${this.sessionCookies.csrfToken}`,
      `MashovAuthToken=${this.sessionCookies.mashovAuthToken}`,
      `uniquId=${this.sessionCookies.uniquId}`,
    ].join("; ");

    return {
      "X-Csrf-Token": this.csrfToken,
      Cookie: cookieString,
    };
  }

  async refreshIfExpired(): Promise<void> {
    this.logger.debug("Session expired or invalid, re-authenticating");
    this.csrfToken = null;
    this.sessionCookies = null;
    await this.ensureAuthenticated();
  }

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

    const lastRun = await this.prisma.syncRun.findFirst({
      where: {
        source: STUDENTS_SOURCE,
        status: "success",
        ...(connection ? { householdConnectionId: connection.id } : {}),
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

    const dedupeKey = connection?.id ?? "__env__";
    const existing = this.inFlightRosterRefresh.get(dedupeKey);
    if (existing) {
      return existing;
    }

    const refresh = (
      connection
        ? this.refreshRosterForConnection(connection.id).then(() => undefined)
        : this.ensureAuthenticated(true)
    )
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to refresh student roster: ${msg}`);
      })
      .finally(() => {
        this.inFlightRosterRefresh.delete(dedupeKey);
      });

    this.inFlightRosterRefresh.set(dedupeKey, refresh);
    return refresh;
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

    const login = this.lastLoginByConnection.get(connection.id);
    const roster =
      this.lastRosterByConnection.get(connection.id) ??
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

  private async ensureAuthenticated(force = false): Promise<void> {
    if (this.isAuthenticating && this.authPromise) {
      return this.authPromise;
    }

    if (force) {
      this.csrfToken = null;
      this.sessionCookies = null;
    }

    this.isAuthenticating = true;
    this.authPromise = this.login().finally(() => {
      this.isAuthenticating = false;
      this.authPromise = null;
    });

    return this.authPromise;
  }

  async initialize(): Promise<void> {
    try {
      await this.ensureAuthenticated();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to initialize session: ${msg}`);
    }
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
  ): Promise<RosterResult> {
    const children = data.accessToken?.children ?? [];
    const guids = children
      .map((child) => this.readChildGuid(child))
      .filter((guid): guid is string => Boolean(guid));

    const existing =
      guids.length > 0
        ? await this.prisma.student.findMany({
            where: { studentGuid: { in: guids } },
            select: { studentGuid: true },
          })
        : [];
    const existingGuids = new Set(existing.map((row) => row.studentGuid));

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
        rawPayload:
          child as unknown as import("@prisma/client").Prisma.InputJsonValue,
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

    const inactiveGuids = this.parseInactiveChildGuids(
      data.accessToken?.inactiveChildren,
    );
    let deactivated = 0;
    if (inactiveGuids.length > 0) {
      const result = await this.prisma.student.updateMany({
        where: { studentGuid: { in: inactiveGuids } },
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

  private async parseAndPersistHousehold(
    data: LoginResponse,
    semel: number,
    year: number,
    username: string,
    password: string,
  ): Promise<void> {
    const schoolSettings = data.accessToken?.schoolSettings;
    const credential = data.credential;
    const encryptedPassword = this.encryptionService.encrypt(password);

    const existing = await this.prisma.householdConnection.findFirst({
      where: { schoolCode: semel, username },
    });

    if (existing) {
      await this.prisma.householdConnection.update({
        where: { id: existing.id },
        data: {
          username,
          encryptedPassword,
          schoolYear: year,
          schoolName: schoolSettings?.schoolName,
          upstreamUserId: credential?.userId,
          lastLoginAt: new Date(),
          active: true,
        },
      });
    } else {
      await this.prisma.householdConnection.create({
        data: {
          schoolCode: semel,
          schoolYear: year,
          username,
          encryptedPassword,
          schoolName: schoolSettings?.schoolName,
          upstreamUserId: credential?.userId,
          lastLoginAt: new Date(),
          active: true,
        },
      });
    }

    this.logger.debug("Household connection persisted");
  }

  isSessionValid(): boolean {
    return this.sessionCookies !== null && this.csrfToken !== null;
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
    if (forceRefresh) {
      this.connectionSessions.delete(connectionId);
    }

    const cached = this.connectionSessions.get(connectionId);
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
    this.connectionSessions.set(connectionId, placeholder);

    const connRecord = await this.prisma.householdConnection.findUnique({
      where: { id: connectionId },
      select: { mashovUniqueId: true },
    });
    const storedUniqueId = connRecord?.mashovUniqueId ?? undefined;

    const authPromise = this.loginWithCredentials(semel, year, username, password, connectionId, storedUniqueId);
    placeholder.authPromise = authPromise;

    try {
      const { cookies } = await authPromise;
      const csrfToken = cookies.csrfToken;
      this.connectionSessions.set(connectionId, {
        csrfToken,
        cookies,
        isAuthenticating: false,
        authPromise: null,
      });
      return this.buildHeaders(cookies, csrfToken);
    } catch (err) {
      this.connectionSessions.delete(connectionId);
      throw err;
    }
  }

  private buildHeaders(cookies: SessionCookies, csrfToken: string): Record<string, string> {
    const cookieString = [
      `Csrf-Token=${cookies.csrfToken}`,
      `MashovAuthToken=${cookies.mashovAuthToken}`,
      `uniquId=${cookies.uniquId}`,
    ].join('; ');
    return { 'X-Csrf-Token': csrfToken, Cookie: cookieString };
  }

  private async loginWithCredentials(
    semel: number,
    year: number,
    username: string,
    password: string,
    connectionId?: string,
    storedUniqueId?: string,
  ): Promise<ConnectionLogin> {
    const csrfToken = '9c690c16-d0c8-ed43-9314-d622077e2e26';

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
      {
        headers: {
          'X-Csrf-Token': csrfToken,
          'Content-Type': 'application/json',
          Referer: `${this.baseUrl}/students/login`,
          'sec-ch-ua-platform': '"macOS"',
          'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
          'sec-ch-ua-mobile': '?0',
          ...extraHeaders,
        },
      },
    );

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

    if (connectionId && parsed.uniquId) {
      await this.prisma.householdConnection.update({
        where: { id: connectionId },
        data: { mashovUniqueId: parsed.uniquId },
      });
    }

    // Always persist the roster. The old version read `response.headers` and
    // discarded `response.data`, throwing `accessToken.children[]` away — the
    // single reason a child's class never updated.
    const roster = await this.persistRoster(response.data, Number(semel), Number(year));
    if (connectionId) {
      this.lastRosterByConnection.set(connectionId, roster);
      this.lastLoginByConnection.set(connectionId, response.data);
    }

    this.logger.debug(`Connection session established for semel=${semel} username=${username}`);
    return { cookies: parsed as SessionCookies, loginData: response.data, roster };
  }
}
