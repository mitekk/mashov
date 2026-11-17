import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from '../sync/freshness.service';
import { MashovSessionService } from '../session/mashov-session.service';
import { UserItemStateService } from '../common/user-item-state.service';
import {
  currentSchoolYearFor,
  schoolYearScope,
} from '../common/school-year/school-year.scope';

export interface FeedItem {
  id: string;
  sourceType: 'homework' | 'behavior' | 'mail' | 'positive';
  sourceId: string;
  studentGuid: string | null;
  studentName: string | null;
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

type YearScope = { schoolYear: { in: number[] } };

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
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
    private readonly sessionService: MashovSessionService,
    private readonly userItemStateService: UserItemStateService,
  ) {}

  async getDashboard(userId?: string) {
    await this.sessionService.ensureStudentsAvailable(userId);

    const yearScope = schoolYearScope(await currentSchoolYearFor(this.prisma, userId));

    const [students, summary, feed, freshness, school] = await Promise.all([
      this.getChildren(yearScope, userId),
      this.getSummary(yearScope),
      this.getFeed(yearScope, userId),
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

  private async getSummary(yearScope: YearScope) {
    const [localNewConversations, household, students, recentHomework, recentBehavior] = await Promise.all([
      this.prisma.mailConversation.count({
        where: {
          isUnread: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      }),
      this.prisma.householdConnection.findFirst({
        where: { active: true },
        orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
        select: { cachedNewCount: true },
      }),
      this.prisma.student.count({ where: { isActive: true } }),
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
    const newConversations = household?.cachedNewCount ?? localNewConversations;

    return {
      newConversations,
      recentHomeworkCount: recentHomework,
      recentBehaviorCount: recentBehavior,
      childrenCount: students,
    };
  }

  private async getFeed(yearScope: YearScope, userId?: string): Promise<FeedItem[]> {
    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      select: { studentGuid: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.studentGuid, s.fullName]));

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
      this.prisma.mailConversation.findMany({
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

  private async getChildren(yearScope: YearScope, userId?: string): Promise<ChildCard[]> {
    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      orderBy: { fullName: 'asc' },
    });

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

        const latestUpdateAt = [
          student.updatedAt,
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
