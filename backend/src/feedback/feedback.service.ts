import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parentDisplayName } from '../common/parent-name';
import { resolveSchoolLabels } from '../common/school-label';

/**
 * The subjects a parent can pick from.
 *
 * Duplicated in `frontend/src/types/api.ts` as a union, because the two sides
 * have separate tsconfig roots and no shared package (the same lane as
 * `frontend/src/lib/school-link-errors.ts`). This literal is the server's
 * authority and `feedback.service.spec.ts` pins it, so a change that forgets
 * the client fails a test here rather than a 400 the parent discovers.
 */
export const FEEDBACK_SUBJECTS = [
  'bug',
  'suggestion',
  'data',
  'account',
  'notifications',
  'timetable',
  'other',
] as const;

export type FeedbackSubject = (typeof FEEDBACK_SUBJECTS)[number];

/**
 * Reports one household may send in one hour.
 *
 * Counted per USER against the table, not per IP. The global ThrottlerGuard
 * keys on IP, so the `@Throttle` decorator on the route is only a crude
 * backstop: a school NAT or two parents sharing a line would otherwise lock
 * each other out. Counting rows also makes the limit integration-testable,
 * which the decorator is not. Precedent: `POST /school-links`.
 */
export const FEEDBACK_MAX_PER_HOUR = 10;

/** Long enough for any real browser's UA; short enough to keep a row small. */
export const FEEDBACK_USER_AGENT_MAX = 512;

const ONE_HOUR_MS = 60 * 60 * 1000;

/** The body of a report, after validation and after `whitelist` stripping. */
export interface CreateFeedbackInput {
  subject: FeedbackSubject;
  subjectOther?: string;
  contactEmail?: string;
  content: string;
  pagePath?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  appVersion?: string;
}

/** One school as the row remembers it. */
export interface FeedbackSchoolSnapshot {
  /** Lets a reader re-join the live connection while it still exists. */
  id: string;
  schoolCode: number;
  schoolName: string | null;
  /** The set-resolved short label, per `resolveSchoolLabels`. */
  label: string;
  schoolYear: number;
}

/** What the parent is told back: enough to confirm, nothing echoed. */
export interface FeedbackReceipt {
  id: string;
  subject: string;
  createdAt: string;
}

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Store one report as a self-contained snapshot.
   *
   * `userAgent` comes from the request header rather than the body: the client
   * has no reason to be trusted with the one field whose whole purpose is
   * telling us what it actually is.
   */
  async create(
    userId: string,
    input: CreateFeedbackInput,
    userAgent?: string | null,
  ): Promise<FeedbackReceipt> {
    await this.assertUnderHourlyLimit(userId);

    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: { mashovUserId: true, username: true, displayName: true },
    });
    if (!user) {
      // The session outlived its household -- a merge that retired the row, or
      // a hand-deleted user. Nothing to snapshot, so nothing to store.
      throw new UnauthorizedException({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: [] },
      });
    }

    const row = await this.prisma.feedback.create({
      data: {
        userId,
        subject: input.subject,
        // Nulled here, not at the validator: `whitelist: true` strips only
        // UNDECORATED properties and `@ValidateIf` merely skips the field, so
        // a stray label on a non-`other` subject would otherwise persist.
        subjectOther: input.subject === 'other' ? (input.subjectOther ?? null) : null,
        contactEmail: input.contactEmail ?? null,
        content: input.content,
        pagePath: input.pagePath ?? null,
        userAgent: userAgent ? userAgent.slice(0, FEEDBACK_USER_AGENT_MAX) : null,
        viewportWidth: input.viewportWidth ?? null,
        viewportHeight: input.viewportHeight ?? null,
        // The client's NEXT_PUBLIC_APP_VERSION is inlined at BUILD time, so a
        // build never given one sends nothing. The server's own APP_VERSION is
        // the fallback: without it this field would read null on every row,
        // and the field exists to answer "is the bug still in the release we
        // are running".
        // `||`, not `??`: docker-compose sets `APP_VERSION: ${APP_VERSION:-}`,
        // so an operator who never set the variable hands this a SET empty
        // string. `??` would pass it through and file every row under `''`,
        // which a reader cannot tell from a build that is genuinely blank.
        appVersion: input.appVersion || process.env.APP_VERSION || null,
        mashovUserId: user.mashovUserId,
        username: user.username,
        // Stripped of the per-school child tag Mashov appends, so one child's
        // name is not persisted into every row of the household.
        displayName: parentDisplayName(user.displayName),
        // A typed interface is not an `InputJsonObject` -- Prisma's Json input
        // type demands an index signature, which would cost the field names
        // their meaning. The cast keeps the shape documented in
        // `FeedbackSchoolSnapshot` instead.
        schoolsSnapshot: (await this.schoolsSnapshot(
          userId,
        )) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, subject: true, createdAt: true },
    });

    return {
      id: row.id,
      subject: row.subject,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async assertUnderHourlyLimit(userId: string): Promise<void> {
    const recent = await this.prisma.feedback.count({
      where: { userId, createdAt: { gte: new Date(Date.now() - ONE_HOUR_MS) } },
    });
    if (recent >= FEEDBACK_MAX_PER_HOUR) {
      // A bare string response: the filter maps 429 to RATE_LIMIT_EXCEEDED, so
      // no new error code enters the envelope.
      throw new HttpException(
        'Too many feedback reports. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The household's schools, as the row will remember them.
   *
   * Labels are resolved over the WHOLE set, which is why this cannot be done
   * one connection at a time: two schools in one cluster share everything up
   * to a " - …" qualifier, and a collision reverts both sides to their full
   * names. Snapshotting the raw nullable `displayLabel` would file two reports
   * under the same unreadable name.
   */
  private async schoolsSnapshot(userId: string): Promise<FeedbackSchoolSnapshot[]> {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      select: {
        id: true,
        schoolCode: true,
        schoolName: true,
        displayLabel: true,
        schoolYear: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const labels = resolveSchoolLabels(connections);

    return connections.map((connection) => ({
      id: connection.id,
      schoolCode: connection.schoolCode,
      schoolName: connection.schoolName,
      label: labels.get(connection.id) ?? String(connection.schoolCode),
      schoolYear: connection.schoolYear,
    }));
  }
}
