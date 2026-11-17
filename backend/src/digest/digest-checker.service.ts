import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { schoolYearScope } from '../common/school-year/school-year.scope';
import { DigestDeadlineService, hasDeadlineHint, jerusalemDayBounds } from './digest-deadline.service';
import { DigestCandidate, DigestItemType } from './digest.types';

/**
 * How long a claimed-but-unconfirmed row is respected before another run may
 * take it over. A row stays unconfirmed only when the run that claimed it died
 * between claiming and sending, which means nothing was delivered -- so the
 * item must come back rather than be lost. Long enough that a slow LLM call
 * plus a slow Telegram call cannot trip it.
 */
export const STALE_CLAIM_MS = 30 * 60 * 1000;

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';
const DEFAULT_DUE_LOOKBACK_DAYS = 14;

/**
 * How far back to look for homework to report as newly assigned.
 *
 * Not today-only. Israeli teachers routinely enter homework in the evening,
 * after the 19:00 run, and `lessonDate` is the lesson's date -- so a
 * today-only window loses that assignment permanently: tomorrow's window is
 * tomorrow, and a plain assignment ("שאלות על הלוח") trips no deadline hint
 * either, so nothing else picks it up. There is no `firstSeenAt` column to key
 * off, since `updatedAt` is churned by the 12-minute sync upserts.
 *
 * Widening is safe because dedup is by content hash: anything already reported
 * stays reported, and only genuinely unreported late arrivals come through,
 * bounded further by the recipient's activeFrom. Three days covers an evening
 * entry plus a weekend.
 */
const DEFAULT_NEW_LOOKBACK_DAYS = 3;

export interface DigestCheckInput {
  studentGuid: string;
  schoolYear: number;
  now: Date;
  /**
   * The earliest `activeFrom` among the child's enabled recipients. Items dated
   * before it are never reported, which is what stops the first run after a
   * parent signs up blasting the whole school year at them.
   */
  activeFrom: Date;
}

export interface DigestCheckResult {
  candidates: DigestCandidate[];
  /** The school day this run covers, UTC midnight of the Jerusalem date. */
  reportFor: Date;
}

/** Row shapes the checker selects. Narrower than the Prisma models on purpose. */
interface BehaviorCandidateRow {
  id: string;
  eventCode: number;
  achvaName: string;
  classification: string;
  justifiable: boolean;
  subject: string;
  remark: string | null;
  lessonDate: Date;
  eventAt: Date;
}

interface HomeworkCandidateRow {
  id: string;
  groupId: number;
  subjectName: string;
  homeworkText: string;
  remark: string | null;
  lessonDate: Date;
}

/**
 * Decides cheaply whether a child has anything unreported, and names it.
 *
 * Runs per child, seven times a day, so it is four narrow queries plus one
 * dedup lookup -- no model calls and no upstream HTTP. The LLM cannot be the
 * gate here; see `hasDeadlineHint`.
 */
