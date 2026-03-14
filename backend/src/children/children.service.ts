import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';

const BEHAVIOR_PRIORITY_MAP: Record<number, 'high' | 'medium' | 'low'> = {
  1: 'medium',
  2: 'high',
  4: 'low',
  5: 'high',
  6: 'medium',
  10: 'medium',
  11: 'low',
};

@Injectable()
export class ChildrenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  async getChildren() {
    await this.sessionService.ensureStudentsAvailable();

    const students = await this.prisma.student.findMany({
      where: { isActive: true },
      orderBy: { fullName: 'asc' },
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const data = await Promise.all(
      students.map(async (student) => {
        const [recentHomeworkCount, recentBehaviorCount, subjectCount, latestHomework, latestBehavior] =
          await Promise.all([
            this.prisma.homeworkItem.count({
              where: {
                studentGuid: student.studentGuid,
                lessonDate: { gte: sevenDaysAgo },
              },
            }),
            this.prisma.behaviorItem.count({
              where: {
                studentGuid: student.studentGuid,
                lessonDate: { gte: sevenDaysAgo },
                classification: { not: 'positive' },
              },
            }),
            this.prisma.subjectEnrollment.count({
              where: { studentGuid: student.studentGuid },
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

        const latestUpdateAt =
          [
            student.updatedAt,
            latestHomework?.lessonDate ?? null,
            latestBehavior?.eventAt ?? null,
          ]
            .filter((value): value is Date => value instanceof Date)
            .sort((a, b) => b.getTime() - a.getTime())[0]
            ?.toISOString() ?? null;

        return {
          studentGuid: student.studentGuid,
          privateName: student.privateName,
          familyName: student.familyName,
          fullName: student.fullName,
          classCode: student.classCode,
          classNum: student.classNum,
          gender: student.gender,
          isActive: student.isActive,
          recentHomeworkCount,
          recentBehaviorCount,
          subjectCount,
          latestUpdateAt,
        };
      }),
    );

    return { data };
  }

  async getChildWorkspace(studentGuid: string) {
    const student = await this.getStudentOrThrow(studentGuid);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      recentHomeworkCount,
      recentBehaviorCount,
      subjectCount,
      totalWeeklyHours,
      attentionBehaviorCount,
      lastSync,
    ] = await Promise.all([
      this.prisma.homeworkItem.count({
        where: {
          studentGuid,
          lessonDate: { gte: sevenDaysAgo },
        },
      }),
      this.prisma.behaviorItem.count({
        where: {
          studentGuid,
          lessonDate: { gte: sevenDaysAgo },
          classification: { not: 'positive' },
        },
      }),
      this.prisma.subjectEnrollment.count({
        where: { studentGuid },
      }),
      this.prisma.subjectEnrollment.aggregate({
        where: { studentGuid },
        _sum: { weeklyHours: true },
      }),
      this.prisma.behaviorItem.count({
        where: {
          studentGuid,
          lessonDate: { gte: sevenDaysAgo },
          classification: 'attention',
        },
      }),
      this.prisma.syncRun.findFirst({
        where: {
          source: {
            in: [
              `homework:${studentGuid}`,
              `behavior:${studentGuid}`,
              `groups:${studentGuid}`,
              `lessons_count:${studentGuid}`,
              `message_board:${studentGuid}`,
            ],
          },
          status: 'success',
        },
        orderBy: { endedAt: 'desc' },
        select: { endedAt: true },
      }),
    ]);

    return {
      student: {
        studentGuid: student.studentGuid,
        privateName: student.privateName,
        familyName: student.familyName,
        fullName: student.fullName,
        classCode: student.classCode,
        classNum: student.classNum,
        gender: student.gender,
        isActive: student.isActive,
      },
      summary: {
        recentHomeworkCount,
        recentBehaviorCount,
        subjectCount,
        totalWeeklyHours: totalWeeklyHours._sum.weeklyHours ?? 0,
        attentionBehaviorCount,
      },
      lastSyncAt: lastSync?.endedAt?.toISOString() ?? null,
    };
  }

  async getHomework(studentGuid: string, page: number, limit: number) {
    await this.requireStudent(studentGuid);

    const [items, total] = await Promise.all([
      this.prisma.homeworkItem.findMany({
        where: { studentGuid },
        orderBy: { lessonDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.homeworkItem.count({ where: { studentGuid } }),
    ]);

    const handledMap = await this.getHandledMap('homework', items.map((item) => item.id));

    return {
      data: items.map((item) => this.mapHomeworkItem(item, handledMap.get(item.id) ?? false)),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async getHomeworkDetail(studentGuid: string, homeworkId: string) {
    await this.requireStudent(studentGuid);

    const item = await this.prisma.homeworkItem.findUnique({
      where: { id: homeworkId },
    });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    const handledMap = await this.getHandledMap('homework', [item.id]);
    return this.mapHomeworkItem(item, handledMap.get(item.id) ?? false);
  }

  async getBehavior(
    studentGuid: string,
    page: number,
    limit: number,
    bucket: 'all' | 'attention' | 'positive' | 'neutral',
  ) {
    await this.requireStudent(studentGuid);

    const where = {
      studentGuid,
      ...(bucket !== 'all' ? { classification: bucket } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.behaviorItem.findMany({
        where,
        orderBy: { eventAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.behaviorItem.count({ where }),
    ]);

    const handledMap = await this.getHandledMap('behavior', items.map((item) => item.id));

    return {
      data: items.map((item) => this.mapBehaviorItem(item, handledMap.get(item.id) ?? false)),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async getBehaviorDetail(studentGuid: string, behaviorId: string) {
    await this.requireStudent(studentGuid);

    const item = await this.prisma.behaviorItem.findUnique({
      where: { id: behaviorId },
    });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    const handledMap = await this.getHandledMap('behavior', [item.id]);
    return this.mapBehaviorItem(item, handledMap.get(item.id) ?? false);
  }

  async getSubjects(studentGuid: string) {
    await this.requireStudent(studentGuid);

    const items = await this.prisma.subjectEnrollment.findMany({
      where: { studentGuid },
      orderBy: { subjectName: 'asc' },
    });

    return {
      data: items.map((item) => ({
        id: item.id,
        studentGuid: item.studentGuid,
        groupId: item.groupId,
        groupName: item.groupName,
        subjectName: item.subjectName,
        teachers: this.asArray(item.teachers),
        inactiveTeachers: this.asArray(item.inactiveTeachers),
        weeklyHours: item.weeklyHours,
        lessonsCount: item.lessonsCount,
        updatedAt: item.updatedAt.toISOString(),
      })),
    };
  }

  async getNotices(studentGuid: string) {
    await this.requireStudent(studentGuid);

    const now = new Date();
    const items = await this.prisma.messageBoardItem.findMany({
      where: {
        studentGuid,
        expirationDate: { gt: now },
      },
      orderBy: { expirationDate: 'asc' },
    });

    return {
      data: items.map((item) => ({
        id: item.id,
        studentGuid: item.studentGuid,
        eventId: item.eventId,
        eventText: item.eventText,
        expirationDate: item.expirationDate.toISOString(),
        inSite: item.inSite,
        updatedAt: item.updatedAt.toISOString(),
      })),
    };
  }

  private mapHomeworkItem(item: {
    id: string;
    studentGuid: string;
    lessonId: number;
    groupId: number;
    lessonDate: Date;
    lesson: number;
    subjectName: string;
    homeworkText: string;
    remark: string | null;
    files: unknown;
    updatedAt: Date;
  }, isHandled: boolean) {
    return {
      id: item.id,
      studentGuid: item.studentGuid,
      lessonId: item.lessonId,
      groupId: item.groupId,
      lessonDate: item.lessonDate.toISOString(),
      lesson: item.lesson,
      subjectName: item.subjectName,
      homeworkText: item.homeworkText,
      remark: item.remark,
      files: this.asArray(item.files),
      isHandled,
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private mapBehaviorItem(item: {
    id: string;
    studentGuid: string;
    lessonId: number;
    groupId: number;
    eventCode: number;
    achvaCode: number;
    achvaName: string;
    classification: string;
    justifiable: boolean;
    lessonDate: Date;
    lesson: number | null;
    subject: string;
    reporter: string;
    remark: string | null;
    justification: string | null;
    eventAt: Date;
    updatedAt: Date;
  }, isHandled: boolean) {
    const mappedBucket = this.mapBehaviorBucket(item.classification);
    const priority = BEHAVIOR_PRIORITY_MAP[item.eventCode]
      ?? (mappedBucket === 'attention' ? 'medium' : 'low');

    return {
      id: item.id,
      studentGuid: item.studentGuid,
      lessonId: item.lessonId,
      groupId: item.groupId,
      eventCode: item.eventCode,
      achvaCode: item.achvaCode,
      achvaName: item.achvaName,
      bucket: mappedBucket,
      priority,
      justifiable: item.justifiable,
      lessonDate: item.lessonDate.toISOString(),
      lesson: item.lesson,
      subject: item.subject,
      reporter: item.reporter,
      remark: item.remark,
      justification: item.justification,
      eventAt: item.eventAt.toISOString(),
      isHandled,
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private async requireStudent(studentGuid: string): Promise<void> {
    await this.getStudentOrThrow(studentGuid);
  }

  private async getStudentOrThrow(studentGuid: string) {
    let student = await this.prisma.student.findUnique({
      where: { studentGuid },
    });

    if (!student) {
      await this.sessionService.ensureStudentsAvailable();
      student = await this.prisma.student.findUnique({
        where: { studentGuid },
      });
    }

    if (!student) {
      throw new NotFoundException(`Student not found: ${studentGuid}`);
    }
    return student;
  }

  private async getHandledMap(itemType: string, itemIds: string[]): Promise<Map<string, boolean>> {
    if (itemIds.length === 0) return new Map();

    const rows = await this.prisma.readState.findMany({
      where: {
        itemType,
        itemId: { in: itemIds },
        scopeType: 'household',
        scopeId: 'default',
      },
      select: { itemId: true, isHandled: true },
    });

    return new Map(rows.map((row) => [row.itemId, row.isHandled]));
  }

  private mapBehaviorBucket(classification: string): 'attention' | 'positive' | 'neutral' {
    if (classification === 'attention' || classification === 'positive' || classification === 'neutral') {
      return classification;
    }

    return 'neutral';
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }
}
