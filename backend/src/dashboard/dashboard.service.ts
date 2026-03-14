import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from '../sync/freshness.service';
import { SessionService } from '../session/session.service';

export interface NeedsAttentionItem {
  id: string;
  type: 'new_conversation' | 'negative_behavior' | 'new_homework' | 'sync_degraded';
  title: string;
  summary: string;
  studentGuid: string | null;
  studentName: string | null;
  timestamp: string;
  linkPath: string;
}

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
  eventAt: string;
  syncedAt: string;
  linkPath: string;
}

export interface ChildCard {
  studentGuid: string;
  privateName: string;
  familyName: string;
  fullName: string;
  classCode: string;
  classNum: number;
  recentHomeworkCount: number;
  recentBehaviorCount: number;
  latestUpdateAt: string | null;
  oneLineStatus: string;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
    private readonly sessionService: SessionService,
  ) {}

  async getDashboard() {
    await this.sessionService.ensureStudentsAvailable();

    const [students, summary, feed, freshness, school] = await Promise.all([
      this.getChildren(),
      this.getSummary(),
      this.getFeed(),
      this.getFreshness(),
      this.getSchoolInfo(),
    ]);
    const needsAttention = await this.getNeedsAttention(freshness);

    return {
      freshness,
      summary,
      needsAttention,
      feed,
      children: students,
      school,
    };
  }

  private async getSummary() {
    const [household, newFallback, students, recentHomework, recentBehavior] = await Promise.all([
      this.prisma.householdConnection.findFirst({
        where: { active: true },
        orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
        select: { cachedNewCount: true },
      }),
      this.prisma.mailConversation.count({
        where: {
          isNew: true,
          NOT: { labels: { array_contains: ['archived'] } },
        },
      }),
      this.prisma.student.count({ where: { isActive: true } }),
      this.prisma.homeworkItem.count({
        where: {
          isArchived: false,
          lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.behaviorItem.count({
        where: {
          isArchived: false,
          lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          classification: { not: 'positive' },
        },
      }),
    ]);

    const newConversations = household?.cachedNewCount ?? newFallback;

    return {
      newConversations,
      recentHomeworkCount: recentHomework,
      recentBehaviorCount: recentBehavior,
      childrenCount: students,
    };
  }

  private async getNeedsAttention(freshness: {
    state: 'fresh' | 'syncing' | 'stale' | 'degraded';
    lastSyncAt: string | null;
    staleSources: string[];
  }): Promise<NeedsAttentionItem[]> {
    const items: NeedsAttentionItem[] = [];

    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      select: { studentGuid: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.studentGuid, s.fullName]));

    // Priority 1: new (unread) conversations
    const conversations = await this.prisma.mailConversation.findMany({
      where: {
        isNew: true,
        NOT: { labels: { array_contains: ['archived'] } },
      },
      orderBy: { sendTime: 'desc' },
      take: 3,
    });
    for (const conv of conversations) {
      items.push({
        id: conv.id,
        type: 'new_conversation',
        title: conv.subject,
        summary: conv.senderNamePreview ?? 'הודעה שלא נקראה',
        studentGuid: null,
        studentName: null,
        timestamp: conv.sendTime.toISOString(),
        linkPath: `/inbox/${conv.conversationId}`,
      });
    }

    if (items.length >= 5) return items.slice(0, 5);

    // Priority 2: negative behavior (not positive, not neutral)
    const behaviors = await this.prisma.behaviorItem.findMany({
      where: {
        isNew: true,
        isArchived: false,
        classification: 'attention',
        lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { eventAt: 'desc' },
      take: 5 - items.length,
    });
    for (const b of behaviors) {
      items.push({
        id: b.id,
        type: 'negative_behavior',
        title: b.achvaName,
        summary: b.remark ?? b.subject,
        studentGuid: b.studentGuid,
        studentName: studentMap.get(b.studentGuid) ?? null,
        timestamp: b.eventAt.toISOString(),
        linkPath: `/children/${b.studentGuid}`,
      });
    }

    if (items.length >= 5) return items.slice(0, 5);

    // Priority 3: recent new homework
    const homework = await this.prisma.homeworkItem.findMany({
      where: {
        isNew: true,
        isArchived: false,
        lessonDate: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { lessonDate: 'desc' },
      take: 5 - items.length,
    });
    for (const hw of homework) {
      items.push({
        id: hw.id,
        type: 'new_homework',
        title: `${hw.subjectName}: שיעורי בית`,
        summary: hw.homeworkText,
        studentGuid: hw.studentGuid,
        studentName: studentMap.get(hw.studentGuid) ?? null,
        timestamp: hw.lessonDate.toISOString(),
        linkPath: `/children/${hw.studentGuid}`,
      });
    }

    if (items.length < 5 && freshness.state === 'degraded') {
      items.push({
        id: 'sync-degraded',
        type: 'sync_degraded',
        title: 'סנכרון חלקי',
        summary:
          freshness.staleSources.length > 0
            ? `מקורות מיושנים: ${freshness.staleSources.join(', ')}`
            : 'חלק מהמקורות לא התעדכנו לאחרונה',
        studentGuid: null,
        studentName: null,
        timestamp: freshness.lastSyncAt ?? new Date().toISOString(),
        linkPath: '/more',
      });
    }

    return items.slice(0, 5);
  }

  private async getFeed(): Promise<FeedItem[]> {
    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      select: { studentGuid: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.studentGuid, s.fullName]));

    const [homework, behaviors, conversations] = await Promise.all([
      this.prisma.homeworkItem.findMany({
        where: { isArchived: false },
        orderBy: { lessonDate: 'desc' },
        take: 20,
      }),
      this.prisma.behaviorItem.findMany({
        where: { isArchived: false },
        orderBy: { eventAt: 'desc' },
        take: 20,
      }),
      this.prisma.mailConversation.findMany({
        where: {
          NOT: { labels: { array_contains: ['archived'] } },
        },
        orderBy: { sendTime: 'desc' },
        take: 20,
      }),
    ]);

    const allItems: FeedItem[] = [];

    for (const hw of homework) {
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
        isNew: hw.isNew,
        isArchived: hw.isArchived,
        eventAt: hw.lessonDate.toISOString(),
        syncedAt: hw.updatedAt.toISOString(),
        linkPath: `/children/${hw.studentGuid}`,
      });
    }

    for (const b of behaviors) {
      const isPositive = b.classification === 'positive';
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
        isNew: b.isNew,
        isArchived: b.isArchived,
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
        priority: conv.isNew ? 'high' : 'medium',
        isPositive: false,
        isNew: conv.isNew,
        isArchived: false,
        eventAt: conv.sendTime.toISOString(),
        syncedAt: conv.lastFetchedAt.toISOString(),
        linkPath: `/inbox/${conv.conversationId}`,
      });
    }

    allItems.sort((a, b) => new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime());
    return allItems.slice(0, 20);
  }

  private async getChildren(): Promise<ChildCard[]> {
    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      orderBy: { fullName: 'asc' },
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const cards: ChildCard[] = await Promise.all(
      students.map(async (student) => {
        const [recentHw, recentBehavior, latestHomework, latestBehavior] = await Promise.all([
          this.prisma.homeworkItem.count({
            where: {
              studentGuid: student.studentGuid,
              isArchived: false,
              lessonDate: { gte: sevenDaysAgo },
            },
          }),
          this.prisma.behaviorItem.count({
            where: {
              studentGuid: student.studentGuid,
              isArchived: false,
              lessonDate: { gte: sevenDaysAgo },
              classification: { not: 'positive' },
            },
          }),
          this.prisma.homeworkItem.findFirst({
            where: { studentGuid: student.studentGuid },
            orderBy: { lessonDate: 'desc' },
            select: { lessonDate: true },
          }),
          this.prisma.behaviorItem.findFirst({
            where: { studentGuid: student.studentGuid },
            orderBy: { eventAt: 'desc' },
            select: { eventAt: true },
          }),
        ]);

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
        const oneLineStatus =
          statusParts.length > 0 ? statusParts.join(', ') : 'No recent activity';

        return {
          studentGuid: student.studentGuid,
          privateName: student.privateName,
          familyName: student.familyName,
          fullName: student.fullName,
          classCode: student.classCode,
          classNum: student.classNum,
          recentHomeworkCount: recentHw,
          recentBehaviorCount: recentBehavior,
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
}
