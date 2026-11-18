import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MashovSessionService } from '../session/mashov-session.service';
import { MashovHttpClient } from '../session/mashov-http.client';
import type { ConnectionTarget } from '../session/connection-target';
import { ConnectionScopeService } from '../common/connection-scope/connection-scope.service';
import { resolveSchoolLabels } from '../common/school-label';
import { UserItemStateService } from '../common/user-item-state.service';
import { ConfigService } from '@nestjs/config';
import {
  schoolYearForConnection,
  currentYearScope,
  historyScope,
  schoolYearWindowForStudent,
  yearScopeForStudents,
  type YearScope,
} from '../common/school-year/school-year.scope';

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
    private readonly sessionService: MashovSessionService,
    private readonly mashovClient: MashovHttpClient,
    private readonly userItemStateService: UserItemStateService,
    private readonly configService: ConfigService,
    private readonly scope: ConnectionScopeService,
  ) {}

  async getChildren(userId?: string) {
    await this.sessionService.ensureStudentsAvailable(userId);

    // Scoped to the caller's household. This used to return every active
    // student row in the database with no ownership check at all, which is
    // what made the PRD's multi-tenancy claim untrue.
    //
    // Unstamped children are included for the reason `ownsStudent` documents:
    // NULL means "ownership unknown", and excluding them would empty the app
    // on a deployment that has not re-synced since the migration.
    const students = await this.prisma.student.findMany({
      where: {
        isActive: true,
        ...(userId ? await this.householdStudentWhere(userId) : {}),
      },
      orderBy: { fullName: 'asc' },
    });

    // Which school each child belongs to. Resolved once for the list rather
    // than per child, and labelled as a set so two schools can never present
    // the same chip.
    const schoolByConnection = await this.resolveSchoolLabels(userId);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Current year only: these are activity counts and staleness signals, and
    // the subject count would double for a groupId that recurs yearly.
    //
    // Cross-child, so each school contributes its own children at its own
    // year. A single household-wide year hides the other school's children
    // outright every September, when one school has rolled over and the other
    // has not.
    const yearScope = await yearScopeForStudents(this.prisma, userId);

    const data = await Promise.all(
      students.map(async (student) => {
        const [
          activityCounts,
          subjectCount,
          latestHomework,
          latestBehavior,
        ] =
          await Promise.all([
            this.getUnreadChildActivityCounts(
              student.studentGuid,
              sevenDaysAgo,
              yearScope,
              userId,
            ),
            this.prisma.subjectEnrollment.count({
              where: { studentGuid: student.studentGuid, ...yearScope },
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

        // Deliberately excludes student.updatedAt: it bumps on every sign-in,
        // which is exactly why this read "fresh" for five months while the
        // content underneath was from a school year that had ended.
        const latestUpdateAt =
          [latestHomework?.lessonDate ?? null, latestBehavior?.eventAt ?? null]
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
          // `null` for an unstamped child, which the UI reads as "no badge"
          // rather than as a school called "null".
          schoolId: student.householdConnectionId,
          schoolName:
            schoolByConnection.get(student.householdConnectionId ?? '')?.schoolName ?? null,
          schoolShortLabel:
            schoolByConnection.get(student.householdConnectionId ?? '')?.shortLabel ?? null,
          semel: schoolByConnection.get(student.householdConnectionId ?? '')?.semel ?? null,
          recentHomeworkCount: activityCounts.recentHomeworkCount,
          recentBehaviorCount: activityCounts.recentBehaviorCount,
          positiveBehaviorCount: activityCounts.positiveBehaviorCount,
          subjectCount,
          latestUpdateAt,
        };
      }),
    );

    return { data };
  }

  async getChildWorkspace(studentGuid: string, userId?: string) {
    const student = await this.getStudentOrThrow(studentGuid, userId);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Current year only: counts, the subject total and the weekly-hours sum.
    // One child, so one year -- that child's own school's.
    const yearScope = currentYearScope(
      await schoolYearForConnection(this.prisma, student.householdConnectionId),
    );

    const [
      activityCounts,
      subjectCount,
      totalWeeklyHours,
      lastSync,
    ] = await Promise.all([
      this.getUnreadChildActivityCounts(studentGuid, sevenDaysAgo, yearScope, userId),
      this.prisma.subjectEnrollment.count({
        where: { studentGuid, ...yearScope },
      }),
      this.prisma.subjectEnrollment.aggregate({
        where: { studentGuid, ...yearScope },
        _sum: { weeklyHours: true },
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
        recentHomeworkCount: activityCounts.recentHomeworkCount,
        recentBehaviorCount: activityCounts.recentBehaviorCount,
        positiveBehaviorCount: activityCounts.positiveBehaviorCount,
        subjectCount,
        totalWeeklyHours: totalWeeklyHours._sum.weeklyHours ?? 0,
        attentionBehaviorCount: activityCounts.attentionBehaviorCount,
      },
      lastSyncAt: lastSync?.endedAt?.toISOString() ?? null,
    };
  }

  async getHomework(
    studentGuid: string,
    page: number,
    limit: number,
    status: ItemStatusFilter = 'new',
    userId?: string,
  ) {
    const student = await this.requireStudent(studentGuid, userId);

    // Fetch all non-filtered items for state-based filtering
    // A list, so it spans the configured history window; `pagination.total`
    // grows with it by design.
    const allItems = await this.prisma.homeworkItem.findMany({
      where: {
        studentGuid,
        ...historyScope(
          await schoolYearWindowForStudent(
            this.prisma,
            this.configService,
            student.householdConnectionId,
          ),
        ),
      },
      orderBy: { lessonDate: 'desc' },
    });

    const allIds = allItems.map((i) => i.id);
    const stateMap = userId
      ? await this.userItemStateService.getStateBatch(userId, 'homework', allIds)
      : new Map<string, { isNew: boolean; isArchived: boolean }>();

    const defaultState = { isNew: true, isArchived: false };

    const filtered = allItems.filter((item) => {
      const state = stateMap.get(item.id) ?? defaultState;
      if (status === 'archived') return state.isArchived;
      if (status === 'new') return state.isNew && !state.isArchived;
      return !state.isArchived; // 'all' excludes archived
    });

    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, page * limit);

    return {
      data: paged.map((item) => {
        const state = stateMap.get(item.id) ?? defaultState;
        return this.mapHomeworkItem(item, state.isNew, state.isArchived);
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async getHomeworkDetail(studentGuid: string, homeworkId: string, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.homeworkItem.findUnique({
      where: { id: homeworkId },
    });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    const state = userId
      ? await this.userItemStateService.getState(userId, 'homework', homeworkId)
      : { isNew: true, isArchived: false };

    return this.mapHomeworkItem(item, state.isNew, state.isArchived);
  }

  async getBehavior(
    studentGuid: string,
    page: number,
    limit: number,
    bucket: 'all' | 'attention' | 'positive' | 'neutral',
    status: ItemStatusFilter = 'new',
    userId?: string,
  ) {
    const student = await this.requireStudent(studentGuid, userId);

    const allItems = await this.prisma.behaviorItem.findMany({
      where: {
        studentGuid,
        ...(bucket !== 'all' ? { classification: bucket } : {}),
        ...historyScope(
          await schoolYearWindowForStudent(
            this.prisma,
            this.configService,
            student.householdConnectionId,
          ),
        ),
      },
      orderBy: { eventAt: 'desc' },
    });

    const allIds = allItems.map((i) => i.id);
    const stateMap = userId
      ? await this.userItemStateService.getStateBatch(userId, 'behavior', allIds)
      : new Map<string, { isNew: boolean; isArchived: boolean }>();

    const defaultState = { isNew: true, isArchived: false };

    const filtered = allItems.filter((item) => {
      const state = stateMap.get(item.id) ?? defaultState;
      if (status === 'archived') return state.isArchived;
      if (status === 'new') return state.isNew && !state.isArchived;
      return !state.isArchived;
    });

    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, page * limit);

    return {
      data: paged.map((item) => {
        const state = stateMap.get(item.id) ?? defaultState;
        return this.mapBehaviorItem(item, state.isNew, state.isArchived);
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async getBehaviorDetail(studentGuid: string, behaviorId: string, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.behaviorItem.findUnique({
      where: { id: behaviorId },
    });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    const state = userId
      ? await this.userItemStateService.getState(userId, 'behavior', behaviorId)
      : { isNew: true, isArchived: false };

    return this.mapBehaviorItem(item, state.isNew, state.isArchived);
  }

  async downloadHomeworkAttachment(
    studentGuid: string,
    homeworkId: string,
    fileId: string,
    userId?: string,
  ): Promise<DownloadedFile> {
    await this.requireStudent(studentGuid, userId);

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
      await this.scope.targetForStudent(studentGuid),
    );
  }

  async downloadBehaviorAttachment(
    studentGuid: string,
    behaviorId: string,
    fileId: string,
    userId?: string,
  ): Promise<DownloadedFile> {
    await this.requireStudent(studentGuid, userId);

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
      await this.scope.targetForStudent(studentGuid),
    );
  }

  async setHomeworkIsNew(studentGuid: string, homeworkId: string, isNew: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.homeworkItem.findUnique({ where: { id: homeworkId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    if (userId) {
      const currentState = await this.userItemStateService.getState(userId, 'homework', homeworkId);
      if (currentState.isArchived) {
        return this.mapHomeworkItem(item, currentState.isNew, currentState.isArchived);
      }
      const newState = await this.userItemStateService.setState(userId, 'homework', homeworkId, isNew, undefined);
      return this.mapHomeworkItem(item, newState.isNew, newState.isArchived);
    }

    return this.mapHomeworkItem(item, isNew, false);
  }

  async setHomeworkManyIsNew(studentGuid: string, homeworkIds: string[], isNew: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);
    if (homeworkIds.length === 0) return { updated: 0 };

    if (userId) {
      const count = await this.userItemStateService.setStateBatch(userId, 'homework', homeworkIds, isNew, undefined);
      return { updated: count };
    }

    return { updated: homeworkIds.length };
  }

  async setHomeworkArchived(studentGuid: string, homeworkId: string, isArchived: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.homeworkItem.findUnique({ where: { id: homeworkId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    if (userId) {
      // Archive rules: archive=true forces isNew=false; unarchive=false forces isNew=true
      const newState = await this.userItemStateService.setState(
        userId, 'homework', homeworkId,
        isArchived ? false : true,
        isArchived,
      );
      return this.mapHomeworkItem(item, newState.isNew, newState.isArchived);
    }

    return this.mapHomeworkItem(item, !isArchived, isArchived);
  }

  async setHomeworkManyArchived(studentGuid: string, homeworkIds: string[], isArchived: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);
    if (homeworkIds.length === 0) return { updated: 0 };

    if (userId) {
      const count = await this.userItemStateService.setStateBatch(
        userId, 'homework', homeworkIds,
        isArchived ? false : true,
        isArchived,
      );
      return { updated: count };
    }

    return { updated: homeworkIds.length };
  }

  async setBehaviorIsNew(studentGuid: string, behaviorId: string, isNew: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.behaviorItem.findUnique({ where: { id: behaviorId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    if (userId) {
      const currentState = await this.userItemStateService.getState(userId, 'behavior', behaviorId);
      if (currentState.isArchived) {
        return this.mapBehaviorItem(item, currentState.isNew, currentState.isArchived);
      }
      const newState = await this.userItemStateService.setState(userId, 'behavior', behaviorId, isNew, undefined);
      return this.mapBehaviorItem(item, newState.isNew, newState.isArchived);
    }

    return this.mapBehaviorItem(item, isNew, false);
  }

  async setBehaviorManyIsNew(studentGuid: string, behaviorIds: string[], isNew: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);
    if (behaviorIds.length === 0) return { updated: 0 };

    if (userId) {
      const count = await this.userItemStateService.setStateBatch(userId, 'behavior', behaviorIds, isNew, undefined);
      return { updated: count };
    }

    return { updated: behaviorIds.length };
  }

  async setBehaviorArchived(studentGuid: string, behaviorId: string, isArchived: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.behaviorItem.findUnique({ where: { id: behaviorId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    if (userId) {
      const newState = await this.userItemStateService.setState(
        userId, 'behavior', behaviorId,
        isArchived ? false : true,
        isArchived,
      );
      return this.mapBehaviorItem(item, newState.isNew, newState.isArchived);
    }

    return this.mapBehaviorItem(item, !isArchived, isArchived);
  }

  async setBehaviorManyArchived(studentGuid: string, behaviorIds: string[], isArchived: boolean, userId?: string) {
    await this.requireStudent(studentGuid, userId);
    if (behaviorIds.length === 0) return { updated: 0 };

    if (userId) {
      const count = await this.userItemStateService.setStateBatch(
        userId, 'behavior', behaviorIds,
        isArchived ? false : true,
        isArchived,
      );
      return { updated: count };
    }

    return { updated: behaviorIds.length };
  }

  async getTimetable(studentGuid: string, userId?: string) {
    const student = await this.requireStudent(studentGuid, userId);

    const entries = await this.prisma.timetableEntry.findMany({
      where: {
        studentGuid,
        ...currentYearScope(
          await schoolYearForConnection(this.prisma, student.householdConnectionId),
        ),
      },
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

  async getSubjects(studentGuid: string, userId?: string) {
    const student = await this.requireStudent(studentGuid, userId);

    const items = await this.prisma.subjectEnrollment.findMany({
      where: {
        studentGuid,
        ...currentYearScope(
          await schoolYearForConnection(this.prisma, student.householdConnectionId),
        ),
      },
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

  async getLessonPlans(studentGuid: string, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const referer = `https://web.mashov.info/students/main/students/${studentGuid}/weeklyPlan`;
    try {
      const plans = await this.mashovClient.getForTarget<unknown[]>(
        `/api/students/${studentGuid}/lessons/plans`,
        await this.scope.targetForStudent(studentGuid),
        { headers: { Referer: referer } },
      );
      const data = Array.isArray(plans) ? plans : [];
      return { data };
    } catch {
      return { data: [] };
    }
  }

  async getLessonHistory(studentGuid: string, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const referer = `https://web.mashov.info/students/main/students/${studentGuid}/weeklyPlan`;
    try {
      const history = await this.mashovClient.getForTarget<unknown[]>(
        `/api/students/${studentGuid}/lessons/history`,
        await this.scope.targetForStudent(studentGuid),
        { headers: { Referer: referer } },
      );
      const data = Array.isArray(history) ? history : [];
      return { data };
    } catch {
      return { data: [] };
    }
  }

  async getStudentReleases(studentGuid: string, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const referer = 'https://web.mashov.info/students/main/studentsReleaseRequests';
    return this.mashovClient.getForTarget<unknown[]>(
      `/api/students/${studentGuid}/studentReleases`,
      await this.scope.targetForStudent(studentGuid),
      { headers: { Referer: referer } },
    );
  }

  async getSchoolActivities(studentGuid: string, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const referer = 'https://web.mashov.info/students/main/schoolActivities';
    // The endpoint takes no studentGuid and is household-scoped upstream, so
    // it answers for whichever account asked. Routing it through this child's
    // own school is exactly right: it is that school's activities the caller
    // is looking at.
    return this.mashovClient.getForTarget<unknown[]>(
      '/api/schoolActivities/permitted',
      await this.scope.targetForStudent(studentGuid),
      { headers: { Referer: referer } },
    );
  }

  async createStudentRelease(studentGuid: string, body: unknown, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const referer = 'https://web.mashov.info/students/main/studentsReleaseRequests';
    return this.mashovClient.putForTarget<void>(
      `/api/students/${studentGuid}/studentRelease/request`,
      body,
      await this.scope.targetForStudent(studentGuid),
      { headers: { Referer: referer } },
    );
  }

  async updateStudentRelease(
    studentGuid: string,
    releaseId: number,
    body: unknown,
    userId?: string,
  ) {
    await this.requireStudent(studentGuid, userId);

    return this.mashovClient.putForTarget<void>(
      `/api/students/${studentGuid}/studentRelease/${releaseId}/request`,
      body,
      await this.scope.targetForStudent(studentGuid),
    );
  }

  async deleteStudentRelease(studentGuid: string, releaseId: number, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    return this.mashovClient.deleteForTarget<void>(
      `/api/students/${studentGuid}/studentRelease/${releaseId}`,
      await this.scope.targetForStudent(studentGuid),
    );
  }

  async getNotices(studentGuid: string, userId?: string) {
    const student = await this.requireStudent(studentGuid, userId);

    const now = new Date();
    const items = await this.prisma.messageBoardItem.findMany({
      where: {
        studentGuid,
        expirationDate: { gt: now },
        ...currentYearScope(
          await schoolYearForConnection(this.prisma, student.householdConnectionId),
        ),
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

  private mapHomeworkItem(
    item: {
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
    },
    isNew = true,
    isArchived = false,
  ) {
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
      isNew,
      isArchived,
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private mapBehaviorItem(
    item: {
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
      rawPayload?: unknown;
    },
    isNew = true,
    isArchived = false,
  ) {
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
      isNew,
      isArchived,
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  /**
   * Authorise the request and hand the row back.
   *
   * It returns the student because every caller needs
   * `householdConnectionId` immediately afterwards to resolve the year its
   * rows were written at -- and re-reading the row for one column it is
   * already holding is a query per per-child endpoint for nothing.
   */
  private async requireStudent(studentGuid: string, userId?: string) {
    return this.getStudentOrThrow(studentGuid, userId);
  }

  private async getUnreadChildActivityCounts(
    studentGuid: string,
    since: Date,
    yearScope: YearScope,
    userId?: string,
  ): Promise<{
    recentHomeworkCount: number;
    recentBehaviorCount: number;
    positiveBehaviorCount: number;
    attentionBehaviorCount: number;
  }> {
    const [homeworkRows, behaviorRows] = await Promise.all([
      this.prisma.homeworkItem.findMany({
        where: {
          studentGuid,
          lessonDate: { gte: since },
          ...yearScope,
        },
        select: { id: true },
      }),
      this.prisma.behaviorItem.findMany({
        where: {
          studentGuid,
          lessonDate: { gte: since },
          ...yearScope,
        },
        select: { id: true, classification: true },
      }),
    ]);

    const homeworkIds = homeworkRows.map((row) => row.id);
    const behaviorIds = behaviorRows.map((row) => row.id);

    const [homeworkStateMap, behaviorStateMap] = userId
      ? await Promise.all([
          this.userItemStateService.getStateBatch(userId, 'homework', homeworkIds),
          this.userItemStateService.getStateBatch(userId, 'behavior', behaviorIds),
        ])
      : [
          new Map<string, { isNew: boolean; isArchived: boolean }>(),
          new Map<string, { isNew: boolean; isArchived: boolean }>(),
        ];

    const recentHomeworkCount = homeworkRows.filter((row) =>
      this.isUnreadAndNotArchived(homeworkStateMap.get(row.id)),
    ).length;

    const visibleBehaviorRows = behaviorRows.filter((row) =>
      this.isUnreadAndNotArchived(behaviorStateMap.get(row.id)),
    );

    const recentBehaviorCount = visibleBehaviorRows.filter(
      (row) => row.classification !== 'positive',
    ).length;
    const positiveBehaviorCount = visibleBehaviorRows.filter(
      (row) => row.classification === 'positive',
    ).length;
    const attentionBehaviorCount = visibleBehaviorRows.filter(
      (row) => row.classification === 'attention',
    ).length;

    return {
      recentHomeworkCount,
      recentBehaviorCount,
      positiveBehaviorCount,
      attentionBehaviorCount,
    };
  }

  private async getStudentOrThrow(studentGuid: string, userId?: string) {
    let student = await this.prisma.student.findUnique({
      where: { studentGuid },
    });

    if (!student) {
      // A child who was added to the family mid-year exists upstream before it
      // exists here, so a miss is a reason to re-read the roster, not a 404.
      await this.sessionService.ensureStudentsAvailable(userId);
      student = await this.prisma.student.findUnique({
        where: { studentGuid },
      });
    }

    if (!student) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: `Student not found: ${studentGuid}`,
          details: [],
        },
      });
    }

    // The ownership guard. Until now any signed-in user could read any child
    // by guid: `Student` had no owner column and this method only checked that
    // the row existed. The PRD has claimed since Phase 2 that a parent sees
    // "only their own children's data"; this is where that becomes true.
    //
    // 404, not 403. A 403 confirms the guid names a real child, which is
    // exactly the fact a stranger must not be able to probe for -- and the
    // guids appear in URLs. The message is identical to the not-found one for
    // the same reason.
    if (userId && !(await this.ownsStudent(userId, student.householdConnectionId))) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: `Student not found: ${studentGuid}`,
          details: [],
        },
      });
    }

    return student;
  }

  /**
   * Each of a household's connections, with the short label a chip shows.
   *
   * Labels are resolved across the whole set, because two schools in one
   * cluster routinely share everything up to a " - …" qualifier and two
   * identical chips are unusable -- see src/common/school-label.ts.
   */
  private async resolveSchoolLabels(userId?: string) {
    const connections = await this.prisma.householdConnection.findMany({
      where: { active: true, ...(userId ? { userId } : {}) },
      select: { id: true, schoolCode: true, schoolName: true, displayLabel: true },
    });

    const labels = resolveSchoolLabels(connections);
    return new Map(
      connections.map((connection) => [
        connection.id,
        {
          semel: connection.schoolCode,
          schoolName: connection.schoolName ?? String(connection.schoolCode),
          shortLabel: labels.get(connection.id) ?? String(connection.schoolCode),
        },
      ]),
    );
  }

  /**
   * The `where` fragment that restricts a student list to one household.
   *
   * Returns the household's own connections' children plus the unstamped
   * ones, matching `ownsStudent`.
   */
  private async householdStudentWhere(userId: string) {
    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      select: { id: true },
    });

    return {
      OR: [
        { householdConnectionId: { in: connections.map((row) => row.id) } },
        { householdConnectionId: null },
      ],
    };
  }

  /**
   * Whether a household owns a child.
   *
   * An unstamped child (`householdConnectionId: null`) is readable by any
   * caller. That is deliberate and temporary: the shared env-credential
   * session writes unowned rows, and the ownership backfill refuses to guess
   * above one active connection, so refusing them would break a
   * single-school deployment that has not re-synced since the migration. Every
   * roster refresh and every per-student sync task stamps them, so the window
   * closes within one cycle -- and a second school cannot be linked until the
   * rows carry owners anyway.
   */
  private async ownsStudent(
    userId: string,
    householdConnectionId: string | null,
  ): Promise<boolean> {
    if (householdConnectionId === null) return true;

    const connection = await this.prisma.householdConnection.findFirst({
      where: { id: householdConnectionId, userId },
      select: { id: true },
    });
    return connection !== null;
  }

  private async tryDownloadCandidates(
    candidates: Array<string | undefined | null>,
    referer: string,
    fallbackFileName: string,
    target: ConnectionTarget,
  ): Promise<DownloadedFile> {
    const uniqueCandidates = Array.from(new Set(
      candidates
        .map((candidate) => this.normalizeUpstreamPath(candidate))
        .filter((candidate): candidate is string => Boolean(candidate)),
    ));

    for (const candidate of uniqueCandidates) {
      try {
        return await this.downloadBinaryFromUpstream(
          candidate,
          referer,
          fallbackFileName,
          target,
        );
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
    target: ConnectionTarget,
  ): Promise<DownloadedFile> {
    const response = await this.mashovClient.getResponseForTarget<ArrayBuffer>(
      pathOrUrl,
      target,
      {
        responseType: 'arraybuffer',
        headers: {
          Referer: referer,
        },
      },
    );

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

  private isUnreadAndNotArchived(
    state: { isNew: boolean; isArchived: boolean } | undefined,
  ): boolean {
    const effectiveState = state ?? { isNew: true, isArchived: false };
    return effectiveState.isNew && !effectiveState.isArchived;
  }
}
