import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DigestRecipient } from '@prisma/client';
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

  async listFor(studentGuid: string): Promise<DigestRecipient[]> {
    return this.prisma.digestRecipient.findMany({
      where: { studentGuid },
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(id: string, input: UpdateRecipientInput): Promise<DigestRecipient> {
    await this.requireExisting(id);

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

  async remove(id: string): Promise<void> {
    await this.requireExisting(id);
    await this.prisma.digestRecipient.delete({ where: { id } });
  }

  /**
   * The children the cron should run for: those with at least one enabled
   * recipient. A child with none is never checked, collected for, or
   * summarized -- which is also what keeps the model bill at zero for families
   * who have not opted in.
   */
  async listDeliveryTargets(): Promise<DigestDeliveryTarget[]> {
    const rows = await this.prisma.digestRecipient.findMany({
      where: { enabled: true },
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

  private async requireExisting(id: string): Promise<void> {
    const existing = await this.prisma.digestRecipient.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No digest recipient with id "${id}".`);
  }
}
