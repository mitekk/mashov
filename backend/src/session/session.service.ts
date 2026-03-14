import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "./encryption.service";

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
    username: string;
  };
}

interface SessionCookies {
  csrfToken: string;
  mashovAuthToken: string;
  uniquId: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly baseUrl = "https://web.mashov.info";
  private csrfToken: string | null = null;
  private sessionCookies: SessionCookies | null = null;
  private isAuthenticating = false;
  private authPromise: Promise<void> | null = null;
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
  ) {
    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
    });
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
    const year = this.configService.get<number>("MASHOV_YEAR");
    const username = this.configService.get<string>("MASHOV_USERNAME");
    const password = this.configService.get<string>("MASHOV_PASSWORD");

    if (!semel || !year || !username || !password) {
      throw new Error(
        "Missing required Mashov credentials in environment variables",
      );
    }

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
        },
      },
    );

    console.log("Login response headers:", response.headers);

    this.extractAndStoreCookies(
      response.headers as Record<string, string | string[]>,
    );

    await this.parseAndPersistChildren(response.data, username, password);
    await this.parseAndPersistHousehold(
      response.data,
      Number(semel),
      Number(year),
      username,
      password,
    );

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

  async ensureStudentsAvailable(): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      return;
    }

    const activeStudents = await this.prisma.student.count({
      where: { isActive: true },
    });
    if (activeStudents > 0) {
      return;
    }

    this.logger.warn(
      "No active students found in DB; forcing re-authentication to refresh roster",
    );

    try {
      await this.ensureAuthenticated(true);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to refresh student roster: ${msg}`);
    }
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

  private async parseAndPersistChildren(
    data: LoginResponse,
    _username: string,
    _password: string,
  ): Promise<void> {
    const children = data.accessToken?.children ?? [];

    for (const child of children) {
      await this.prisma.student.upsert({
        where: { studentGuid: child.childGuid },
        create: {
          studentGuid: child.childGuid,
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
        },
        update: {
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
        },
      });
    }

    this.logger.debug(`Persisted ${children.length} children`);
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
      where: { schoolCode: semel, schoolYear: year },
    });

    if (existing) {
      await this.prisma.householdConnection.update({
        where: { id: existing.id },
        data: {
          username,
          encryptedPassword,
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
}
