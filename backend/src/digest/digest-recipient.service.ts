import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DigestDelivery, DigestRecipient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Channels a sender exists for. A row for anything else could never deliver. */
const SUPPORTED_CHANNELS = ['telegram', 'log'];

export interface CreateRecipientInput {
  studentGuid: string;
  channel: string;
  address: string;
  displayName?: string;
}

export interface UpdateRecipientInput {
  enabled?: boolean;
  displayName?: string;
}

/** One child the cron should produce a digest for. */
export interface DigestDeliveryTarget {
  studentGuid: string;
  /**
   * The earliest `activeFrom` among the child's enabled recipients. Items dated
   * before it are never reported.
   */
  activeFrom: Date;
  recipientCount: number;
}

/**
 * Recipient CRUD, and the list of children the digest cron should run for.
 *
 * These rows are the de-facto child -> parent ownership mapping. `Student` has
 * no userId FK -- children are global and every existing cron iterates the
 * whole active roster -- so a child gets a digest only if an enabled recipient
 * row exists for it. That makes delivery strictly opt-in, which is the right
 * default for pushing a child's behavior data to a messaging app.
 *
 * Knowingly accepted limitation: nothing stops user A creating a row for user
 * B's child, because there is no FK to validate against. What is done here is
 * what can be done -- the studentGuid must be on the active roster, and the
 * creating userId is recorded on every row, so each one is attributable. A real
 * ownership model is separate work; see ADR-0025.
 */
@Injectable()
export class DigestRecipientService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, input: CreateRecipientInput): Promise<DigestRecipient> {
    const channel = input.channel?.trim() ?? '';
    if (!SUPPORTED_CHANNELS.includes(channel)) {
      throw new BadRequestException(
        `Unsupported digest channel "${channel}". Supported: ${SUPPORTED_CHANNELS.join(', ')}.`,
      );
    }

    const address = input.address?.trim() ?? '';
    if (address.length === 0) {
      throw new BadRequestException('A digest recipient needs an address.');
    }

    const studentGuid = input.studentGuid?.trim() ?? '';
    const onRoster = await this.prisma.student.findFirst({
      where: { studentGuid, isActive: true },
      select: { studentGuid: true },
    });
    if (!onRoster) {
      throw new BadRequestException(`No active child with studentGuid "${studentGuid}".`);
    }

    return this.prisma.digestRecipient.create({
      data: {
        userId,
        studentGuid,
        channel,
        address,
        displayName: input.displayName?.trim() || null,
      },
    });
  }

  /** The caller's own recipients for a child, not every household's. */
  async listFor(studentGuid: string, userId: string): Promise<DigestRecipient[]> {
    return this.prisma.digestRecipient.findMany({
      where: { studentGuid, userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(
    id: string,
    input: UpdateRecipientInput,
    userId: string,
  ): Promise<DigestRecipient> {
    await this.requireOwned(id, userId);

    return this.prisma.digestRecipient.update({
      where: { id },
      data: {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName?.trim() || null }),
      },
    });
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.requireOwned(id, userId);
    await this.prisma.digestRecipient.delete({ where: { id } });
  }

  /**
   * Delivery history for the children this user actually receives digests for.
   *
   * Scoped deliberately, even though the app's child model is otherwise global:
   * a delivery row carries `messageText`, the rendered behavior remarks that
   * were sent to a parent, and that is a new class of content to expose. An
   * authenticated user from another household has no business reading it.
   */
  async listDeliveries(
    userId: string,
    options: { studentGuid?: string; page?: number; limit?: number },
  ): Promise<{
    data: DigestDelivery[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;

    const own = await this.prisma.digestRecipient.findMany({
      where: { userId },
      select: { studentGuid: true },
      distinct: ['studentGuid'],
    });
    let guids = own.map((row) => row.studentGuid);
    if (options.studentGuid) {
      guids = guids.filter((guid) => guid === options.studentGuid);
    }

    if (guids.length === 0) {
      return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
    }

    const where = { studentGuid: { in: guids } };
    const [data, total] = await Promise.all([
      this.prisma.digestDelivery.findMany({
        where,
        orderBy: { runAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.digestDelivery.count({ where }),
    ]);

    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * The children the cron should run for: those with at least one enabled
   * recipient. A child with none is never checked, collected for, or
   * summarized -- which is also what keeps the model bill at zero for families
   * who have not opted in.
   *
   * `userId` scopes the list to one user's own children. The cron omits it and
   * runs every opted-in child; the manual-run endpoint always passes it,
   * because a `studentGuid` in a request body cannot be validated against a
   * child -> parent FK that does not exist (ADR-0025).
   */
  async listDeliveryTargets(userId?: string): Promise<DigestDeliveryTarget[]> {
    const rows = await this.prisma.digestRecipient.findMany({
      where: { enabled: true, ...(userId ? { userId } : {}) },
      select: { studentGuid: true, activeFrom: true },
    });

    const byChild = new Map<string, DigestDeliveryTarget>();
    for (const row of rows) {
      const existing = byChild.get(row.studentGuid);
      if (!existing) {
        byChild.set(row.studentGuid, {
          studentGuid: row.studentGuid,
          activeFrom: row.activeFrom,
          recipientCount: 1,
        });
        continue;
      }
      existing.recipientCount += 1;
      // The earliest activeFrom wins: a parent who opted in first should not
      // lose items because a second recipient was added later.
      if (row.activeFrom < existing.activeFrom) existing.activeFrom = row.activeFrom;
    }

    return [...byChild.values()];
  }

  /**
   * There is no child -> parent FK to validate against, but every row records
   * who created it, so a user cannot silently disable or delete another
   * household's digest. See ADR-0025 for what this does and does not cover.
   */
  private async requireOwned(id: string, userId: string): Promise<void> {
    const existing = await this.prisma.digestRecipient.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No digest recipient with id "${id}".`);
    if (existing.userId !== userId) {
      throw new ForbiddenException('This digest recipient belongs to another user.');
    }
  }
}
