import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { FeedbackSchoolSnapshot } from '../feedback/feedback.service';

/** The three triage lenses the operator screen offers. */
export const ADMIN_FEEDBACK_FILTERS = ['all', 'new', 'awaiting'] as const;

export type AdminFeedbackFilter = (typeof ADMIN_FEEDBACK_FILTERS)[number];

/** Per .claude/rules/api.md: default 20, hard ceiling 100. */
export const ADMIN_FEEDBACK_DEFAULT_LIMIT = 20;
export const ADMIN_FEEDBACK_MAX_LIMIT = 100;

/**
 * One row of the triage list.
 *
 * `content` is deliberately absent: a list of fifty reports would otherwise
 * ship fifty 2000-character bodies to render fifty one-line rows. The detail
 * view carries it.
 *
 * `hasContactEmail` rather than the address itself -- the list is a triage
 * surface, and it is what makes the "awaiting response" filter legible without
 * putting a parent's email on screen fifty times over.
 */
export interface AdminFeedbackListItem {
  id: string;
  subject: string;
  subjectOther: string | null;
  displayName: string;
  username: string;
  hasContactEmail: boolean;
  /** Pre-rendered `label (semel)` strings, from the row's own snapshot. */
  schools: string[];
  createdAt: string;
  /** The three state flags. Null is included explicitly, never omitted. */
  notifiedAt: string | null;
  readAt: string | null;
  respondedAt: string | null;
}

/** The whole row, delivery state included. */
export interface AdminFeedbackDetail extends AdminFeedbackListItem {
  contactEmail: string | null;
  content: string;
  pagePath: string | null;
  userAgent: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  appVersion: string | null;
  mashovUserId: string;
  /** So a report the notifier gave up on is visible on the screen that replaces it. */
  notifyAttempts: number;
  notifyError: string | null;
}

export interface AdminFeedbackPage {
  data: AdminFeedbackListItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const LIST_SELECT = {
  id: true,
  subject: true,
  subjectOther: true,
  contactEmail: true,
  displayName: true,
  username: true,
  schoolsSnapshot: true,
  createdAt: true,
  notifiedAt: true,
  readAt: true,
  respondedAt: true,
} as const;

/**
 * The operator's read path over the feedback table.
 *
 * Its own service in its own module, so `FeedbackModule` stays the write path
 * and nothing an operator does can reach the code a parent's POST runs. See
 * ADR-0045.
 */
@Injectable()
export class AdminFeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    filter: AdminFeedbackFilter,
    page: number,
    limit: number,
  ): Promise<AdminFeedbackPage> {
    const where = this.whereFor(filter);

    // Counted over the FILTERED set, so the totals describe the page the
    // operator is looking at rather than the table.
    const [rows, total] = await Promise.all([
      this.prisma.feedback.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.feedback.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toListItem(row as unknown as ListRow)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * One report, and a side effect: the first open stamps `readAt`.
   *
   * A GET that writes, which is worth the comment. The alternative is a PATCH
   * the client has to remember to fire, which makes the correctness of the
   * "new" filter depend on the UI -- and a report that stays "new" because a
   * render path changed is exactly the failure this whole feature exists to
   * prevent. It is stamped once and never re-stamped, so it stays the answer
   * to "when did a human first see this".
   */
  async detail(id: string): Promise<AdminFeedbackDetail> {
    const row = await this.require(id);
    if (row.readAt === null) {
      return this.toDetail(await this.stamp(id, { readAt: new Date() }, row));
    }
    return this.toDetail(row);
  }

  /**
   * Record that this parent has been answered.
   *
   * Idempotent, keeping the ORIGINAL timestamp: the field answers "when was
   * this parent answered", and a second click must not rewrite that to today.
   * It also stamps `readAt` when that is somehow still null, so a row can
   * never be both answered and unread.
   */
  async markResponded(id: string): Promise<AdminFeedbackDetail> {
    const row = await this.require(id);
    if (row.respondedAt !== null) return this.toDetail(row);

    const now = new Date();
    return this.toDetail(
      await this.stamp(id, { respondedAt: now, readAt: row.readAt ?? now }, row),
    );
  }

  private whereFor(filter: AdminFeedbackFilter): Prisma.FeedbackWhereInput {
    switch (filter) {
      case 'new':
        return { readAt: null };
      case 'awaiting':
        // A report with no reply address can never be answered, so it must not
        // sit in this list forever.
        return { contactEmail: { not: null }, respondedAt: null };
      default:
        return {};
    }
  }

  private async require(id: string): Promise<DetailRow> {
    const row = await this.prisma.feedback.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Feedback report not found', details: [] },
      });
    }
    return row as unknown as DetailRow;
  }

  private async stamp(
    id: string,
    data: Prisma.FeedbackUpdateInput,
    fallback: DetailRow,
  ): Promise<DetailRow> {
    const updated = await this.prisma.feedback.update({ where: { id }, data });
    // `update` returns the full row, but a caller-supplied mock may not; merge
    // over what was read so the response is complete either way.
    return { ...fallback, ...(updated as unknown as DetailRow) };
  }

  private toListItem(row: ListRow): AdminFeedbackListItem {
    return {
      id: row.id,
      subject: row.subject,
      subjectOther: row.subjectOther,
      displayName: row.displayName,
      username: row.username,
      hasContactEmail: Boolean(row.contactEmail),
      schools: this.schools(row.schoolsSnapshot),
      createdAt: row.createdAt.toISOString(),
      notifiedAt: row.notifiedAt?.toISOString() ?? null,
      readAt: row.readAt?.toISOString() ?? null,
      respondedAt: row.respondedAt?.toISOString() ?? null,
    };
  }

  private toDetail(row: DetailRow): AdminFeedbackDetail {
    return {
      ...this.toListItem(row),
      contactEmail: row.contactEmail,
      content: row.content,
      pagePath: row.pagePath,
      userAgent: row.userAgent,
      viewportWidth: row.viewportWidth,
      viewportHeight: row.viewportHeight,
      appVersion: row.appVersion,
      mashovUserId: row.mashovUserId,
      notifyAttempts: row.notifyAttempts,
      notifyError: row.notifyError,
    };
  }

  /**
   * `label (semel)` per school, from the row's own snapshot.
   *
   * `schoolsSnapshot` is a Json column: `db push` never validated it, and a
   * row written before the snapshot existed -- or edited by hand -- can hold
   * anything. Shape is checked rather than assumed, because an operator screen
   * that 500s on one odd row hides every other report behind it.
   */
  private schools(snapshot: unknown): string[] {
    if (!Array.isArray(snapshot)) return [];
    return snapshot
      .filter((school): school is FeedbackSchoolSnapshot => Boolean(school) && typeof school === 'object')
      .map((school) => `${school.label ?? school.schoolName ?? '?'} (${school.schoolCode})`);
  }
}

interface ListRow {
  id: string;
  subject: string;
  subjectOther: string | null;
  contactEmail: string | null;
  displayName: string;
  username: string;
  schoolsSnapshot: unknown;
  createdAt: Date;
  notifiedAt: Date | null;
  readAt: Date | null;
  respondedAt: Date | null;
}

interface DetailRow extends ListRow {
  content: string;
  pagePath: string | null;
  userAgent: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  appVersion: string | null;
  mashovUserId: string;
  notifyAttempts: number;
  notifyError: string | null;
}
