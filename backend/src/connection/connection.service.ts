import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../session/encryption.service';

interface MashovLoginResponse {
  credential?: {
    userId?: string;
  };
}

@Injectable()
export class ConnectionService {
  private readonly logger = new Logger(ConnectionService.name);
  private readonly mashovBaseUrl = 'https://web.mashov.info';

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {}

  async updateConnection(
    userId: string,
    username?: string,
    password?: string,
  ): Promise<{ ok: boolean }> {
    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId, active: true },
      orderBy: { lastLoginAt: 'desc' },
    });

    if (!connection) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: 'No active connection found for this user',
          details: [],
        },
      });
    }

    const newUsername = username ?? connection.username;
    const currentPassword = password
      ? password
      : this.encryptionService.decrypt(connection.encryptedPassword);

    // Validate new credentials with Mashov before saving
    let newUniqueId: string | undefined;
    try {
      const csrfToken = '9c690c16-d0c8-ed43-9314-d622077e2e26';
      const year = Number(this.configService.get<string>('MASHOV_YEAR') ?? '2026');
      const loginBody = {
        semel: connection.schoolCode,
        year,
        username: newUsername,
        password: currentPassword,
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
      if (connection.mashovUniqueId) {
        extraHeaders['Cookie'] = `uniquId=${connection.mashovUniqueId}`;
      }

      const validationResponse = await axios.post<MashovLoginResponse>(
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

      const setCookie = validationResponse.headers['set-cookie'];
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
    } catch {
      throw new BadRequestException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'New credentials failed to validate against Mashov',
          details: [],
        },
      });
    }

    const encryptedPassword = this.encryptionService.encrypt(currentPassword);

    await this.prisma.householdConnection.update({
      where: { id: connection.id },
      data: {
        username: newUsername,
        encryptedPassword,
        lastLoginAt: new Date(),
        ...(newUniqueId ? { mashovUniqueId: newUniqueId } : {}),
      },
    });

    return { ok: true };
  }

  async deleteConnection(userId: string): Promise<{ ok: boolean }> {
    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId },
      orderBy: { lastLoginAt: 'desc' },
    });

    if (!connection) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: 'No connection found for this user',
          details: [],
        },
      });
    }

    const connectionId = connection.id;

    // Get all student guids associated with this household
    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      select: { studentGuid: true },
    });
    const studentGuids = students.map((s) => s.studentGuid);

    // Delete in dependency order
    await this.prisma.$transaction([
      // Delete sync runs for this connection
      this.prisma.syncRun.deleteMany({
        where: { householdConnectionId: connectionId },
      }),
      // Delete homework items
      this.prisma.homeworkItem.deleteMany({
        where: { studentGuid: { in: studentGuids } },
      }),
      // Delete behavior items
      this.prisma.behaviorItem.deleteMany({
        where: { studentGuid: { in: studentGuids } },
      }),
      // Delete message board items
      this.prisma.messageBoardItem.deleteMany({
        where: { studentGuid: { in: studentGuids } },
      }),
      // Delete timetable entries
      this.prisma.timetableEntry.deleteMany({
        where: { studentGuid: { in: studentGuids } },
      }),
      // Delete mail messages (via conversation relation)
      this.prisma.mailMessage.deleteMany({}),
      // Delete mail conversations
      this.prisma.mailConversation.deleteMany({}),
      // Delete notification events
      this.prisma.notificationEvent.deleteMany({}),
      // Delete subject enrollments
      this.prisma.subjectEnrollment.deleteMany({
        where: { studentGuid: { in: studentGuids } },
      }),
      // Delete the household connection itself
      this.prisma.householdConnection.delete({
        where: { id: connectionId },
      }),
    ]);

    // Keep app_user — only delete connection data
    this.logger.log(`Deleted connection and all data for userId=${userId}`);

    return { ok: true };
  }
}
