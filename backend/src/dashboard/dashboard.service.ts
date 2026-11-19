import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { householdMailScope } from '../common/mail-scope';
import { buildStudentSchoolMap } from '../common/student-school-map';
import { FreshnessService } from '../sync/freshness.service';
import { MashovSessionService } from '../session/mashov-session.service';
import { UserItemStateService } from '../common/user-item-state.service';
import { ConfigService } from '@nestjs/config';
import {
  historyScopeForStudents,
  yearScopeForStudents,
  type StudentYearScope,
} from '../common/school-year/school-year.scope';
import { visibleStudentWhere } from '../common/student-links';

export interface FeedItem {
  id: string;
  sourceType: 'homework' | 'behavior' | 'mail' | 'positive';
  sourceId: string;
  studentGuid: string | null;
  studentName: string | null;
  /**
   * Which school this item's child belongs to, or `null` for a mail item.
   *
   * `null` is also what an unstamped child reports, which the UI reads as "no
   * badge" rather than as a school called "null". Mail is household-wide and
   * genuinely has no child, so it carries none either -- the school filter
   * leaves those visible rather than hiding them under a chip they cannot
   * match.
   */
  schoolId: string | null;
  schoolShortLabel: string | null;
  title: string;
  summary: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
  isPositive: boolean;
  isNew: boolean;
  isArchived: boolean;
  hasAttachments: boolean;
  eventAt: string;
  syncedAt: string;
  linkPath: string;
}

/**
 * The current year alone: counts, and every staleness signal.
 *
 * Cross-child, so it is the per-connection pair shape -- each school's
 * children at that school's year. A single household-wide year hides the other
 * school's children every September.
 */
type YearScope = StudentYearScope;
/** The configured history window: the lists, where more data is the point. */
type HistoryWhere = StudentYearScope;

