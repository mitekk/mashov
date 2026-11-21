import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../session/encryption.service';
import type { ConnectionTarget } from '../../session/connection-target';

interface ConnectionRow {
  id: string;
  schoolCode: number;
  schoolYear: number;
  username: string;
  encryptedPassword: string;
  schoolName: string | null;
  active: boolean;
}

/**
 * Which household connection owns a row, and the credentials to talk to it.
 *
 * Depends on `PrismaService` and `EncryptionService` and deliberately nothing
 * else — in particular not on `MashovHttpClient`. Ownership is a schema
 * concern and the transport should stay unaware of the schema, so this
 * resolves a `ConnectionTarget` and the client takes it as a parameter. That
 * is also why there is no `getForStudent(url, studentGuid)` on the client:
 * it would drag Prisma and the `Student` model into the transport layer.
 *
 * No in-process cache in this first cut. One indexed lookup per request is
 * cheaper than a staleness bug, and every `targetFor*` below is a primary-key
 * or indexed read.
 */
@Injectable()
export class ConnectionScopeService {
  private readonly logger = new Logger(ConnectionScopeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Every active connection, optionally narrowed to one household.
   *
   * A connection whose password will not decrypt is skipped with a warning
   * rather than failing the batch: after a botched `ENCRYPTION_KEY` rotation
   * one unreadable row must not take the other school's sync down with it.
   */
  async listTargets(userId?: string): Promise<ConnectionTarget[]> {
    const rows = await this.prisma.householdConnection.findMany({
      where: { active: true, ...(userId ? { userId } : {}) },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
    });

    const targets: ConnectionTarget[] = [];
    for (const row of rows) {
      const target = this.toTarget(row as ConnectionRow);
      if (target) targets.push(target);
    }
    return targets;
  }

  /**
   * One connection by id. Throws for an unknown, inactive or foreign one.
   *
   * `userId` is the caller, when there is one. There is no fallback here to
   * scope, so the id itself is the only thing to check -- and its callers
   * reach it with an id grouped out of their own household-scoped read, which
   * bounds them. That should not be the ONLY thing that bounds them: the
   * stamped branch of `resolveOrFallback` was bounded by its callers too, up
   * to the point where one of them was not (**R16**). A connection with no
   * `userId` is admitted, the same "ownership unknown" rule as everywhere
   * else; without a caller (the sync fanout) any active connection resolves.
   */
  async targetFor(connectionId: string, userId?: string): Promise<ConnectionTarget> {
    const row = await this.prisma.householdConnection.findUnique({
      where: { id: connectionId },
    });

    if (!row) {
      throw new Error(`Household connection not found: ${connectionId}`);
    }
    if (userId && row.userId && row.userId !== userId) {
      throw new Error(`Household connection ${connectionId} belongs to another household`);
    }
    if (!row.active) {
      // An unlinked school's credentials are no longer trusted to talk
      // upstream; using them anyway would resurrect a school the parent
      // deliberately disconnected.
      throw new Error(`Household connection is inactive: ${connectionId}`);
    }

    const target = this.toTarget(row as ConnectionRow);
    if (!target) {
      throw new Error(`Could not decrypt credentials for connection ${connectionId}`);
    }
    return target;
  }

  /**
   * The connection that owns a child, or the fallback when it is unstamped.
   *
   * `userId` is the caller, when there is one: it scopes the fallback, so an
   * unattributed child of one household can never be fetched with another
   * household's credentials. Omitting it keeps the global fallback the crons
   * and the digest need.
   */
  async targetForStudent(studentGuid: string, userId?: string): Promise<ConnectionTarget> {
    const student = await this.prisma.student.findUnique({
      where: { studentGuid },
      select: { householdConnectionId: true },
    });

    if (!student) {
      throw new Error(`Student not found: ${studentGuid}`);
    }

    return this.resolveOrFallback(
      student.householdConnectionId,
      `student ${studentGuid}`,
      userId,
    );
  }

  /** The mailbox a conversation came from, or the caller's fallback. */
  async targetForConversation(
    conversationId: string,
    userId?: string,
  ): Promise<ConnectionTarget> {
    const row = await this.prisma.mailConversation.findUnique({
      where: { conversationId },
      select: { householdConnectionId: true },
    });

    if (!row) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    return this.resolveOrFallback(
      row.householdConnectionId,
      `conversation ${conversationId}`,
      userId,
    );
  }

  /**
   * The mailbox a single message came from, or the fallback.
   *
   * Reads the message's own denormalised column rather than joining through
   * the conversation: an attachment download has a bare `messageId` and
   * nothing else.
   */
  async targetForMessage(messageId: string, userId?: string): Promise<ConnectionTarget> {
    const row = await this.prisma.mailMessage.findUnique({
      where: { messageId },
      select: { householdConnectionId: true },
    });

    if (!row) {
      throw new Error(`Mail message not found: ${messageId}`);
    }

    return this.resolveOrFallback(row.householdConnectionId, `message ${messageId}`, userId);
  }

  /**
   * Every child belonging to a household, by way of its connections.
   *
   * An empty list for a user with no connection is correct and load-bearing:
   * it is what makes a caller render an empty state rather than fall back to
   * every student in the database, which is what `getChildren()` did.
   */
  async studentGuidsForUser(userId: string): Promise<string[]> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      select: { id: true },
    });

    if (connections.length === 0) return [];

    const students = await this.prisma.student.findMany({
      where: { householdConnectionId: { in: connections.map((row) => row.id) } },
      select: { studentGuid: true },
    });

    return students.map((row) => row.studentGuid);
  }

  /** Record which connection owns a child. */
  async stampStudent(studentGuid: string, connectionId: string): Promise<void> {
    await this.prisma.student.update({
      where: { studentGuid },
      data: { householdConnectionId: connectionId },
    });
  }

  /**
   * The caller's own stamp if there is one, else the household's most recently
   * used connection -- preferring the stamped school.
   *
   * The fallback is not a shortcut: NULL means "ownership unknown, re-stamp on
   * the next roster refresh", because the shared env-credential session writes
   * unowned rows and the ownership backfill refuses to guess above one active
   * connection. Throwing instead would take a single-school deployment that
   * has not yet re-synced from working to broken.
   *
   * Both branches are scoped to the caller when there is one, and the stamped
   * branch is the later fix (**R16**). Guessing across households meant an
   * unattributed row of A's could resolve to B's connection; honouring a
   * foreign STAMP meant the same thing for a row that is attributed, just not
   * to the caller. Either way A's request went upstream under B's decrypted
   * Mashov password -- for a mutation, writing into B's account. Two parents
   * sharing a child (ADR-0031) reach that every time the other one synced
   * last: `requireStudent` admits the child for both, correctly, and the stamp
   * is the other parent's by design.
   *
   * So a stamp outside the caller's connections is treated as no stamp at all,
   * and the fallback under it prefers the caller's connection AT THE STAMPED
   * SCHOOL -- the row is at that school, so in a two-school household the
   * most recently used connection is the wrong credential to spend. A stamp on
   * a connection with no `userId` is still honoured: that is the same
   * "ownership unknown" rule as everywhere else, and it is what every row of a
   * deployment predating linking looks like.
   *
   * Without a caller (the crons, the digest) the stamp is authoritative and
   * the guess stays global, which is the only thing those paths can do.
   */
  private async resolveOrFallback(
    connectionId: string | null,
    subject: string,
    userId?: string,
  ): Promise<ConnectionTarget> {
    // The school the stamp points at, when there is a stamp to read it from.
    // The stamped row is at that school, so it is the school the fallback
    // below should look for among the caller's own connections.
    let stampedSchoolCode: number | undefined;

    if (connectionId) {
      const row = await this.prisma.householdConnection.findUnique({
        where: { id: connectionId },
      });
      stampedSchoolCode = row?.schoolCode;

      const foreign = Boolean(userId && row?.userId && row.userId !== userId);
      const target = row?.active && !foreign ? this.toTarget(row as ConnectionRow) : null;
      if (target) return target;

      this.logger.warn(
        foreign
          ? `${subject} is stamped with connection ${connectionId}, which belongs to another household; falling back to the caller's own`
          : `${subject} is stamped with connection ${connectionId}, which is missing or inactive; falling back`,
      );
    } else {
      this.logger.debug(`${subject} has no ownership stamp; falling back to the latest connection`);
    }

    const fallback =
      (userId !== undefined && stampedSchoolCode !== undefined
        ? await this.prisma.householdConnection.findFirst({
            where: { active: true, userId, schoolCode: stampedSchoolCode },
            orderBy: { lastLoginAt: 'desc' },
          })
        : null) ??
      (await this.prisma.householdConnection.findFirst({
        where: { active: true, ...(userId ? { userId } : {}) },
        orderBy: { lastLoginAt: 'desc' },
      }));

    const target = fallback ? this.toTarget(fallback as ConnectionRow) : null;
    if (!target) {
      throw new Error(`Cannot resolve ${subject}: no active connection is available`);
    }
    return target;
  }

  private toTarget(row: ConnectionRow): ConnectionTarget | null {
    try {
      return {
        id: row.id,
        schoolCode: row.schoolCode,
        schoolYear: row.schoolYear,
        username: row.username,
        password: this.encryption.decrypt(row.encryptedPassword),
        schoolName: row.schoolName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Skipping connection ${row.id}: its stored password could not be decrypted (${message})`,
      );
      return null;
    }
  }
}
