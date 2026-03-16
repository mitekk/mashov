import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';
import { MashovHttpClient } from '../session/mashov-http.client';

const BEHAVIOR_PRIORITY_MAP: Record<number, 'high' | 'medium' | 'low'> = {
  1: 'medium',
  2: 'high',
  4: 'low',
  5: 'high',
  6: 'medium',
  10: 'medium',
  11: 'low',
};

interface DownloadedFile {
  buffer: Buffer;
  contentType: string | null;
  contentDisposition: string | null;
  fileName: string | null;
}

interface AttachmentMeta {
  fileId: string;
  fileName: string;
  url?: string;
  lessonId?: number;
}

type ItemStatusFilter = 'new' | 'archived' | 'all';

@Injectable()
export class ChildrenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly mashovClient: MashovHttpClient,
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

  async getHomework(
    studentGuid: string,
    page: number,
    limit: number,
    status: ItemStatusFilter = 'new',
  ) {
    await this.requireStudent(studentGuid);

    const where = {
      studentGuid,
      ...(status === 'archived' ? { isArchived: true } : { isArchived: false }),
      ...(status === 'new' ? { isNew: true } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.homeworkItem.findMany({
        where,
        orderBy: { lessonDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.homeworkItem.count({ where }),
    ]);

    return {
      data: items.map((item) => this.mapHomeworkItem(item)),
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

    return this.mapHomeworkItem(item);
  }

  async getBehavior(
    studentGuid: string,
    page: number,
    limit: number,
    bucket: 'all' | 'attention' | 'positive' | 'neutral',
    status: ItemStatusFilter = 'new',
  ) {
    await this.requireStudent(studentGuid);

    const where = {
      studentGuid,
      ...(status === 'archived' ? { isArchived: true } : { isArchived: false }),
      ...(status === 'new' ? { isNew: true } : {}),
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

    return {
      data: items.map((item) => this.mapBehaviorItem(item)),
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

    return this.mapBehaviorItem(item);
  }

  async downloadHomeworkAttachment(
    studentGuid: string,
    homeworkId: string,
    fileId: string,
  ): Promise<DownloadedFile> {
    await this.requireStudent(studentGuid);

    const homework = await this.prisma.homeworkItem.findUnique({
      where: { id: homeworkId },
    });
    if (!homework || homework.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    const file = this.asArray(homework.files)
      .map((entry) => this.normalizeAttachmentMeta(entry))
      .find((entry): entry is AttachmentMeta => Boolean(entry && entry.fileId === fileId));
    if (!file) {
      throw new NotFoundException(`Homework attachment not found: ${fileId}`);
    }

    const encodedFileName = encodeURIComponent(file.fileName || fileId);
    const candidates = [
      `/api/students/${studentGuid}/studyFiles/${fileId}/${encodedFileName}`,
      `/api/students/${studentGuid}/files/${fileId}/${encodedFileName}`,
      file.url,
    ];

    return this.tryDownloadCandidates(
      candidates,
      `https://web.mashov.info/students/main/students/${studentGuid}/homework`,
      file.fileName,
    );
  }

  async downloadBehaviorAttachment(
    studentGuid: string,
    behaviorId: string,
    fileId: string,
  ): Promise<DownloadedFile> {
    await this.requireStudent(studentGuid);

    const behavior = await this.prisma.behaviorItem.findUnique({
      where: { id: behaviorId },
    });
    if (!behavior || behavior.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    const file = this.extractBehaviorFiles(behavior.rawPayload, behavior.lessonId)
      .find((entry) => entry.fileId === fileId);
    if (!file) {
      throw new NotFoundException(`Behavior attachment not found: ${fileId}`);
    }

    const encodedFileName = encodeURIComponent(file.fileName || fileId);
    const lessonId = file.lessonId ?? behavior.lessonId;
    const candidates = [
      file.url,
      `/api/lessons/${lessonId}/files/${fileId}/${encodedFileName}`,
      `/api/students/${studentGuid}/studyFiles/${fileId}/${encodedFileName}`,
    ];

    return this.tryDownloadCandidates(
      candidates,
      `https://web.mashov.info/students/main/students/${studentGuid}/behave`,
      file.fileName,
    );
  }

  async setHomeworkIsNew(studentGuid: string, homeworkId: string, isNew: boolean) {
    await this.requireStudent(studentGuid);

    const item = await this.prisma.homeworkItem.findUnique({ where: { id: homeworkId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }
    if (item.isArchived) {
      return this.mapHomeworkItem(item);
    }

    const updated = await this.prisma.homeworkItem.update({
      where: { id: homeworkId },
      data: { isNew },
    });

    return this.mapHomeworkItem(updated);
  }

  async setHomeworkManyIsNew(studentGuid: string, homeworkIds: string[], isNew: boolean) {
    await this.requireStudent(studentGuid);
    if (homeworkIds.length === 0) return { updated: 0 };

    const updated = await this.prisma.homeworkItem.updateMany({
      where: {
        studentGuid,
        id: { in: homeworkIds },
        isArchived: false,
        isNew: { not: isNew },
      },
      data: { isNew },
    });

    return { updated: updated.count };
  }

  async setHomeworkArchived(studentGuid: string, homeworkId: string, isArchived: boolean) {
    await this.requireStudent(studentGuid);

    const item = await this.prisma.homeworkItem.findUnique({ where: { id: homeworkId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    // Archive rules: archive=true forces isNew=false; unarchive=false forces isNew=true
    const updated = await this.prisma.homeworkItem.update({
      where: { id: homeworkId },
      data: {
        isArchived,
        isNew: isArchived ? false : true,
      },
    });

    return this.mapHomeworkItem(updated);
  }

  async setHomeworkManyArchived(studentGuid: string, homeworkIds: string[], isArchived: boolean) {
    await this.requireStudent(studentGuid);
    if (homeworkIds.length === 0) return { updated: 0 };

    const updated = await this.prisma.homeworkItem.updateMany({
      where: {
        studentGuid,
        id: { in: homeworkIds },
        isArchived: { not: isArchived },
      },
      data: {
        isArchived,
        isNew: !isArchived,
      },
    });

    return { updated: updated.count };
  }

  async setBehaviorIsNew(studentGuid: string, behaviorId: string, isNew: boolean) {
    await this.requireStudent(studentGuid);

    const item = await this.prisma.behaviorItem.findUnique({ where: { id: behaviorId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }
    if (item.isArchived) {
      return this.mapBehaviorItem(item);
    }

    const updated = await this.prisma.behaviorItem.update({
      where: { id: behaviorId },
      data: { isNew },
    });

    return this.mapBehaviorItem(updated);
  }

  async setBehaviorManyIsNew(studentGuid: string, behaviorIds: string[], isNew: boolean) {
    await this.requireStudent(studentGuid);
    if (behaviorIds.length === 0) return { updated: 0 };

    const updated = await this.prisma.behaviorItem.updateMany({
      where: {
        studentGuid,
        id: { in: behaviorIds },
        isArchived: false,
        isNew: { not: isNew },
      },
      data: { isNew },
    });

    return { updated: updated.count };
  }

  async setBehaviorArchived(studentGuid: string, behaviorId: string, isArchived: boolean) {
    await this.requireStudent(studentGuid);

    const item = await this.prisma.behaviorItem.findUnique({ where: { id: behaviorId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    // Archive rules: archive=true forces isNew=false; unarchive=false forces isNew=true
    const updated = await this.prisma.behaviorItem.update({
      where: { id: behaviorId },
      data: {
        isArchived,
        isNew: isArchived ? false : true,
      },
    });

    return this.mapBehaviorItem(updated);
  }

  async setBehaviorManyArchived(studentGuid: string, behaviorIds: string[], isArchived: boolean) {
    await this.requireStudent(studentGuid);
    if (behaviorIds.length === 0) return { updated: 0 };

    const updated = await this.prisma.behaviorItem.updateMany({
      where: {
        studentGuid,
        id: { in: behaviorIds },
        isArchived: { not: isArchived },
      },
      data: {
        isArchived,
        isNew: !isArchived,
      },
    });

    return { updated: updated.count };
  }

  async getTimetable(studentGuid: string) {
    await this.requireStudent(studentGuid);

    const entries = await this.prisma.timetableEntry.findMany({
      where: { studentGuid },
      orderBy: [{ day: 'asc' }, { lesson: 'asc' }],
    });

    return {
      data: entries.map((e) => ({
        id: e.id,
        studentGuid: e.studentGuid,
        groupId: e.groupId,
        day: e.day,
        lesson: e.lesson,
        roomNum: e.roomNum,
        weeks: e.weeks,
        groupName: e.groupName,
        subjectName: e.subjectName,
        teachers: this.asArray(e.teachers),
        updatedAt: e.updatedAt.toISOString(),
      })),
    };
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
    isNew: boolean;
    isArchived: boolean;
    updatedAt: Date;
  }) {
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
      isNew: item.isNew,
      isArchived: item.isArchived,
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
    isNew: boolean;
    isArchived: boolean;
    updatedAt: Date;
    rawPayload?: unknown;
  }) {
    const mappedBucket = this.mapBehaviorBucket(item.classification);
    const priority = BEHAVIOR_PRIORITY_MAP[item.eventCode]
      ?? (mappedBucket === 'attention' ? 'medium' : 'low');
    const files = this.extractBehaviorFiles(item.rawPayload, item.lessonId);

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
      files: files.map((file) => ({
        fileId: file.fileId,
        fileName: file.fileName,
      })),
      eventAt: item.eventAt.toISOString(),
      isNew: item.isNew,
      isArchived: item.isArchived,
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

  private async tryDownloadCandidates(
    candidates: Array<string | undefined | null>,
    referer: string,
    fallbackFileName: string,
  ): Promise<DownloadedFile> {
    const uniqueCandidates = Array.from(new Set(
      candidates
        .map((candidate) => this.normalizeUpstreamPath(candidate))
        .filter((candidate): candidate is string => Boolean(candidate)),
    ));

    for (const candidate of uniqueCandidates) {
      try {
        return await this.downloadBinaryFromUpstream(candidate, referer, fallbackFileName);
      } catch {
        // Try next candidate URL.
      }
    }

    throw new NotFoundException('Attachment download failed');
  }

  private async downloadBinaryFromUpstream(
    pathOrUrl: string,
    referer: string,
    fallbackFileName: string,
  ): Promise<DownloadedFile> {
    const response = await this.mashovClient.getResponse<ArrayBuffer>(pathOrUrl, {
      responseType: 'arraybuffer',
      headers: {
        Referer: referer,
      },
    });

    const headers = (response.headers ?? {}) as Record<string, string | string[] | undefined>;
    const contentType = this.readHeader(headers, 'content-type');
    const contentDisposition = this.readHeader(headers, 'content-disposition');

    return {
      buffer: Buffer.from(response.data),
      contentType,
      contentDisposition,
      fileName: this.extractFileNameFromDisposition(contentDisposition) ?? fallbackFileName,
    };
  }

  private extractBehaviorFiles(rawPayload: unknown, fallbackLessonId: number): AttachmentMeta[] {
    if (!rawPayload || typeof rawPayload !== 'object') return [];

    const payload = rawPayload as Record<string, unknown>;
    const sources: unknown[] = [];
    if (Array.isArray(payload.files)) sources.push(...payload.files);
    if (Array.isArray(payload.attachments)) sources.push(...payload.attachments);

    return sources
      .map((entry) => this.normalizeAttachmentMeta(entry, fallbackLessonId))
      .filter((entry): entry is AttachmentMeta => Boolean(entry));
  }

  private normalizeAttachmentMeta(
    value: unknown,
    fallbackLessonId?: number,
  ): AttachmentMeta | null {
    if (!value || typeof value !== 'object') return null;

    const record = value as Record<string, unknown>;
    const fileId = this.pickFirstString(record, [
      'fileId',
      'id',
      'guid',
      'attachmentId',
    ]);
    if (!fileId) return null;

    const fileName = this.pickFirstString(record, [
      'fileName',
      'name',
      'title',
      'originalFileName',
    ]) ?? fileId;
    const url = this.pickFirstString(record, [
      'url',
      'link',
      'downloadUrl',
      'href',
    ]);
    const lessonId = this.pickFirstNumber(record, ['lessonId']) ?? fallbackLessonId;

    return {
      fileId,
      fileName,
      ...(url ? { url } : {}),
      ...(typeof lessonId === 'number' ? { lessonId } : {}),
    };
  }

  private pickFirstString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  }

  private pickFirstNumber(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  private normalizeUpstreamPath(pathOrUrl: string | null | undefined): string | null {
    if (!pathOrUrl || pathOrUrl.trim().length === 0) return null;

    const value = pathOrUrl.trim();
    if (value.startsWith('https://web.mashov.info')) {
      return value;
    }
    if (value.startsWith('/api/')) {
      return value;
    }
    if (value.startsWith('api/')) {
      return `/${value}`;
    }
    if (value.startsWith('/')) {
      return value;
    }
    return null;
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined>,
    key: string,
  ): string | null {
    const direct = headers[key] ?? headers[key.toLowerCase()];
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct) && direct.length > 0) return direct[0] ?? null;
    return null;
  }

  private extractFileNameFromDisposition(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;

    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }

    const fallbackMatch = /filename="?([^\";]+)"?/i.exec(contentDisposition);
    return fallbackMatch?.[1] ?? null;
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
