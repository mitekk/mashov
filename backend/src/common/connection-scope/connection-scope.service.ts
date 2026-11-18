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

  /** One connection by id. Throws for an unknown or inactive one. */
  async targetFor(connectionId: string): Promise<ConnectionTarget> {
    const row = await this.prisma.householdConnection.findUnique({
      where: { id: connectionId },
    });

    if (!row) {
      throw new Error(`Household connection not found: ${connectionId}`);
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

  /** The connection that owns a child, or the fallback when it is unstamped. */
  async targetForStudent(studentGuid: string): Promise<ConnectionTarget> {
    const student = await this.prisma.student.findUnique({
      where: { studentGuid },
      select: { householdConnectionId: true },
    });

    if (!student) {
      throw new Error(`Student not found: ${studentGuid}`);
    }

    return this.resolveOrFallback(student.householdConnectionId, `student ${studentGuid}`);
  }

  /** The mailbox a conversation came from, or the fallback. */
  async targetForConversation(conversationId: string): Promise<ConnectionTarget> {
    const row = await this.prisma.mailConversation.findUnique({
      where: { conversationId },
      select: { householdConnectionId: true },
    });

    if (!row) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    return this.resolveOrFallback(row.householdConnectionId, `conversation ${conversationId}`);
  }

  /**
   * The mailbox a single message came from, or the fallback.
   *
   * Reads the message's own denormalised column rather than joining through
   * the conversation: an attachment download has a bare `messageId` and
   * nothing else.
   */
  async targetForMessage(messageId: string): Promise<ConnectionTarget> {
    const row = await this.prisma.mailMessage.findUnique({
      where: { messageId },
      select: { householdConnectionId: true },
    });

    if (!row) {
      throw new Error(`Mail message not found: ${messageId}`);
    }

    return this.resolveOrFallback(row.householdConnectionId, `message ${messageId}`);
  }

  /**
   * Split conversation ids by the connection that owns them.
   *
   * An id list from the client can span schools, and one upstream call cannot
   * carry both: Mashov authenticates per school, so archiving a mixed list
   * means one request per connection with its own subset.
   *
   * Unstamped conversations group under `null` rather than being dropped.
   * Before the backfill has run every row is unstamped, and dropping them
   * would make archive silently do nothing. Ids with no local row at all are
   * dropped — there is nothing to act on.
   */
  async groupConversationsByConnection(
    conversationIds: string[],
  ): Promise<Map<string | null, string[]>> {
    const grouped = new Map<string | null, string[]>();
    if (conversationIds.length === 0) return grouped;

    const rows = await this.prisma.mailConversation.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { conversationId: true, householdConnectionId: true },
    });

    const ownerByConversation = new Map(
      rows.map((row) => [row.conversationId, row.householdConnectionId]),
    );

    // Iterating the caller's order, not the query's, so each subset keeps the
    // order the user acted in.
    for (const conversationId of conversationIds) {
      if (!ownerByConversation.has(conversationId)) continue;
      const owner = ownerByConversation.get(conversationId) ?? null;
      const bucket = grouped.get(owner);
      if (bucket) bucket.push(conversationId);
      else grouped.set(owner, [conversationId]);
    }

    return grouped;
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
   * A stamp if there is one, else the household's most recently used
   * connection.
   *
   * The fallback is not a shortcut: NULL means "ownership unknown, re-stamp on
   * the next roster refresh", because the shared env-credential session writes
   * unowned rows and the ownership backfill refuses to guess above one active
   * connection. Throwing instead would take a single-school deployment that
   * has not yet re-synced from working to broken.
   */
  private async resolveOrFallback(
    connectionId: string | null,
    subject: string,
  ): Promise<ConnectionTarget> {
    if (connectionId) {
      const row = await this.prisma.householdConnection.findUnique({
        where: { id: connectionId },
      });
      const target = row?.active ? this.toTarget(row as ConnectionRow) : null;
      if (target) return target;
      this.logger.warn(
        `${subject} is stamped with connection ${connectionId}, which is missing or inactive; falling back`,
      );
    } else {
      this.logger.debug(`${subject} has no ownership stamp; falling back to the latest connection`);
    }

    const fallback = await this.prisma.householdConnection.findFirst({
      where: { active: true },
      orderBy: { lastLoginAt: 'desc' },
    });

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
