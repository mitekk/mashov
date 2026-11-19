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

    for (const connection of connections) {
      await this.deleteOneConnection(connection);
    }

    const remaining = await this.prisma.householdConnection.count({
      where: { userId, active: true },
    });
    this.logger.log(
      `Unlinked ${connections.length} school(s) for userId=${userId}; ${remaining} remain`,
    );

    return { ok: true };
  }

  private async deleteOneConnection(connection: {
    id: string;
    schoolCode: number;
  }): Promise<void> {
    // The children THIS connection lists, read from the visibility edge rather
    // than the routing stamp: a child two parents share carries one stamp, so
    // a stamp predicate would both miss children this school lists and claim
    // children it does not (ADR-0031).
    //
    // NOT `{ isActive: true }`, which was the original global bug -- and
    // deliberately not unattributed children either, even when this is the
    // household's last school. "Unattributed within this household" does not
    // exist: a child nobody lists has no household by definition, so such a
    // predicate reaches every unattributed child in the database. On a
    // deployment with two households that meant one parent pressing
    // "disconnect all" deleted the other family's children and their whole
    // history, unrecoverably.
    //
    // Leaving them costs nothing that matters: RosterPresenceService already
    // retires a child who stops appearing in any login roster, and the next
    // sync re-links the ones that still belong to somebody.
    const listed = await this.prisma.studentConnection.findMany({
      where: { householdConnectionId: connection.id },
      select: { studentGuid: true },
    });
    const listedGuids = listed.map((link) => link.studentGuid);

    // A child any OTHER connection also lists survives: unlinking removes this
    // parent's VIEW, not the child. Deleting a shared child would take the
    // other parent's homework, behaviour, releases and digest history with it,
    // and there is no second copy anywhere -- every per-child table is keyed by
    // `studentGuid` alone.
    const alsoListedElsewhere =
      listedGuids.length > 0
        ? await this.prisma.studentConnection.findMany({
            where: {
              studentGuid: { in: listedGuids },
              householdConnectionId: { not: connection.id },
            },
            select: { studentGuid: true },
          })
        : [];
    const shared = new Set(alsoListedElsewhere.map((link) => link.studentGuid));
    const studentGuids = listedGuids.filter((guid) => !shared.has(guid));

    // The behaviour taxonomy is school-level, so it survives if another
    // active connection is still at the same school (two parents, one school).
    const sharesSchool = await this.prisma.householdConnection.count({
      where: { schoolCode: connection.schoolCode, active: true, id: { not: connection.id } },
    });

    // This connection's conversations, so their messages can be deleted
    // without trusting the message stamp. The detail fetch wrote messages with
    // no `householdConnectionId` at all, and `MailMessage.conversation` has no
    // `onDelete` (so `Restrict`), so a stamp predicate left those rows behind
    // and the `mailConversation.deleteMany` below then violated
    // `mail_message_conversationId_fkey` and aborted this whole transaction --
    // identically on every retry, recoverable only by hand in the database
    // (R2). The stamping fix in MailService covers rows written from now on;
    // rows written before it are already NULL and nothing reaches them but
    // this predicate.
    const conversationIds = (
      await this.prisma.mailConversation.findMany({
        where: { householdConnectionId: connection.id },
        select: { conversationId: true },
      })
    ).map((c) => c.conversationId);

    await this.prisma.$transaction([
      // Mail: messages BEFORE conversations. MailMessage.conversationId is a
      // foreign key onto MailConversation.conversationId, so the other order
      // is a constraint violation.
      //
      // The `OR` is deliberate. The `conversationId` arm is the correctness
      // fix. The stamp arm keeps a message stamped to this connection from
      // surviving if its conversation ever belongs elsewhere -- harmless on its
      // own, because the `connection` relation is `onDelete: SetNull`, but free
      // to keep. An empty `in: []` matches nothing and the stamp arm still
      // applies.
      this.prisma.mailMessage.deleteMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { householdConnectionId: connection.id },
          ],
        },
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
      // So were all three digest tables, which are keyed by studentGuid too.
      // Left behind, a re-link resurrects the subscriptions AND the dedup
      // ledger -- so the first digest after re-linking silently suppresses
      // every item it had already reported for a child who no longer existed.
      this.prisma.digestRecipient.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      this.prisma.digestReportedItem.deleteMany({
        where: { studentGuid: { in: studentGuids } },
      }),
      this.prisma.digestDelivery.deleteMany({ where: { studentGuid: { in: studentGuids } } }),
      ...(sharesSchool === 0
        ? [
            this.prisma.behaviorTypeReference.deleteMany({
              where: { schoolCode: connection.schoolCode },
            }),
          ]
        : []),
      this.prisma.syncRun.deleteMany({ where: { householdConnectionId: connection.id } }),
      // This connection's views, including the ones on children that survive
      // because another connection still lists them. The connection row's own
      // delete would cascade these away, but doing it explicitly keeps the
      // revocation visible at the point where it is decided.
      this.prisma.studentConnection.deleteMany({
        where: { householdConnectionId: connection.id },
      }),
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
