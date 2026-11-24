import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { isTakenUsernameConflict } from '../common/prisma-conflicts';
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

/**
 * A P2002 raised by the `(schoolCode, username)` unique index, and only that
 * one. Prisma reports `meta.target` as the field list on Postgres and as the
 * constraint name on some other providers, so both shapes are accepted.
 */
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

    try {
      await this.prisma.householdConnection.update({
        where: { id: connection.id },
        data: {
          username: newUsername,
          encryptedPassword,
          lastLoginAt: new Date(),
          // Mashov just validated this password, so it is the credential that
          // works -- which makes this the write that HEALS a connection a
          // recovery reset marked stale. Without it the banner the parent is
          // acting on can never clear itself: they re-enter the password, we
          // store it, and the banner comes straight back forever.
          credentialStaleAt: null,
          ...(newUniqueId ? { mashovUniqueId: newUniqueId } : {}),
        },
      });
    } catch (err) {
      // `@@unique([schoolCode, username])`: the new username may already be
      // the other parent's account at this school, or an orphan row left by an
      // earlier unlink. Narrowed to that one constraint on purpose -- this
      // update also writes `encryptedPassword`, `lastLoginAt` and
      // `mashovUniqueId`, and a blanket P2002 -> 409 would one day label a
      // different collision "username taken".
      if (isTakenUsernameConflict(err)) {
        throw new ConflictException({
          error: {
            code: 'CONNECTION_ALREADY_LINKED',
            message: 'This account is already linked',
            details: [],
          },
        });
      }
      throw err;
    }

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

    // ONE transaction for the whole unlink, not one per school. The old loop
    // committed each school separately, so a failure on the second school left
    // the first unlinked and still returned a 500 -- the parent pressed
    // "disconnect all", saw an error, and had no way to learn that half of it
    // had happened.
    //
    // Every school being unlinked is passed to each preparation, because the
    // exclusion sets below can no longer mean "every connection but this one".
    // The sequential loop got that right by accident: by the time it reached
    // the second school, the first school's rows were already deleted.
    const deletingIds = connections.map((c) => c.id);
    // Sequentially, not Promise.all: these are reads whose order the tests and
    // the log read back, and nothing here is slow enough to want interleaving.
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    for (const connection of connections) {
      operations.push(
        ...(await this.prepareConnectionDeletion(userId, connection, deletingIds)));
    }

    // B2's reversibility half. A household merge sets `mergedIntoUserId` on
    // the orphan AppUser; unlinking the school that was merged in has to
    // release it, or `AuthService.resolveMergedOwner` keeps dragging that
    // account's next sign-in into this household and ADR-0029's claim that
    // unlink lets B re-form its own household stays false.
    //
    // Scoped precisely, not to every pointer at this household: the orphan's
    // `AppUser.mashovUserId` equals the merged connection's
    // `upstreamUserId`. Clearing by `mergedIntoUserId` alone would, for a
    // household holding schools A and B with B merged in, release B's orphan
    // when the parent unlinked A -- while B's connection was still sitting
    // here. Read before the transaction, because the transaction deletes the
    // rows these ids come from. A connection with a null `upstreamUserId`
    // identifies no orphan and clears nothing.
    const mergedUpstreamIds = connections
      .map((connection) => connection.upstreamUserId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (mergedUpstreamIds.length > 0) {
      operations.push(
        this.prisma.appUser.updateMany({
          where: { mergedIntoUserId: userId, mashovUserId: { in: mergedUpstreamIds } },
          data: { mergedIntoUserId: null },
        }),
      );
    }

    await this.prisma.$transaction(operations);

    // The upstream cookies for these connections live in process memory and
    // were never evicted anywhere, so they survived until a restart -- and a
    // re-link would then be served a session for credentials that had been
    // deleted. After the commit, so a rolled-back unlink does not evict a
    // session whose connection still exists.
    for (const connection of connections) {
      this.sessionService.invalidateConnection(connection.id);
    }

    const remaining = await this.prisma.householdConnection.count({
      where: { userId, active: true },
    });
    this.logger.log(
      `Unlinked ${connections.length} school(s) for userId=${userId}; ${remaining} remain`,
    );

    return { ok: true };
  }

  /**
   * The deletes for one school, prepared but not run: the caller puts every
   * school's into a single `$transaction`.
   *
   * `deletingIds` is every connection in that unlink, this one included. The
   * reads below exclude all of them, because a child or a school-level row
   * kept alive by a connection that is itself being deleted is not kept alive
   * at all.
   */
  private async prepareConnectionDeletion(
    userId: string,
    connection: {
      id: string;
      schoolCode: number;
    },
    deletingIds: string[],
  ): Promise<Prisma.PrismaPromise<unknown>[]> {
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
              householdConnectionId: { notIn: deletingIds },
            },
            select: { studentGuid: true },
          })
        : [];
    const shared = new Set(alsoListedElsewhere.map((link) => link.studentGuid));
    const studentGuids = listedGuids.filter((guid) => !shared.has(guid));

    // The behaviour taxonomy is school-level, so it survives if another
    // active connection is still at the same school (two parents, one school).
    const sharesSchool = await this.prisma.householdConnection.count({
      where: {
        schoolCode: connection.schoolCode,
        active: true,
        id: { notIn: deletingIds },
      },
    });

    return [
      // Mail: messages BEFORE conversations. MailMessage.conversationId is a
      // foreign key onto MailConversation.conversationId, so the other order
      // is a constraint violation.
      //
      // Messages are reached THROUGH the conversation, not by their own stamp.
      // The detail fetch used to write them with no `householdConnectionId` at
      // all, and `MailMessage.conversation` has no `onDelete` (so `Restrict`),
      // so a stamp predicate left those rows behind and the
      // `mailConversation.deleteMany` below then violated
      // `mail_message_conversationId_fkey` and aborted this whole transaction
      // -- identically on every retry, recoverable only by hand in the
      // database (R2). Rows written before the stamping fix in MailService are
      // already NULL and nothing reaches them but this predicate.
      //
      // A relation filter rather than a pre-read of conversation ids. The ids
      // are unbounded -- the mail sync never deletes a row, so they only
      // accumulate -- and an `IN` list long enough would exceed Postgres's
      // 16-bit bind-parameter limit and break the unlink permanently, which is
      // R2's own failure class returning at a higher threshold. It also keeps
      // the read inside the transaction, so a conversation written after a
      // pre-read cannot be missed.
      //
      // The stamp arm catches a message stamped to this connection whose
      // conversation belongs elsewhere. It DELETES that message rather than
      // un-stamping it, which is more than the schema's own
      // `onDelete: SetNull` would do, so it is not free: it is the same
      // trade-off the relation arm already makes. `MailConversation.conversationId`
      // is globally `@unique`, so a conversation two mailboxes hold is ONE row
      // stamped to whichever connection walked it last; unlinking that
      // connection deletes the row (the predicate below, unchanged) and the FK
      // then requires its messages to go too, whoever else could still see
      // them. Before R2 that case did not survive at all -- it was the 500. A
      // narrower message predicate cannot avoid it; only a per-household
      // conversation key could, which is a schema change.
      this.prisma.mailMessage.deleteMany({
        where: {
          OR: [
            { conversation: { householdConnectionId: connection.id } },
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
      // And this user's own digest rows for every child this connection
      // listed, shared ones included. The deletes above only reach children
      // whose `Student` row is going too, so a parent who disconnected their
      // school kept receiving a shared child's behaviour remarks forever: the
      // subscription outlived the connection that justified it, and nothing
      // downstream re-checks why it existed.
      //
      // Scoped to `userId` -- which `deleteConnection` has already verified
      // owns the connection -- so the other parent of a shared child keeps
      // theirs. That scope is also the fix for the mirror image: keyed on
      // studentGuid alone, the deletes above took BOTH parents' rows whenever
      // the child was not shared.
      //
      // The ledger goes with the subscription, for the reason already given
      // just above: a re-link must not resurrect a dedup ledger that would
      // silently suppress everything it had already reported.
      //
      // `TelegramLinkCode` is deliberately left alone. It is link history
      // rather than a subscription -- nothing delivers off it -- the codes
      // expire in fifteen minutes, and they are pruned after seven days.
      this.prisma.digestRecipient.deleteMany({
        where: { userId, studentGuid: { in: listedGuids } },
      }),
      this.prisma.digestReportedItem.deleteMany({
        where: { userId, studentGuid: { in: listedGuids } },
      }),
      this.prisma.digestDelivery.deleteMany({
        where: { userId, studentGuid: { in: listedGuids } },
      }),
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
    ];
  }
}
