import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../session/encryption.service';
import {
  createMashovAxios,
  isUpstreamUnreachable,
  resolveMashovBaseUrl,
} from '../common/http/mashov-http';
import { SchoolYearService } from '../common/school-year/school-year.service';
import { MashovSessionService } from '../session/mashov-session.service';

interface MashovLoginResponse {
  credential?: {
    userId?: string;
  };
}

@Injectable()
export class ConnectionService {
  private readonly logger = new Logger(ConnectionService.name);
  private readonly mashovBaseUrl: string;
  /** Shared Mashov client: applies the egress proxy and the abort-signal timeout. */
  private readonly http: AxiosInstance;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    private readonly schoolYearService: SchoolYearService,
    private readonly sessionService: MashovSessionService,
  ) {
    this.mashovBaseUrl = resolveMashovBaseUrl(
      this.configService.get<string>('MASHOV_BASE_URL'),
    );
    this.http = createMashovAxios(this.mashovBaseUrl);
  }

  async updateConnection(
    userId: string,
    username?: string,
    password?: string,
    /**
     * Which school to update. Omitted, the most recently used one -- which is
     * what the deprecated `PUT /connection` means, and the only thing it can
     * mean, since it predates a household having more than one.
     */
    connectionId?: string,
  ): Promise<{ ok: boolean }> {
    const connection = await this.prisma.householdConnection.findFirst({
      where: { userId, active: true, ...(connectionId ? { id: connectionId } : {}) },
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
      // The connection's own year, not an env constant: it is what the 13 sync
      // crons use, so validating against anything else can pass for a year the
      // rest of the app never talks to.
      const year =
        connection.schoolYear > 0
          ? connection.schoolYear
          : (await this.schoolYearService.resolveForSchool(connection.schoolCode)).year;
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

      const validationResponse = await this.http.post<MashovLoginResponse>(
        '/api/login',
        loginBody,
        {
          headers: {
            'X-Csrf-Token': csrfToken,
            'Content-Type': 'application/json',
            Referer: `${this.mashovBaseUrl}/students/login`,
            ...extraHeaders,
          },
        },
      );

      const setCookie = validationResponse.headers?.['set-cookie'];
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
      // An unreachable upstream is not a rejected password; saying otherwise
      // tells the user their new credentials are wrong during an outage.
      if (isUpstreamUnreachable(err)) {
        this.logger.error(
          `Mashov validation unreachable for connection ${connection.id}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        throw new BadGatewayException({
          error: {
            code: 'UPSTREAM_ERROR',
            message:
              'Could not reach Mashov to validate the credentials. Please try again shortly.',
            details: [],
          },
        });
      }
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

  /**
   * Unlink one school, or every school, deleting only that school's data.
   *
   * The old version was global: it read `student.findMany({ isActive: true })`
   * -- every child in the database, not this household's -- and then
   * `mailConversation.deleteMany({})`, `mailMessage.deleteMany({})` and
   * `notificationEvent.deleteMany({})` with no `where` at all. On one school
   * that happens to be right. On two it deletes the other school's mail,
   * notifications and child history, and on a multi-tenant box it deletes
   * other families'.
   *
   * It also left `student` rows behind with `isActive: true`, so the OTHER
   * school's per-student crons kept 403ing on every one of them every twelve
   * minutes, and it never touched `studentRelease` or `schoolActivity` at all
   * -- both pre-existing leaks, fixed here.
   */
  async deleteConnection(
    userId: string,
    connectionId?: string,
  ): Promise<{ ok: boolean }> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, ...(connectionId ? { id: connectionId } : {}) },
      orderBy: { lastLoginAt: 'desc' },
    });

    if (connections.length === 0) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: connectionId
            ? 'No such school is connected to this account'
            : 'No connection found for this user',
          details: [],
        },
      });
    }

    // Whether this is the household's last school decides how NULL-stamped
    // rows are treated below.
    const remaining = await this.prisma.householdConnection.count({
      where: {
        userId,
        active: true,
        id: { notIn: connections.map((connection) => connection.id) },
      },
    });

    for (const connection of connections) {
      await this.deleteOneConnection(connection, remaining === 0);
    }

    this.logger.log(
      `Unlinked ${connections.length} school(s) for userId=${userId}; ${remaining} remain`,
    );

    return { ok: true };
  }

  private async deleteOneConnection(
    connection: { id: string; schoolCode: number },
    isLastConnection: boolean,
  ): Promise<void> {
    // This connection's own children. NOT `{ isActive: true }`, which was the
    // global bug. NULL-stamped children are included only when this is the
    // household's last school: before then, NULL means "ownership unknown",
    // and deleting such a child could remove one belonging to the school that
    // is staying.
    const students = await this.prisma.student.findMany({
      where: isLastConnection
        ? { OR: [{ householdConnectionId: connection.id }, { householdConnectionId: null }] }
        : { householdConnectionId: connection.id },
      select: { studentGuid: true },
    });
    const studentGuids = students.map((student) => student.studentGuid);

    // The behaviour taxonomy is school-level, so it survives if another
    // active connection is still at the same school (two parents, one school).
    const sharesSchool = await this.prisma.householdConnection.count({
      where: { schoolCode: connection.schoolCode, active: true, id: { not: connection.id } },
    });

    await this.prisma.$transaction([
      // Mail: messages BEFORE conversations. MailMessage.conversationId is a
      // foreign key onto MailConversation.conversationId, so the other order
      // is a constraint violation.
      this.prisma.mailMessage.deleteMany({
        where: { householdConnectionId: connection.id },
      }),
      this.prisma.mailConversation.deleteMany({
        where: { householdConnectionId: connection.id },
      }),
      this.prisma.notificationEvent.deleteMany({
        where: { householdConnectionId: connection.id },
      }),
      this.prisma.schoolActivity.deleteMany({
        where: { householdConnectionId: connection.id },
      }),
      this.prisma.parentProfile.deleteMany({
        where: { householdConnectionId: connection.id },
      }),
      // Per-child data, by this school's children.
      this.prisma.homeworkItem.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      this.prisma.behaviorItem.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      this.prisma.messageBoardItem.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      this.prisma.timetableEntry.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      this.prisma.subjectEnrollment.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      // studentRelease was missing from this transaction entirely: a parent's
      // early-release requests survived an unlink and reappeared on re-link.
      this.prisma.studentRelease.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      ...(sharesSchool === 0
        ? [
            this.prisma.behaviorTypeReference.deleteMany({
              where: { schoolCode: connection.schoolCode },
            }),
          ]
        : []),
      this.prisma.syncRun.deleteMany({ where: { householdConnectionId: connection.id } }),
      // The children themselves. Without this they survived as orphans with
      // isActive: true, and the remaining school's per-student crons 403'd on
      // every one of them every twelve minutes, forever.
      this.prisma.student.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      this.prisma.householdConnection.delete({ where: { id: connection.id } }),
    ]);

    // The upstream cookies for this connection live in process memory and
    // were never evicted anywhere, so they survived until a restart -- and a
    // re-link would then be served a session for credentials that had been
    // deleted.
    this.sessionService.invalidateConnection(connection.id);
  }
}