@Injectable()
export class DigestCheckerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly deadlines: DigestDeadlineService,
  ) {}

  async check(input: DigestCheckInput): Promise<DigestCheckResult> {
    const { studentGuid, schoolYear, now, activeFrom } = input;
    const timeZone = this.config.get<string>('DIGEST_TIMEZONE') ?? DEFAULT_TIMEZONE;
    const { todayStart, tomorrowStart, reportFor } = jerusalemDayBounds(now, timeZone);
    const yearScope = schoolYearScope(schoolYear);

    const candidates: InternalCandidate[] = [
      ...(await this.behaviorToday(studentGuid, yearScope, todayStart, tomorrowStart)),
      ...(await this.homeworkAssignedRecently(studentGuid, yearScope, todayStart, tomorrowStart)),
      ...(await this.homeworkDueTomorrow(
        studentGuid,
        schoolYear,
        yearScope,
        todayStart,
        tomorrowStart,
      )),
      // activeFrom is a timestamp (now() when the recipient was created) while
      // lessonDate is a date at UTC midnight. Comparing them directly
      // suppressed every homework item on the sign-up day while still
      // reporting that day's behavior, whose eventAt is later in the day.
    ].filter(
      (candidate) => candidate.itemDate >= jerusalemDayBounds(activeFrom, timeZone).todayStart,
    );

    const unreported = await this.dropAlreadyReported(
      studentGuid,
      candidates,
      now,
      tomorrowStart,
    );

    return {
      candidates: unreported,
      reportFor,
    };
  }

  /**
   * Behavior carries two dates: `lessonDate` (when the event happened) and
   * `eventAt` (when the teacher recorded it). Matching on either means a
   * teacher entering yesterday's absence this afternoon still reaches the
   * parent today, which is exactly the news they want. Widening cannot cause a
   * repeat, because dedup is by contentHash.
   */
  private async behaviorToday(
    studentGuid: string,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    const rows = (await this.prisma.behaviorItem.findMany({
      where: {
        studentGuid,
        ...yearScope,
        OR: [
          { lessonDate: { gte: todayStart, lt: tomorrowStart } },
          { eventAt: { gte: todayStart, lt: tomorrowStart } },
        ],
      },
      select: {
        id: true,
        eventCode: true,
        achvaName: true,
        classification: true,
        justifiable: true,
        subject: true,
        remark: true,
        lessonDate: true,
        eventAt: true,
      },
    })) as BehaviorCandidateRow[];

    return rows.map((row) => ({
      itemType: 'behavior' as DigestItemType,
      itemId: row.id,
      contentHash: hashFields('behavior', [
        row.id,
        String(row.eventCode),
        row.achvaName,
        row.classification,
        String(row.justifiable),
        row.subject,
        row.remark ?? '',
        row.lessonDate.toISOString(),
      ]),
      // The later of the two dates: an event recorded today is today's news even
      // when it happened yesterday, so activeFrom must not exclude it.
      itemDate: row.eventAt > row.lessonDate ? row.eventAt : row.lessonDate,
    }));
  }

  private async homeworkAssignedRecently(
    studentGuid: string,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    const rows = (await this.prisma.homeworkItem.findMany({
      where: {
        studentGuid,
        ...yearScope,
        lessonDate: {
          gte: daysBefore(todayStart, this.readDays('DIGEST_NEW_LOOKBACK_DAYS', DEFAULT_NEW_LOOKBACK_DAYS)),
          lt: tomorrowStart,
        },
      },
      select: HOMEWORK_SELECT,
    })) as HomeworkCandidateRow[];

    return rows.map((row) => ({
      itemType: 'homework_new' as DigestItemType,
      itemId: row.id,
      contentHash: hashHomework('homework_new', row),
      itemDate: row.lessonDate,
    }));
  }

  /**
   * Homework that may be needed tomorrow. A row qualifies if the timetable puts
   * its group's next lesson tomorrow, or if the Hebrew text names a deadline of
   * its own -- the second condition widens the set so the LLM can resolve a
   * deadline the timetable would have missed, and the LLM narrows it afterwards.
   *
   * Mashov has no due-date field, so this is an estimate throughout; the report
   * labels it as one. See ADR-0026.
   */
  private async homeworkDueTomorrow(
    studentGuid: string,
    schoolYear: number,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    const lookbackStart = daysBefore(
      todayStart,
      this.readDays('DIGEST_DUE_LOOKBACK_DAYS', DEFAULT_DUE_LOOKBACK_DAYS),
    );

    const rows = (await this.prisma.homeworkItem.findMany({
      where: {
        studentGuid,
        ...yearScope,
        lessonDate: { gte: lookbackStart, lt: tomorrowStart },
      },
      select: HOMEWORK_SELECT,
    })) as HomeworkCandidateRow[];

    // A 14-day lookback returns many rows sharing a group, and the estimate
    // depends only on (group, day) -- so resolve each group once per run rather
    // than once per homework row.
    const estimateByGroup = new Map<number, Date | null>();
    const estimateFor = async (groupId: number): Promise<Date | null> => {
      const memoed = estimateByGroup.get(groupId);
      if (memoed !== undefined) return memoed;
      const resolved = await this.deadlines.estimateFromTimetable(
        studentGuid,
        schoolYear,
        groupId,
        todayStart,
      );
      estimateByGroup.set(groupId, resolved);
      return resolved;
    };

    const candidates: InternalCandidate[] = [];
    for (const row of rows) {
      const estimated = await estimateFor(row.groupId);
      const dueTomorrow = estimated !== null && estimated.getTime() === tomorrowStart.getTime();
      const textHint = hasDeadlineHint(row.homeworkText);
      if (!dueTomorrow && !textHint) continue;

      candidates.push({
        itemType: 'homework_due' as DigestItemType,
        itemId: row.id,
        contentHash: hashHomework('homework_due', row),
        estimatedDueDate: estimated,
        hasTextHint: textHint,
        itemDate: row.lessonDate,
      });
    }

    return candidates;
  }

  /**
   * One query for the whole batch. A row already in the ledger means the item
   * was reported -- unless it was claimed and never confirmed, in which case the
   * run that owned it died before sending and the item has to come back.
   */
  private async dropAlreadyReported(
    studentGuid: string,
    candidates: InternalCandidate[],
    now: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    if (candidates.length === 0) return [];

    const rows = await this.prisma.digestReportedItem.findMany({
      where: {
        studentGuid,
        contentHash: { in: candidates.map((candidate) => candidate.contentHash) },
      },
      select: {
        contentHash: true,
        confirmedAt: true,
        claimedAt: true,
        resolvedDueDate: true,
      },
    });

    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    const spokenFor = new Set(
      rows.filter((row) => isSpokenFor(row, staleBefore, tomorrowStart)).map((r) => r.contentHash),
    );

    return candidates.filter((candidate) => !spokenFor.has(candidate.contentHash));
  }

  private readDays(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string | number>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

/** A candidate plus the date `activeFrom` is compared against. */
interface InternalCandidate extends DigestCandidate {
  itemDate: Date;
}

const HOMEWORK_SELECT = {
  id: true,
  groupId: true,
  subjectName: true,
  homeworkText: true,
  remark: true,
  lessonDate: true,
} as const;

/**
 * sha256 over exactly the fields the parent will see, prefixed by the reason the
 * item is being reported so the same homework row can be reported once as newly
 * assigned and later as estimated-due.
 *
 * Never include `updatedAt`: the 12-minute sync tasks upsert identical rows and
 * churn it on every pass, which would make every item look new every hour.
 */
function hashFields(itemType: string, fields: string[]): string {
  return createHash('sha256').update([itemType, ...fields].join('\u0000')).digest('hex');
}

function hashHomework(itemType: DigestItemType, row: HomeworkCandidateRow): string {
  return hashFields(itemType, [
    row.id,
    row.subjectName,
    row.homeworkText,
    row.remark ?? '',
    row.lessonDate.toISOString(),
  ]);
}

/**
 * Whether a ledger row means "do not report this again, for now".
 *
 * A confirmed row with no `resolvedDueDate` is fully reported. A confirmed row
 * *with* one was deferred by the orchestrator to that date, and must come back
 * on the day that date is tomorrow -- otherwise a homework item whose text said
 * "hand in Thursday" is silently buried on Wednesday, which is exactly the day
 * the parent needed to hear about it.
 *
 * An unconfirmed row belongs to a run that is still working, unless it has sat
 * there past the staleness window, in which case that run died before sending
 * and the item has to be picked up again.
 */
function isSpokenFor(
  row: { confirmedAt: Date | null; claimedAt: Date; resolvedDueDate?: Date | null },
  staleBefore: Date,
  tomorrowStart: Date,
): boolean {
  if (row.confirmedAt !== null) {
    // Absent and null both mean "not deferred, fully reported".
    if (!row.resolvedDueDate) return true;
    return row.resolvedDueDate.getTime() !== tomorrowStart.getTime();
  }
  return row.claimedAt > staleBefore;
}

/** UTC-midnight date `days` before `from`. Date.UTC normalises the underflow. */
function daysBefore(from: Date, days: number): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - days),
  );
}
