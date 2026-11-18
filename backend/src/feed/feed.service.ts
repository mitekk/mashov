import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { buildStudentSchoolMap } from '../common/student-school-map';
import {
  historyScopeForStudents,
} from '../common/school-year/school-year.scope';

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
  isUnread: boolean;
  isHandled: boolean;
  hasAttachments: boolean;
  eventAt: string;
  syncedAt: string;
  linkPath: string;
}

@Injectable()
export class FeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async getFeed(page: number, limit: number, userId?: string) {
    // The feed is a list, so spanning the configured history window is the
    // point: more data is the feature. It is bounded at both ends, so an
    // unbounded `orderBy desc` still cannot reach a year nobody asked for.
    // Mail is deliberately not year-scoped — mailConversation carries no
    // schoolYear — and the backfill does not fetch it.
    // Cross-child, so each school contributes its own children at its own
    // window rather than the household sharing one.
    const yearScope = await historyScopeForStudents(
      this.prisma,
      this.configService,
      userId,
    );

    const students = await this.prisma.student.findMany({
      where: { isActive: true },
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
      }),
      this.prisma.behaviorItem.findMany({
        where: yearScope,
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
        schoolId: schoolMap.get(hw.studentGuid)?.schoolId ?? null,
        schoolShortLabel:
          schoolMap.get(hw.studentGuid)?.shortLabel ?? null,
        title: `${hw.subjectName}: ${hw.homeworkText.substring(0, 60)}`,
        summary: hw.homeworkText,
        category: 'homework',
        priority: 'medium',
        isPositive: false,
        isUnread: false,
        isHandled: false,
        hasAttachments: Array.isArray(hw.files) && hw.files.length > 0,
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
        schoolId: schoolMap.get(b.studentGuid)?.schoolId ?? null,
        schoolShortLabel:
          schoolMap.get(b.studentGuid)?.shortLabel ?? null,
        title: b.achvaName,
        summary: b.remark ?? b.achvaName,
        category: 'behavior',
        priority: isPositive ? 'low' : 'high',
        isPositive,
        isUnread: false,
        isHandled: false,
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
        studentGuid: null,
        studentName: null,
        // Mail is household-wide: it has no child and therefore no school.
        schoolId: null,
        schoolShortLabel: null,
        title: conv.subject,
        summary: conv.senderNamePreview ?? conv.subject,
        category: 'mail',
        priority: conv.isUnread ? 'high' : 'medium',
        isPositive: false,
        isUnread: conv.isUnread,
        isHandled: Array.isArray(conv.labels) && conv.labels.includes('archived'),
        hasAttachments: conv.hasAttachments,
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

  private extractFilesFromRawPayload(value: unknown): unknown[] {
    if (!value || typeof value !== 'object') return [];

    const payload = value as Record<string, unknown>;
    const directFiles = payload.files;
    if (Array.isArray(directFiles)) return directFiles;

    const attachments = payload.attachments;
    if (Array.isArray(attachments)) return attachments;

    return [];
  }
}
