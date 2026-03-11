import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChildrenService {
  constructor(private readonly prisma: PrismaService) {}

  async getChildren() {
    return this.prisma.student.findMany({
      where: { isActive: true },
      orderBy: { fullName: 'asc' },
    });
  }

  async getChildWorkspace(studentGuid: string) {
    const student = await this.prisma.student.findUnique({
      where: { studentGuid },
    });

    if (!student) {
      throw new NotFoundException(`Student not found: ${studentGuid}`);
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const [homework, behavior, subjects, notices] = await Promise.all([
      this.prisma.homeworkItem.findMany({
        where: {
          studentGuid,
          lessonDate: { gte: thirtyDaysAgo },
        },
        orderBy: { lessonDate: 'desc' },
      }),
      this.prisma.behaviorItem.findMany({
        where: { studentGuid },
        orderBy: { eventAt: 'desc' },
      }),
      this.prisma.subjectEnrollment.findMany({
        where: { studentGuid },
        orderBy: { subjectName: 'asc' },
      }),
      this.prisma.messageBoardItem.findMany({
        where: {
          studentGuid,
          expirationDate: { gt: now },
        },
        orderBy: { expirationDate: 'asc' },
      }),
    ]);

    return {
      student,
      homework,
      behavior,
      subjects,
      notices,
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

    return {
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
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
      ...(bucket !== 'all' ? { bucket } : {}),
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

    return {
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getSubjects(studentGuid: string) {
    await this.requireStudent(studentGuid);

    return this.prisma.subjectEnrollment.findMany({
      where: { studentGuid },
      orderBy: { subjectName: 'asc' },
    });
  }

  async getNotices(studentGuid: string) {
    await this.requireStudent(studentGuid);

    const now = new Date();
    return this.prisma.messageBoardItem.findMany({
      where: {
        studentGuid,
        expirationDate: { gt: now },
      },
      orderBy: { expirationDate: 'asc' },
    });
  }

  private async requireStudent(studentGuid: string): Promise<void> {
    const student = await this.prisma.student.findUnique({
      where: { studentGuid },
      select: { id: true },
    });
    if (!student) {
      throw new NotFoundException(`Student not found: ${studentGuid}`);
    }
  }
}
