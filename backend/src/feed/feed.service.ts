import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class FeedService {
  constructor(private readonly prisma: PrismaService) {}

  async getFeed(page: number, limit: number) {
    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      select: { studentGuid: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.studentGuid, s.fullName]));

    const [notifications, homework, behaviors, conversations] = await Promise.all([
      this.prisma.notificationEvent.findMany({
        orderBy: { eventAt: 'desc' },
      }),
      this.prisma.homeworkItem.findMany({
        orderBy: { lessonDate: 'desc' },
      }),
      this.prisma.behaviorItem.findMany({
        orderBy: { eventAt: 'desc' },
      }),
      this.prisma.mailConversation.findMany({
        orderBy: { sendTime: 'desc' },
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

    const total = allItems.length;
    const totalPages = Math.ceil(total / limit);
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
