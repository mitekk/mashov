import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MashovSessionService } from '../session/mashov-session.service';
import { MashovHttpClient } from '../session/mashov-http.client';
import type { ConnectionTarget } from '../session/connection-target';
import { ConnectionScopeService } from '../common/connection-scope/connection-scope.service';
import { UserItemStateService } from '../common/user-item-state.service';
import { ConfigService } from '@nestjs/config';
import {
  schoolYearForConnection,
  currentYearScope,
  historyScope,
  isPastSchoolYear,
  schoolYearWindowForStudent,
  yearScopeForStudents,
} from '../common/school-year/school-year.scope';
import { canSeeStudent, visibleStudentWhere } from '../common/student-links';
import { unreadChildActivityCounts } from '../common/child-activity-counts';
import { buildStudentSchoolMap } from '../common/student-school-map';
import {
  AttachmentMeta,
  extractBehaviorFiles,
  extractHomeworkFiles,
  parseAttachmentMeta,
} from './attachment-parser';
import { DownloadOptions, downloadTimeoutConfig } from './download-options';

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
    // Children with no link are included for the reason `visibleStudentWhere`
    // documents: no link means "ownership unknown", and excluding them would
    // empty the app on a deployment that has not re-synced since the
    // migration.
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
    //
    // R6: this used to key the four school fields off the routing stamp
    // against the caller's own label map, while `/dashboard` and `/feed` went
    // through `buildStudentSchoolMap` and the visibility edge. For a child
    // stamped to the other parent's connection the two endpoints therefore
    // disagreed about the same child -- `/children` emitting an id the caller
    // does not own with all three labels `null`. One helper, one answer.
    const schoolByStudent = await buildStudentSchoolMap(this.prisma, students, userId);

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
            unreadChildActivityCounts(
              this.prisma,
              this.userItemStateService,
              student.studentGuid,
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
          // All four `null` for a child whose school is not knowable from the
          // caller's own connections, which the UI reads as "no badge" rather
          // than as a school called "null".
          schoolId: schoolByStudent.get(student.studentGuid)?.schoolId ?? null,
          schoolName: schoolByStudent.get(student.studentGuid)?.schoolName ?? null,
          schoolShortLabel: schoolByStudent.get(student.studentGuid)?.shortLabel ?? null,
          semel: schoolByStudent.get(student.studentGuid)?.semel ?? null,
          // Wire names kept; the meaning is "unread this school year", not
          // "the last seven days" -- see `unreadChildActivityCounts`.
          recentHomeworkCount: activityCounts.unreadHomeworkCount,
          recentBehaviorCount: activityCounts.attentionCount,
          positiveBehaviorCount: activityCounts.positiveCount,
          neutralBehaviorCount: activityCounts.neutralCount,
          subjectCount,
          latestUpdateAt,
        };
      }),
    );

    return { data };
  }

  async getChildWorkspace(studentGuid: string, userId?: string) {
    const student = await this.getStudentOrThrow(studentGuid, userId);
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
      unreadChildActivityCounts(
        this.prisma,
        this.userItemStateService,
        studentGuid,
        yearScope,
        userId,
      ),
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
        // Wire names kept; the meaning is "unread this school year", which
        // is the "לא נקרא" total of the list beneath each chip -- restricted
        // to the current year, where the list spans `MASHOV_YEAR` back.
        recentHomeworkCount: activityCounts.unreadHomeworkCount,
        recentBehaviorCount: activityCounts.attentionCount,
        positiveBehaviorCount: activityCounts.positiveCount,
        neutralBehaviorCount: activityCounts.neutralCount,
        subjectCount,
        totalWeeklyHours: totalWeeklyHours._sum.weeklyHours ?? 0,
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

    // Per-tab year scope (ADR-0036). `לא נקרא` and `הכל` are the default
    // view, so they hold the current year alone -- which is what makes the
    // `לא נקרא` total equal the header chip. `ארכיון` keeps the configured
    // history window, so last year stays reachable in exactly one place.
    const window = await schoolYearWindowForStudent(
      this.prisma,
      this.configService,
      student.householdConnectionId,
    );
    const yearWhere =
      status === 'archived' ? historyScope(window) : currentYearScope(window.current);

    const allItems = await this.prisma.homeworkItem.findMany({
      where: { studentGuid, ...yearWhere },
      orderBy: { lessonDate: 'desc' },
    });

    const allIds = allItems.map((i) => i.id);
    const stateMap = userId
      ? await this.userItemStateService.getStateBatch(userId, 'homework', allIds)
      : new Map<string, { isNew: boolean; isArchived: boolean }>();

    const effectiveState = (item: { id: string; schoolYear: number }) =>
      this.effectiveItemState(stateMap.get(item.id), item.schoolYear, window.current);

    const filtered = allItems.filter((item) => {
      const state = effectiveState(item);
      if (status === 'archived') return state.isArchived;
      if (status === 'new') return state.isNew && !state.isArchived;
      return !state.isArchived; // 'all' excludes archived
    });

    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, page * limit);

    return {
      data: paged.map((item) => {
        const state = effectiveState(item);
        return this.mapHomeworkItem(item, state.isNew, state.isArchived, state.isPastYear);
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
    const student = await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.homeworkItem.findUnique({
      where: { id: homeworkId },
    });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    // Deliberately unscoped by year: a link to a past-year item has to keep
    // working. The derivation runs here too, so the detail page agrees with
    // the list it was opened from.
    const currentYear = await schoolYearForConnection(
      this.prisma,
      student.householdConnectionId,
    );
    const stored = userId
      ? await this.userItemStateService.getState(userId, 'homework', homeworkId)
      : undefined;
    const state = this.effectiveItemState(stored, item.schoolYear, currentYear);

    return this.mapHomeworkItem(item, state.isNew, state.isArchived, state.isPastYear);
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

    // Per-tab year scope, exactly as `getHomework` -- see the note there.
    const window = await schoolYearWindowForStudent(
      this.prisma,
      this.configService,
      student.householdConnectionId,
    );
    const yearWhere =
      status === 'archived' ? historyScope(window) : currentYearScope(window.current);

    const allItems = await this.prisma.behaviorItem.findMany({
      where: {
        studentGuid,
        ...(bucket !== 'all' ? { classification: bucket } : {}),
        ...yearWhere,
      },
      orderBy: { eventAt: 'desc' },
    });

    const allIds = allItems.map((i) => i.id);
    const stateMap = userId
      ? await this.userItemStateService.getStateBatch(userId, 'behavior', allIds)
      : new Map<string, { isNew: boolean; isArchived: boolean }>();

    const effectiveState = (item: { id: string; schoolYear: number }) =>
      this.effectiveItemState(stateMap.get(item.id), item.schoolYear, window.current);

    const filtered = allItems.filter((item) => {
      const state = effectiveState(item);
      if (status === 'archived') return state.isArchived;
      if (status === 'new') return state.isNew && !state.isArchived;
      return !state.isArchived;
    });

    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, page * limit);

    return {
      data: paged.map((item) => {
        const state = effectiveState(item);
        return this.mapBehaviorItem(item, state.isNew, state.isArchived, state.isPastYear);
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
    const student = await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.behaviorItem.findUnique({
      where: { id: behaviorId },
    });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    // Unscoped by year for the same reason `getHomeworkDetail` is.
    const currentYear = await schoolYearForConnection(
      this.prisma,
      student.householdConnectionId,
    );
    const stored = userId
      ? await this.userItemStateService.getState(userId, 'behavior', behaviorId)
      : undefined;
    const state = this.effectiveItemState(stored, item.schoolYear, currentYear);

    return this.mapBehaviorItem(item, state.isNew, state.isArchived, state.isPastYear);
  }

  async downloadHomeworkAttachment(
    studentGuid: string,
    homeworkId: string,
    fileId: string,
    userId?: string,
    options?: DownloadOptions,
  ): Promise<DownloadedFile> {
    await this.requireStudent(studentGuid, userId);

    const homework = await this.prisma.homeworkItem.findUnique({
      where: { id: homeworkId },
    });
    if (!homework || homework.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    const file = extractHomeworkFiles(homework.files).find((entry) => entry.fileId === fileId);
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
      await this.scope.targetForStudent(studentGuid, userId),
      options,
    );
  }

  async downloadBehaviorAttachment(
    studentGuid: string,
    behaviorId: string,
    fileId: string,
    userId?: string,
    options?: DownloadOptions,
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
      await this.scope.targetForStudent(studentGuid, userId),
      options,
    );
  }

  async setHomeworkIsNew(studentGuid: string, homeworkId: string, isNew: boolean, userId?: string) {
    const student = await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.homeworkItem.findUnique({ where: { id: homeworkId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    // The derivation runs on the way out of every mutation too. Without it the
    // response would claim a past-year row is unarchived while the next read
    // of the same row says otherwise.
    const year = await schoolYearForConnection(this.prisma, student.householdConnectionId);
    const effective = (stored?: { isNew: boolean; isArchived: boolean }) =>
      this.effectiveItemState(stored, item.schoolYear, year);

    if (userId) {
      const currentState = await this.userItemStateService.getState(userId, 'homework', homeworkId);
      if (currentState.isArchived) {
        const state = effective(currentState);
        return this.mapHomeworkItem(item, state.isNew, state.isArchived, state.isPastYear);
      }
      const newState = await this.userItemStateService.setState(userId, 'homework', homeworkId, isNew, undefined);
      const state = effective(newState);
      return this.mapHomeworkItem(item, state.isNew, state.isArchived, state.isPastYear);
    }

    const state = effective({ isNew, isArchived: false });
    return this.mapHomeworkItem(item, state.isNew, state.isArchived, state.isPastYear);
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
    const student = await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.homeworkItem.findUnique({ where: { id: homeworkId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Homework not found: ${homeworkId}`);
    }

    const year = await schoolYearForConnection(this.prisma, student.householdConnectionId);
    const effective = (stored?: { isNew: boolean; isArchived: boolean }) =>
      this.effectiveItemState(stored, item.schoolYear, year);

    if (userId) {
      // Archive rules: archive=true forces isNew=false; unarchive=false forces isNew=true
      const newState = await this.userItemStateService.setState(
        userId, 'homework', homeworkId,
        isArchived ? false : true,
        isArchived,
      );
      // A past-year row stays archived whatever was written, which is why the
      // UI offers no restore control for one.
      const state = effective(newState);
      return this.mapHomeworkItem(item, state.isNew, state.isArchived, state.isPastYear);
    }

    const state = effective({ isNew: !isArchived, isArchived });
    return this.mapHomeworkItem(item, state.isNew, state.isArchived, state.isPastYear);
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
    const student = await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.behaviorItem.findUnique({ where: { id: behaviorId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    const year = await schoolYearForConnection(this.prisma, student.householdConnectionId);
    const effective = (stored?: { isNew: boolean; isArchived: boolean }) =>
      this.effectiveItemState(stored, item.schoolYear, year);

    if (userId) {
      const currentState = await this.userItemStateService.getState(userId, 'behavior', behaviorId);
      if (currentState.isArchived) {
        const state = effective(currentState);
        return this.mapBehaviorItem(item, state.isNew, state.isArchived, state.isPastYear);
      }
      const newState = await this.userItemStateService.setState(userId, 'behavior', behaviorId, isNew, undefined);
      const state = effective(newState);
      return this.mapBehaviorItem(item, state.isNew, state.isArchived, state.isPastYear);
    }

    const state = effective({ isNew, isArchived: false });
    return this.mapBehaviorItem(item, state.isNew, state.isArchived, state.isPastYear);
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
    const student = await this.requireStudent(studentGuid, userId);

    const item = await this.prisma.behaviorItem.findUnique({ where: { id: behaviorId } });
    if (!item || item.studentGuid !== studentGuid) {
      throw new NotFoundException(`Behavior item not found: ${behaviorId}`);
    }

    const year = await schoolYearForConnection(this.prisma, student.householdConnectionId);
    const effective = (stored?: { isNew: boolean; isArchived: boolean }) =>
      this.effectiveItemState(stored, item.schoolYear, year);

    if (userId) {
      const newState = await this.userItemStateService.setState(
        userId, 'behavior', behaviorId,
        isArchived ? false : true,
        isArchived,
      );
      const state = effective(newState);
      return this.mapBehaviorItem(item, state.isNew, state.isArchived, state.isPastYear);
    }

    const state = effective({ isNew: !isArchived, isArchived });
    return this.mapBehaviorItem(item, state.isNew, state.isArchived, state.isPastYear);
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
        await this.scope.targetForStudent(studentGuid, userId),
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
        await this.scope.targetForStudent(studentGuid, userId),
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
      await this.scope.targetForStudent(studentGuid, userId),
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
      await this.scope.targetForStudent(studentGuid, userId),
      { headers: { Referer: referer } },
    );
  }

  async createStudentRelease(studentGuid: string, body: unknown, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    const referer = 'https://web.mashov.info/students/main/studentsReleaseRequests';
    return this.mashovClient.putForTarget<void>(
      `/api/students/${studentGuid}/studentRelease/request`,
      body,
      await this.scope.targetForStudent(studentGuid, userId),
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
      await this.scope.targetForStudent(studentGuid, userId),
    );
  }

  async deleteStudentRelease(studentGuid: string, releaseId: number, userId?: string) {
    await this.requireStudent(studentGuid, userId);

    return this.mashovClient.deleteForTarget<void>(
      `/api/students/${studentGuid}/studentRelease/${releaseId}`,
      await this.scope.targetForStudent(studentGuid, userId),
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

  /**
   * The state a parent actually sees, which is the stored one widened by the
   * year the row sits in.
   *
   * A row from a year the student has already left is archived whether or not
   * anyone ever opened it, and it is not new -- mirroring the archive action,
   * which forces `isNew = false`. Nothing is written to do this: the flag is
   * derived on read, so it flips for the whole household the moment the
   * connection's `schoolYear` advances (ADR-0036).
   */
  private effectiveItemState(
    stored: { isNew: boolean; isArchived: boolean } | undefined,
    rowYear: number,
    currentYear: number,
  ): { isNew: boolean; isArchived: boolean; isPastYear: boolean } {
    const state = stored ?? { isNew: true, isArchived: false };
    const isPastYear = isPastSchoolYear(rowYear, currentYear);
    return {
      isNew: state.isNew && !isPastYear,
      isArchived: state.isArchived || isPastYear,
      isPastYear,
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
    isPastYear = false,
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
      // The frontend hides the archive toggle on a past-year row: restoring
      // it would write `isArchived = false` and move nothing, because the
      // derived rule outranks the stored flag.
      isPastYear,
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
    isPastYear = false,
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
      isPastYear,
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
    if (userId && !(await canSeeStudent(this.prisma, userId, studentGuid))) {
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
   * The `where` fragment that restricts a student list to one household.
   *
   * Reads the visibility edge, not the routing stamp: a child two parents
   * share is stamped to whichever of them synced last, so a stamp predicate
   * took the child away from the other one (ADR-0031). A child with no links
   * is admitted, which is the rule the NULL stamp already had -- see
   * `visibleStudentWhere`.
   */
  private async householdStudentWhere(userId: string) {
    return visibleStudentWhere(this.prisma, userId);
  }

  private async tryDownloadCandidates(
    candidates: Array<string | undefined | null>,
    referer: string,
    fallbackFileName: string,
    target: ConnectionTarget,
    options?: DownloadOptions,
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
          options,
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
    options?: DownloadOptions,
  ): Promise<DownloadedFile> {
    const response = await this.mashovClient.getResponseForTarget<ArrayBuffer>(
      pathOrUrl,
      target,
      {
        responseType: 'arraybuffer',
        headers: {
          Referer: referer,
        },
        // A fresh AbortSignal per candidate URL, not per download: a signal
        // that already fired on the first candidate would abort the retry
        // before it left the process.
        ...downloadTimeoutConfig(options),
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

  /**
   * Delegates to the shared parser. The key lists moved out because the digest
   * now needs the same reading to send a file to Telegram, and a second copy
   * would drift on the next field Mashov renames. See attachment-parser.ts.
   */
  private extractBehaviorFiles(rawPayload: unknown, fallbackLessonId: number): AttachmentMeta[] {
    return extractBehaviorFiles(rawPayload, fallbackLessonId);
  }

  private normalizeAttachmentMeta(
    value: unknown,
    fallbackLessonId?: number,
  ): AttachmentMeta | null {
    return parseAttachmentMeta(value, fallbackLessonId);
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
