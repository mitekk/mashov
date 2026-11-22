import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DigestDelivery, DigestRecipient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  activeConnectionIdsFor,
  linksForStudents,
  ownsStudentForDelivery,
} from '../common/student-links';

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

/**
 * One (child, subscribing parent) the cron should produce a digest for.
 *
 * Per user, not per child. Collapsing to one target per child meant one run,
 * one dedup ledger and one rendered message for a child two parents both
 * subscribe to -- and since consent forms are keyed by user, that single
 * message told the second parent that forms were awaiting their answer which
 * belonged to the first. See ADR-0035.
 */
export interface DigestDeliveryTarget {
  studentGuid: string;
  /**
   * The earliest `activeFrom` among *this user's* enabled recipients for the
   * child. Items dated before it are never reported, which is what stops the
   * first run after they sign up blasting the whole school year -- so it has to
   * be their own cutoff, not the household's earliest.
   */
  activeFrom: Date;
  /** This user's enabled recipient rows for the child. */
  recipientCount: number;
  /** The subscribing parent: whose ledger, whose forms, whose delivery log. */
  userId: string;
}

/**
 * A (child, parent) the send-time guard refused, and the reason.
 *
 * Returned rather than only logged: a refused target is a digest that has
 * stopped, and every other way a run stops writes a `digest_delivery` row --
 * which is the only thing that makes a quiet child distinguishable from a
 * broken job, and the only thing `GET /digest/deliveries` can show a parent
 * asking why their updates went silent.
 */
export interface DigestSkippedTarget {
  studentGuid: string;
  userId: string;
  /** Plain prose, for the delivery row's `errorMessage`. */
  reason: string;
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
 * Creation is scoped to the caller's own children. `Student` still has no
 * userId FK, but ADR-0031's `StudentConnection` link set answers "who may see
 * this child", and `ownsStudentForDelivery` is the strict form of that answer
 * -- strict because it also refuses a child no connection lists, which the
 * read-side `canSeeStudent` deliberately admits. So user A can no longer
 * create a row pointing user B's child, or an unattributed child, at their own
 * Telegram chat. This supersedes ADR-0026's accepted recipient-ownership
 * limitation; see ADR-0033.
 */
@Injectable()
export class DigestRecipientService {
  private readonly logger = new Logger(DigestRecipientService.name);

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

