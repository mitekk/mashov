import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from '../sync/freshness.service';

export interface NeedsAttentionItem {
  id: string;
  type: string;
  title: string;
  childName: string | null;
  timestamp: string;
  priority: string;
  referenceId: string;
}

export interface FeedItem {
  id: string;
  sourceType: string;
  title: string;
  summary: string;
  childName: string | null;
  timestamp: string;
  isUnread: boolean;
  isHandled: boolean;
  category: string;
  isPositive: boolean;
}

export interface ChildCard {
  studentGuid: string;
  fullName: string;
  classCode: string;
  classNum: number;
  latestUpdateAt: string | null;
  recentUpdateCount: number;
  statusLine: string;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
  ) {}

  async getDashboard() {
    const [students, summary, needsAttention, feed, freshness] = await Promise.all([
      this.getChildren(),
      this.getSummary(),
      this.getNeedsAttention(),
      this.getFeed(),
      this.getFreshness(),
    ]);

    return {
      summary,
      needsAttention,
      feed,
      children: students,
      freshness,
    };
  }

  private async getSummary() {
    const [unreadConversations, students, recentHomework, recentBehavior] = await Promise.all([
      this.prisma.mailConversation.count({ where: { isUnread: true } }),
      this.prisma.student.count({ where: { isActive: true } }),
      this.prisma.homeworkItem.count({
        where: {
          lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.behaviorItem.count({
        where: {
          lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          classification: { not: 'positive' },
        },
      }),
    ]);

    return {
      unreadConversations,
      recentHomeworkCount: recentHomework,
      recentBehaviorCount: recentBehavior,
      childrenCount: students,
    };
  }

  private async getNeedsAttention(): Promise<NeedsAttentionItem[]> {
    const items: NeedsAttentionItem[] = [];

    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      select: { studentGuid: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.studentGuid, s.fullName]));

    // Priority 1: unread conversations
    const conversations = await this.prisma.mailConversation.findMany({
      where: { isUnread: true },
      orderBy: { sendTime: 'desc' },
      take: 3,
    });
    for (const conv of conversations) {
      items.push({
        id: conv.id,
        type: 'conversation',
        title: conv.subject,
        childName: null,
        timestamp: conv.sendTime.toISOString(),
        priority: 'high',
        referenceId: conv.conversationId,
      });
    }

    if (items.length >= 5) return items.slice(0, 5);

    // Priority 2: negative behavior (not positive, not neutral)
    const behaviors = await this.prisma.behaviorItem.findMany({
      where: {
        classification: 'attention',
        lessonDate: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { eventAt: 'desc' },
      take: 5 - items.length,
    });
    for (const b of behaviors) {
      items.push({
        id: b.id,
        type: 'behavior',
        title: b.achvaName,
        childName: studentMap.get(b.studentGuid) ?? null,
        timestamp: b.eventAt.toISOString(),
        priority: 'medium',
        referenceId: b.id,
      });
    }

    if (items.length >= 5) return items.slice(0, 5);

    // Priority 3: recent homework
    const homework = await this.prisma.homeworkItem.findMany({
      where: {
        lessonDate: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { lessonDate: 'desc' },
      take: 5 - items.length,
    });
    for (const hw of homework) {
      items.push({
        id: hw.id,
        type: 'homework',
        title: `${hw.subjectName} homework`,
        childName: studentMap.get(hw.studentGuid) ?? null,
        timestamp: hw.lessonDate.toISOString(),
        priority: 'low',
        referenceId: hw.id,
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

    const [notifications, homework, behaviors, conversations] = await Promise.all([
      this.prisma.notificationEvent.findMany({
        orderBy: { eventAt: 'desc' },
        take: 20,
      }),
      this.prisma.homeworkItem.findMany({
        orderBy: { lessonDate: 'desc' },
        take: 20,
      }),
      this.prisma.behaviorItem.findMany({
        orderBy: { eventAt: 'desc' },
        take: 20,
      }),
      this.prisma.mailConversation.findMany({
        orderBy: { sendTime: 'desc' },
        take: 20,
      }),
    ]);

    const allItems: FeedItem[] = [];

    for (const n of notifications) {
      allItems.push({
        id: n.id,
        sourceType: 'notification',
        title: n.eventText,
        summary: n.eventText,
        childName: n.studentGuid ? (studentMap.get(n.studentGuid) ?? null) : null,
        timestamp: n.eventAt.toISOString(),
        isUnread: n.readTime === null,
        isHandled: false,
        category: 'notification',
        isPositive: false,
      });
    }

    for (const hw of homework) {
      allItems.push({
        id: hw.id,
        sourceType: 'homework',
        title: `${hw.subjectName}: ${hw.homeworkText.substring(0, 60)}`,
        summary: hw.homeworkText,
        childName: studentMap.get(hw.studentGuid) ?? null,
        timestamp: hw.lessonDate.toISOString(),
        isUnread: false,
        isHandled: false,
        category: 'homework',
        isPositive: false,
      });
    }

    for (const b of behaviors) {
      allItems.push({
        id: b.id,
        sourceType: 'behavior',
        title: b.achvaName,
        summary: b.remark ?? b.achvaName,
        childName: studentMap.get(b.studentGuid) ?? null,
        timestamp: b.eventAt.toISOString(),
        isUnread: false,
        isHandled: false,
        category: 'behavior',
        isPositive: b.classification === 'positive',
      });
    }

    for (const conv of conversations) {
      allItems.push({
        id: conv.id,
        sourceType: 'mail',
        title: conv.subject,
        summary: conv.senderNamePreview ?? conv.subject,
        childName: null,
        timestamp: conv.sendTime.toISOString(),
        isUnread: conv.isUnread,
        isHandled: false,
        category: 'mail',
        isPositive: false,
      });
    }

    allItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
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
        const [recentHw, recentBehavior] = await Promise.all([
          this.prisma.homeworkItem.count({
            where: {
              studentGuid: student.studentGuid,
              lessonDate: { gte: sevenDaysAgo },
            },
          }),
          this.prisma.behaviorItem.findFirst({
            where: { studentGuid: student.studentGuid },
            orderBy: { eventAt: 'desc' },
            select: { eventAt: true },
          }),
        ]);

        const latestUpdateAt = student.updatedAt?.toISOString() ?? null;

        const statusParts: string[] = [];
        if (recentHw > 0) statusParts.push(`${recentHw} homework`);
        if (recentBehavior) statusParts.push('behavior noted');
        const statusLine = statusParts.length > 0 ? statusParts.join(', ') : 'No recent activity';

        return {
          studentGuid: student.studentGuid,
          fullName: student.fullName,
          classCode: student.classCode,
          classNum: student.classNum,
          latestUpdateAt,
          recentUpdateCount: recentHw,
          statusLine,
        };
      }),
    );

    return cards;
  }

  private async getFreshness() {
    const result = await this.freshnessService.computeFreshness();
    return {
      status: result.state,
      lastSuccessfulSyncAt: result.lastSyncAt,
      staleSources: result.staleSources,
    };
  }
}
