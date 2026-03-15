import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class FeedService {
  constructor(private readonly prisma: PrismaService) {}

  async getFeed(page: number, limit: number) {
    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      select: { studentGuid: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.studentGuid, s.fullName]));

    const [homework, behaviors, conversations] = await Promise.all([
      this.prisma.homeworkItem.findMany({
        where: { isArchived: false },
        orderBy: { lessonDate: 'desc' },
      }),
      this.prisma.behaviorItem.findMany({
        where: { isArchived: false },
        orderBy: { eventAt: 'desc' },
      }),
      this.prisma.mailConversation.findMany({
        where: {
          NOT: { labels: { array_contains: ['archived'] } },
        },
        orderBy: { sendTime: 'desc' },
      }),
    ]);

    const allItems: FeedItem[] = [];

    for (const hw of homework) {
      allItems.push({
        id: hw.id,
        sourceId: hw.id,
        sourceType: 'homework',
        studentGuid: hw.studentGuid,
        studentName: studentMap.get(hw.studentGuid) ?? null,
        title: `${hw.subjectName}: ${hw.homeworkText.substring(0, 60)}`,
        summary: hw.homeworkText,
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
        studentGuid: b.studentGuid,
        studentName: studentMap.get(b.studentGuid) ?? null,
        title: b.achvaName,
        summary: b.remark ?? b.achvaName,
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
        studentGuid: null,
        studentName: null,
        title: conv.subject,
        summary: conv.senderNamePreview ?? conv.subject,
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

    const total = allItems.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const data = allItems.slice(offset, offset + limit);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }
}