    // Roster membership is not ownership. Without this, an authenticated parent
    // could point another family's child at their own Telegram chat and start
    // receiving that child's behavior reports -- ADR-0026's accepted hole,
    // which stopped being acceptable the moment a UI creates these rows.
    //
    // ownsStudentForDelivery, not canSeeStudent: the read-side helper admits a
    // child no connection lists, because on the read side "ownership unknown"
    // must not empty the app. A write that starts pushing that child's conduct
    // record outward has to fail the other way round. See ADR-0033.
    if (!(await ownsStudentForDelivery(this.prisma, userId, studentGuid))) {
      throw new ForbiddenException('This child belongs to another household.');
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

  /**
   * The caller's own recipients, not every household's.
   *
   * `studentGuid` is optional because the `/more` card asks "what am I
   * subscribed to" without naming a child, and joins names, classes and school
   * labels client-side from the already-cached children list.
   *
   * Paginated, like `listDeliveries` and for the same reason: `.claude/rules/
   * api.md` allows no unbounded list route. A household has a handful of
   * children today, but rows accumulate across years and re-links, and the
   * `/more` card asks for a page large enough to hold them all explicitly
   * rather than relying on the route to never grow.
   */
  async list(options: {
    userId: string;
    studentGuid?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    data: DigestRecipient[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const where = {
      userId: options.userId,
      ...(options.studentGuid ? { studentGuid: options.studentGuid } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.digestRecipient.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.digestRecipient.count({ where }),
    ]);

    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
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
   * This user's own delivery history.
   *
   * Scoped to the runs made *for them*, not to the children they subscribe to.
   * A delivery row carries `messageText` -- the rendered behaviour remarks and
   * the caller's own unanswered consent forms -- so scoping by child let the
   * second parent of a shared child read the first parent's message. Now that
   * every run belongs to one (child, user), the row says whose it was and the
   * scope is that. An authenticated user from another household never matches.
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

    const where = {
      userId,
      ...(options.studentGuid ? { studentGuid: options.studentGuid } : {}),
    };
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
   * child -> parent FK that does not exist (ADR-0026).
   */
  async listDeliveryTargets(
    userId?: string,
  ): Promise<{ targets: DigestDeliveryTarget[]; skipped: DigestSkippedTarget[] }> {
    const rows = await this.prisma.digestRecipient.findMany({
      where: { enabled: true, ...(userId ? { userId } : {}) },
      select: { studentGuid: true, activeFrom: true, userId: true },
    });

    const byUserAndChild = new Map<string, DigestDeliveryTarget>();
    for (const row of rows) {
      const key = `${row.userId}\u0000${row.studentGuid}`;
      const existing = byUserAndChild.get(key);
      if (!existing) {
        byUserAndChild.set(key, {
          studentGuid: row.studentGuid,
          activeFrom: row.activeFrom,
          recipientCount: 1,
          userId: row.userId,
        });
        continue;
      }
      existing.recipientCount += 1;
      // The earliest activeFrom among this user's own rows wins: a parent who
      // opted in first should not lose items because they added a second chat
      // later.
      if (row.activeFrom < existing.activeFrom) existing.activeFrom = row.activeFrom;
    }

    return this.stillDeliverable([...byUserAndChild.values()]);
  }

  /**
   * Re-checks, at send time, that each target's user may still be sent that
   * child -- the question `create` asked when the row was written.
   *
   * A recipient row is not standing proof of anything. The adoption path
   * repoints a `HouseholdConnection` to a different `AppUser` and leaves the
   * old owner's subscriptions behind; `RosterPresenceService` retires a child
   * who stops appearing in any login roster; and rows written before
   * `ownsStudentForDelivery` existed were never checked at all. Any of those
   * keeps a child's behaviour remarks flowing to somebody who is no longer
   * entitled to them.
   *
   * Checked here rather than in the orchestrator so the cron and the
   * manual-run endpoint both get it, and it mutates nothing: revocation is the
   * unlink path's job (ADR-0035), and a transient roster gap must not delete a
   * parent's subscription.
   *
   * Batched, not two queries per target: the cron runs seven times a day over
   * every opted-in child.
   */
  private async stillDeliverable(
    targets: DigestDeliveryTarget[],
  ): Promise<{ targets: DigestDeliveryTarget[]; skipped: DigestSkippedTarget[] }> {
    if (targets.length === 0) return { targets: [], skipped: [] };

    const guids = [...new Set(targets.map((target) => target.studentGuid))];

    const active = new Set(
      (
        await this.prisma.student.findMany({
          where: { studentGuid: { in: guids }, isActive: true },
          select: { studentGuid: true },
        })
      ).map((row) => row.studentGuid),
    );

    const linksByGuid = await linksForStudents(this.prisma, guids);

    const connectionsByUser = new Map<string, Set<string>>();
    for (const userId of new Set(targets.map((target) => target.userId))) {
      connectionsByUser.set(userId, new Set(await activeConnectionIdsFor(this.prisma, userId)));
    }

    const deliverable: DigestDeliveryTarget[] = [];
    const skipped: DigestSkippedTarget[] = [];
    for (const target of targets) {
      if (!active.has(target.studentGuid)) {
        const reason = 'this child is no longer on an active school roster';
        this.logger.warn(
          `Digest target skipped: child ${target.studentGuid} is no longer on an active roster.`,
        );
        skipped.push({ ...pairOf(target), reason });
        continue;
      }
      const links = linksByGuid.get(target.studentGuid) ?? [];
      const mine = connectionsByUser.get(target.userId) ?? new Set<string>();
      // Empty `links` is a refusal, matching ownsStudentForDelivery rather than
      // the read-side canSeeStudent: an unattributed child belongs to nobody
      // until a roster refresh says otherwise.
      if (!links.some((connectionId) => mine.has(connectionId))) {
        const reason =
          'this account no longer owns this child -- the school it was connected through is gone';
        this.logger.warn(
          `Digest target skipped: userId=${target.userId} no longer owns child ${target.studentGuid}.`,
        );
        skipped.push({ ...pairOf(target), reason });
        continue;
      }
      deliverable.push(target);
    }

    return { targets: deliverable, skipped };
  }

  /**
   * There is no child -> parent FK to validate against, but every row records
   * who created it, so a user cannot silently disable or delete another
   * household's digest. See ADR-0026 for what this does and does not cover.
   */
  private async requireOwned(id: string, userId: string): Promise<void> {
    const existing = await this.prisma.digestRecipient.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No digest recipient with id "${id}".`);
    if (existing.userId !== userId) {
      throw new ForbiddenException('This digest recipient belongs to another user.');
    }
  }
}

/** The (child, parent) half of a target, for a skipped entry. */
function pairOf(target: DigestDeliveryTarget): { studentGuid: string; userId: string } {
  return { studentGuid: target.studentGuid, userId: target.userId };
}