export interface ChildCard {
  studentGuid: string;
  privateName: string;
  familyName: string;
  fullName: string;
  classCode: string;
  classNum: number;
  recentHomeworkCount: number;
  recentBehaviorCount: number;
  positiveBehaviorCount: number;
  latestUpdateAt: string | null;
  oneLineStatus: string;
  /** `null` for a child with no ownership stamp: the UI shows no badge. */
  schoolId: string | null;
  schoolShortLabel: string | null;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
    private readonly sessionService: MashovSessionService,
    private readonly userItemStateService: UserItemStateService,
    private readonly configService: ConfigService,
  ) {}

  async getDashboard(userId?: string) {
    await this.sessionService.ensureStudentsAvailable(userId);

    // Two scopes, deliberately: the lists span the history window, while the
    // counts and `latestUpdateAt` stay on the current year. In September the
    // feed therefore shows last year's items rather than being empty, and
    // `latestUpdateAt` is what still reports the new year as quiet.
    const yearScope = await yearScopeForStudents(this.prisma, userId);
    const windowScope = await historyScopeForStudents(
      this.prisma,
      this.configService,
      userId,
    );

    // Resolved once here rather than inside each reader: both `getSummary` and
    // `getFeed` need it, both are private and called only from here, so the
    // query count stays flat.
    const mailScope = await householdMailScope(this.prisma, userId);

    const [students, summary, feed, freshness, school] = await Promise.all([
      this.getChildren(yearScope, userId),
      this.getSummary(yearScope, mailScope, userId),
      this.getFeed(windowScope, mailScope, userId),
      this.getFreshness(),
      this.getSchoolInfo(),
    ]);

    return {
      freshness,
      summary,
      feed,
      children: students,
      school,
    };
  }

  private async getSummary(
    yearScope: YearScope,
    mailScope: Prisma.MailConversationWhereInput,
    userId?: string,
  ) {
    const [localNewConversations, household, students, recentHomework, recentBehavior] = await Promise.all([
      this.prisma.mailConversation.count({
        where: {
          isUnread: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      }),
      // Summed over the CALLER's connections. Reading one row showed one
      // school's mail and hid the other's; reading every household's row
      // showed a stranger's.
      this.prisma.householdConnection.aggregate({
        where: { active: true, ...(userId ? { userId } : {}) },
        _sum: { cachedNewCount: true },
        _count: { _all: true },
      }),
      // childrenCount is the caller's children, not everyone's. It feeds the
      // "N children" line on the dashboard.
      this.prisma.student.count({
        where: { isActive: true, ...(await this.householdStudentWhere(userId)) },
      }),
      this.prisma.homeworkItem.count({
        where: {
          lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          ...yearScope,
        },
      }),
      this.prisma.behaviorItem.count({
        where: {
          lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          classification: { not: 'positive' },
          ...yearScope,
        },
      }),
    ]);
    // `_count` separates "no connections, so fall back to the local count"
    // from "connections whose counts genuinely sum to zero": _sum is null in
    // both cases, and without the distinction an emptied inbox would fall back
    // to a count that need not be zero.
    const newConversations =
      household._count._all > 0
        ? household._sum.cachedNewCount ?? 0
        : localNewConversations;

    return {
      newConversations,
      recentHomeworkCount: recentHomework,
      recentBehaviorCount: recentBehavior,
      childrenCount: students,
    };
  }

  private async getFeed(
    yearScope: HistoryWhere,
    mailScope: Prisma.MailConversationWhereInput,
    userId?: string,
  ): Promise<FeedItem[]> {
    const students = await this.prisma.student.findMany({
      where: {
        isActive: true,
        ...(await this.householdStudentWhere(userId)),
      },
      select: { studentGuid: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.studentGuid, s.fullName]));
    // Built alongside the name map, from the same rows, so a feed item can
    // say which school it came from without a second query per item.
    const schoolMap = await buildStudentSchoolMap(this.prisma, students);

    const [homework, behaviors, conversations] = await Promise.all([
      this.prisma.homeworkItem.findMany({
        where: yearScope,
        orderBy: { lessonDate: 'desc' },
        take: 20,
      }),
      this.prisma.behaviorItem.findMany({
        where: yearScope,
        orderBy: { eventAt: 'desc' },
        take: 20,
      }),
      // R3: this read had no `where` at all, so another household's mail
      // subjects and sender-name previews rendered as feed items on `/home` --
      // with `schoolId: null`, so the school chip could not even hide them.
      this.prisma.mailConversation.findMany({
        where: mailScope,
        orderBy: { sendTime: 'desc' },
        take: 20,
      }),
    ]);

    const homeworkIds = homework.map((hw) => hw.id);
    const behaviorIds = behaviors.map((b) => b.id);
    const [hwStateMap, bStateMap] = userId
      ? await Promise.all([
          this.userItemStateService.getStateBatch(userId, 'homework', homeworkIds),
          this.userItemStateService.getStateBatch(userId, 'behavior', behaviorIds),
        ])
      : [new Map(), new Map()];
    const defaultState = { isNew: true, isArchived: false };

    const allItems: FeedItem[] = [];

    for (const hw of homework) {
      const hwState = hwStateMap.get(hw.id) ?? defaultState;
      allItems.push({
        id: hw.id,
        sourceId: hw.id,
        sourceType: 'homework',
        title: `${hw.subjectName}: ${hw.homeworkText.substring(0, 60)}`,
        summary: hw.homeworkText,
        studentGuid: hw.studentGuid,
        studentName: studentMap.get(hw.studentGuid) ?? null,
        schoolId: schoolMap.get(hw.studentGuid)?.schoolId ?? null,
        schoolShortLabel:
          schoolMap.get(hw.studentGuid)?.shortLabel ?? null,
        category: 'homework',
        priority: 'medium',
        isPositive: false,
        isNew: hwState.isNew,
        isArchived: hwState.isArchived,
        hasAttachments: Array.isArray(hw.files) && hw.files.length > 0,
        eventAt: hw.lessonDate.toISOString(),
        syncedAt: hw.updatedAt.toISOString(),
        linkPath: `/children/${hw.studentGuid}`,
      });
    }

    for (const b of behaviors) {
      const isPositive = b.classification === 'positive';
      const bState = bStateMap.get(b.id) ?? defaultState;
      allItems.push({
        id: b.id,
        sourceId: b.id,
        sourceType: isPositive ? 'positive' : 'behavior',
        title: b.achvaName,
        summary: b.remark ?? b.achvaName,
        studentGuid: b.studentGuid,
        studentName: studentMap.get(b.studentGuid) ?? null,
        schoolId: schoolMap.get(b.studentGuid)?.schoolId ?? null,
        schoolShortLabel:
          schoolMap.get(b.studentGuid)?.shortLabel ?? null,
        category: 'behavior',
        priority: isPositive ? 'low' : 'high',
        isPositive,
        isNew: bState.isNew,
        isArchived: bState.isArchived,
        hasAttachments: this.extractFilesFromRawPayload(b.rawPayload).length > 0,
        eventAt: b.eventAt.toISOString(),
        syncedAt: b.updatedAt.toISOString(),
        linkPath: `/children/${b.studentGuid}`,
      });
    }

    for (const conv of conversations) {
      allItems.push({
        id: conv.id,
        sourceId: conv.conversationId,
        sourceType: 'mail',
        title: conv.subject,
        summary: conv.senderNamePreview ?? conv.subject,
        studentGuid: null,
        studentName: null,
        // Mail is household-wide: it has no child and therefore no school.
        schoolId: null,
        schoolShortLabel: null,
        category: 'mail',
        priority: conv.isUnread ? 'high' : 'medium',
        isPositive: false,
        isNew: conv.isUnread,
        isArchived: Array.isArray(conv.labels) && conv.labels.includes('archived'),
        hasAttachments: conv.hasAttachments,
        eventAt: conv.sendTime.toISOString(),
        syncedAt: conv.lastFetchedAt.toISOString(),
        linkPath: `/inbox/${conv.conversationId}`,
      });
    }

    allItems.sort((a, b) => new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime());
    return allItems.slice(0, 20);
  }

  private extractFilesFromRawPayload(value: unknown): unknown[] {
    if (!value || typeof value !== 'object') return [];

    const payload = value as Record<string, unknown>;
    const directFiles = payload.files;
    if (Array.isArray(directFiles)) return directFiles;

    const attachments = payload.attachments;
    if (Array.isArray(attachments)) return attachments;

    return [];
  }

  /**
   * The `where` fragment restricting a student list to one household.
   *
   * Reads the visibility edge, not the routing stamp: a child two parents
   * share carries one stamp, so a stamp predicate emptied the dashboard of
   * whichever parent had not synced most recently (ADR-0031). A child with no
   * links is admitted -- no link means "ownership unknown, link on the next
   * roster refresh", not "no owner".
   */
  private async householdStudentWhere(userId?: string) {
    if (!userId) return {};

    return visibleStudentWhere(this.prisma, userId);
  }

  private async getChildren(yearScope: YearScope, userId?: string): Promise<ChildCard[]> {
    const students = await this.prisma.student.findMany({
      where: {
        isActive: true,
        ...(await this.householdStudentWhere(userId)),
      },
      orderBy: { fullName: 'asc' },
    });

    const schoolMap = await buildStudentSchoolMap(this.prisma, students);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const cards: ChildCard[] = await Promise.all(
      students.map(async (student) => {
        const [recentHomeworkRows, recentBehaviorRows, latestHomework, latestBehavior] = await Promise.all([
          this.prisma.homeworkItem.findMany({
            where: {
              studentGuid: student.studentGuid,
              lessonDate: { gte: sevenDaysAgo },
              ...yearScope,
            },
            select: { id: true },
          }),
          this.prisma.behaviorItem.findMany({
            where: {
              studentGuid: student.studentGuid,
              lessonDate: { gte: sevenDaysAgo },
              ...yearScope,
            },
            select: { id: true, classification: true },
          }),
          this.prisma.homeworkItem.findFirst({
            where: { studentGuid: student.studentGuid, ...yearScope },
            orderBy: { lessonDate: 'desc' },
            select: { lessonDate: true },
          }),
          this.prisma.behaviorItem.findFirst({
            where: { studentGuid: student.studentGuid, ...yearScope },
            orderBy: { eventAt: 'desc' },
            select: { eventAt: true },
          }),
        ]);

        const homeworkIds = recentHomeworkRows.map((row) => row.id);
        const behaviorIds = recentBehaviorRows.map((row) => row.id);
        const [homeworkStateMap, behaviorStateMap] = userId
          ? await Promise.all([
              this.userItemStateService.getStateBatch(userId, 'homework', homeworkIds),
              this.userItemStateService.getStateBatch(userId, 'behavior', behaviorIds),
            ])
          : [
              new Map<string, { isNew: boolean; isArchived: boolean }>(),
              new Map<string, { isNew: boolean; isArchived: boolean }>(),
            ];

        const recentHw = recentHomeworkRows.filter((row) =>
          this.isUnreadAndNotArchived(homeworkStateMap.get(row.id)),
        ).length;
        const recentBehavior = recentBehaviorRows.filter((row) =>
          row.classification !== 'positive'
          && this.isUnreadAndNotArchived(behaviorStateMap.get(row.id)),
        ).length;
        const positiveBehavior = recentBehaviorRows.filter((row) =>
          row.classification === 'positive'
          && this.isUnreadAndNotArchived(behaviorStateMap.get(row.id)),
        ).length;

        // Deliberately excludes student.updatedAt — it bumps on every sign-in
        // and would report content as fresh that is a school year old.
        const latestUpdateAt = [
          latestHomework?.lessonDate ?? null,
          latestBehavior?.eventAt ?? null,
        ]
          .filter((value): value is Date => value instanceof Date)
          .sort((a, b) => b.getTime() - a.getTime())[0]
          ?.toISOString() ?? null;

        const statusParts: string[] = [];
        if (recentHw > 0) statusParts.push(`${recentHw} homework`);
        if (recentBehavior > 0) statusParts.push(`${recentBehavior} behavior`);
        if (positiveBehavior > 0) statusParts.push(`${positiveBehavior} positive`);
        const oneLineStatus =
          statusParts.length > 0 ? statusParts.join(', ') : 'אין פעילות אחרונה';

        return {
          studentGuid: student.studentGuid,
          privateName: student.privateName,
          familyName: student.familyName,
          fullName: student.fullName,
          classCode: student.classCode,
          classNum: student.classNum,
          recentHomeworkCount: recentHw,
          recentBehaviorCount: recentBehavior,
          positiveBehaviorCount: positiveBehavior,
          latestUpdateAt,
          oneLineStatus,
          schoolId: schoolMap.get(student.studentGuid)?.schoolId ?? null,
          schoolShortLabel: schoolMap.get(student.studentGuid)?.shortLabel ?? null,
        };
      }),
    );

    return cards;
  }

  private async getFreshness() {
    const result = await this.freshnessService.computeFreshness();
    return {
      state: result.state,
      lastSyncAt: result.lastSyncAt,
      staleSources: result.staleSources,
    };
  }

  private async getSchoolInfo() {
    const household = await this.prisma.householdConnection.findFirst({
      where: { active: true },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      select: { schoolName: true, schoolYear: true },
    });

    return {
      schoolName: household?.schoolName ?? '',
      schoolYear: household?.schoolYear ?? new Date().getFullYear(),
    };
  }

  private isUnreadAndNotArchived(
    state: { isNew: boolean; isArchived: boolean } | undefined,
  ): boolean {
    const effectiveState = state ?? { isNew: true, isArchived: false };
    return effectiveState.isNew && !effectiveState.isArchived;
  }
}
