import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppSessionService } from '../app-session/app-session.service';
import { EncryptionService } from '../session/encryption.service';

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
    username: string;
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly mashovBaseUrl = 'https://web.mashov.info';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly appSessionService: AppSessionService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {}

  async getSchools(): Promise<unknown[]> {
    const response = await axios.get<unknown[]>(
      `${this.mashovBaseUrl}/api/schools`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 10000,
      },
    );
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

    // Authenticate against Mashov
    let loginData: MashovLoginResponse;
    let newUniqueId: string | undefined;
    try {
      const csrfToken = '9c690c16-d0c8-ed43-9314-d622077e2e26';
      const year = Number(this.configService.get<string>('MASHOV_YEAR') ?? '2026');

      const existingConn = await this.prisma.householdConnection.findFirst({
        where: { schoolCode: Number(semel), schoolYear: year },
        select: { mashovUniqueId: true },
      });
      const storedUniqueId = existingConn?.mashovUniqueId ?? null;

      const loginBody = {
        semel: Number(semel),
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

      const response = await axios.post<MashovLoginResponse>(
        `${this.mashovBaseUrl}/api/login`,
        loginBody,
        {
          headers: {
            'X-Csrf-Token': csrfToken,
            'Content-Type': 'application/json',
            Referer: `${this.mashovBaseUrl}/students/login`,
            Accept: 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            ...extraHeaders,
          },
          timeout: 30000,
        },
      );
      loginData = response.data;

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
    } catch (err) {
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

    // Upsert AppUser
    const existingUser = await this.prisma.appUser.findUnique({
      where: { mashovUserId },
    });

    const encryptedPassword = this.encryptionService.encrypt(password);

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

    // Upsert HouseholdConnection with userId
    const year = Number(this.configService.get<string>('MASHOV_YEAR') ?? '2026');
    const existingConn = await this.prisma.householdConnection.findFirst({
      where: { schoolCode: Number(semel), schoolYear: year },
    });

    if (existingConn) {
      await this.prisma.householdConnection.update({
        where: { id: existingConn.id },
        data: {
          username,
          encryptedPassword,
          schoolName: schoolSettings?.schoolName,
          upstreamUserId: mashovUserId,
          lastLoginAt: new Date(),
          active: true,
          userId: appUser.id,
          ...(newUniqueId ? { mashovUniqueId: newUniqueId } : {}),
        },
      });
    } else {
      await this.prisma.householdConnection.create({
        data: {
          schoolCode: Number(semel),
          schoolYear: year,
          username,
          encryptedPassword,
          schoolName: schoolSettings?.schoolName,
          upstreamUserId: mashovUserId,
          lastLoginAt: new Date(),
          active: true,
          userId: appUser.id,
          ...(newUniqueId ? { mashovUniqueId: newUniqueId } : {}),
        },
      });
    }

    // Persist students from login response
    const children = loginData.accessToken?.children ?? [];
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
          groupsRaw: child.groups as unknown as import('@prisma/client').Prisma.InputJsonValue,
          isActive: true,
          rawPayload: child as unknown as import('@prisma/client').Prisma.InputJsonValue,
        },
        update: {
          privateName: child.privateName,
          familyName: child.familyName,
          fullName: `${child.privateName} ${child.familyName}`,
          classCode: child.classCode,
          classNum: child.classNum,
          gender: child.gender,
          groupsRaw: child.groups as unknown as import('@prisma/client').Prisma.InputJsonValue,
          isActive: true,
          rawPayload: child as unknown as import('@prisma/client').Prisma.InputJsonValue,
        },
      });
    }

    // Create session
    const sessionToken = await this.appSessionService.createSession(appUser.id, ip);

    return { sessionToken, isFirstLogin };
  }

  async getMe(userId: string): Promise<{
    mashovUserId: string;
    username: string;
    displayName: string;
    connectedSchool: { schoolName: string; schoolYear: number } | null;
  }> {
    const appUser = await this.prisma.appUser.findUnique({
      where: { id: userId },
    });

    if (!appUser) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'User not found', details: [] },
      });
    }

    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId, active: true },
      orderBy: { lastLoginAt: 'desc' },
    });

    const connectedSchool =
      connection
        ? {
            schoolName: connection.schoolName ?? '',
            schoolYear: connection.schoolYear,
          }
        : null;

    return {
      mashovUserId: appUser.mashovUserId,
      username: appUser.username,
      displayName: appUser.displayName,
      connectedSchool,
    };
  }
}
