import { apiFetch } from './client';
import type {
  ChildListItem,
  ChildrenResponse,
  ChildWorkspaceResponse,
  HomeworkResponse,
  HomeworkDetailResponse,
  HomeworkItem,
  BehaviorResponse,
  BehaviorDetailResponse,
  BehaviorItem,
  SubjectsResponse,
  GradesResponse,
  NoticesResponse,
  TimetableResponse,
  TimetableSchedule,
  BellPeriod,
  BellBreak,
  LessonPlansResponse,
  LessonHistoryResponse,
  BehaviorBucket,
  StudentRelease,
  SchoolActivity,
  UpdateStudentReleaseBody,
  CreateStudentReleaseBody,
  MarkIsNewRequest,
  MarkArchivedRequest,
  BulkUpdateResponse,
  HomeworkBulkIsNewRequest,
  HomeworkBulkArchiveRequest,
  BehaviorBulkIsNewRequest,
  BehaviorBulkArchiveRequest,
} from '@/types/api';
import { classifyBehavior } from '@/lib/behavior';

type UnknownRecord = Record<string, unknown>;

export async function fetchChildren(): Promise<ChildrenResponse> {
  const response = await apiFetch<ChildrenResponse | ChildListItem[]>('/children');
  if (Array.isArray(response)) {
    return {
      data: response.map((child) =>
        normalizeChildListItem(child as unknown as UnknownRecord),
      ),
    };
  }
  return {
    data: Array.isArray(response.data)
      ? response.data.map((child) =>
          normalizeChildListItem(child as unknown as UnknownRecord),
        )
      : [],
  };
}

export async function fetchChild(studentGuid: string): Promise<ChildWorkspaceResponse> {
  const response = await apiFetch<UnknownRecord>(`/children/${studentGuid}`);
  return normalizeChildWorkspace(response);
}

export async function fetchChildHomework(
  studentGuid: string,
  page = 1,
  limit = 50,
  status: 'new' | 'archived' | 'all' = 'new',
): Promise<HomeworkResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    status,
  });
  const response = await apiFetch<HomeworkResponse>(
    `/children/${studentGuid}/homework?${params.toString()}`,
  );
  return {
    data: Array.isArray(response.data)
      ? response.data.map((item) =>
          normalizeHomework(item as unknown as UnknownRecord),
        )
      : [],
    pagination: response.pagination,
  };
}

export async function fetchChildHomeworkDetail(
  studentGuid: string,
  homeworkId: string,
): Promise<HomeworkDetailResponse> {
  const response = await apiFetch<UnknownRecord>(
    `/children/${studentGuid}/homework/${homeworkId}`,
  );
  return normalizeHomework(response);
}

export async function fetchChildBehavior(
  studentGuid: string,
  page = 1,
  limit = 50,
  bucket: BehaviorBucket | 'all' = 'all',
  status: 'new' | 'archived' | 'all' = 'new',
): Promise<BehaviorResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    bucket,
    status,
  });
  const response = await apiFetch<BehaviorResponse>(
    `/children/${studentGuid}/behavior?${params.toString()}`,
  );
  return {
    data: Array.isArray(response.data)
      ? response.data.map((item) =>
          normalizeBehavior(item as unknown as UnknownRecord),
        )
      : [],
    pagination: response.pagination,
  };
}

export async function fetchChildBehaviorDetail(
  studentGuid: string,
  behaviorId: string,
): Promise<BehaviorDetailResponse> {
  const response = await apiFetch<UnknownRecord>(
    `/children/${studentGuid}/behavior/${behaviorId}`,
  );
  return normalizeBehavior(response);
}

export async function fetchChildSubjects(studentGuid: string): Promise<SubjectsResponse> {
  const response = await apiFetch<SubjectsResponse | { data: unknown[] } | unknown[]>(
    `/children/${studentGuid}/subjects`,
  );
  if (Array.isArray(response)) {
    return {
      data: response.map((item) =>
        normalizeSubject(item as unknown as UnknownRecord),
      ),
    };
  }
  const items = Array.isArray(response.data) ? response.data : [];
  return {
    data: items.map((item) => normalizeSubject(item as unknown as UnknownRecord)),
  };
}

export async function fetchChildGrades(studentGuid: string): Promise<GradesResponse> {
  const response = await apiFetch<GradesResponse | { data: unknown[] } | unknown[]>(
    `/children/${encodeURIComponent(studentGuid)}/grades`,
  );
  if (Array.isArray(response)) {
    return {
      data: response.map((item) => normalizeGrade(item as unknown as UnknownRecord)),
    };
  }
  const items = Array.isArray(response.data) ? response.data : [];
  return {
    data: items.map((item) => normalizeGrade(item as unknown as UnknownRecord)),
  };
}

export async function fetchChildNotices(studentGuid: string): Promise<NoticesResponse> {
  const response = await apiFetch<NoticesResponse | { data: unknown[] } | unknown[]>(
    `/children/${studentGuid}/notices`,
  );
  if (Array.isArray(response)) {
    return {
      data: response.map((item) =>
        normalizeNotice(item as unknown as UnknownRecord),
      ),
    };
  }
  const items = Array.isArray(response.data) ? response.data : [];
  return {
    data: items.map((item) => normalizeNotice(item as unknown as UnknownRecord)),
  };
}

export async function fetchChildTimetable(studentGuid: string): Promise<TimetableResponse> {
  const response = await apiFetch<TimetableResponse | { data: unknown[] } | unknown[]>(
    `/children/${encodeURIComponent(studentGuid)}/timetable`,
  );
  if (Array.isArray(response)) {
    return {
      data: response.map((item) => normalizeTimetableEntry(item as unknown as UnknownRecord)),
    };
  }
  const items = Array.isArray(response.data) ? response.data : [];
  return {
    data: items.map((item) => normalizeTimetableEntry(item as unknown as UnknownRecord)),
    schedule: normalizeTimetableSchedule((response as UnknownRecord).schedule),
  };
}

export async function fetchChildLessonPlans(studentGuid: string): Promise<LessonPlansResponse> {
  const response = await apiFetch<LessonPlansResponse | unknown[]>(
    `/children/${encodeURIComponent(studentGuid)}/lessons/plans`,
  );
  if (Array.isArray(response)) {
    return {
      data: response.map((item) => normalizeLessonPlan(item as unknown as UnknownRecord)),
    };
  }
  const items = Array.isArray(response.data) ? response.data : [];
  return {
    data: items.map((item) => normalizeLessonPlan(item as unknown as UnknownRecord)),
  };
}

export async function fetchChildLessonHistory(studentGuid: string): Promise<LessonHistoryResponse> {
  const response = await apiFetch<LessonHistoryResponse | { data: unknown[] } | unknown[]>(
    `/children/${encodeURIComponent(studentGuid)}/lessons/history`,
  );
  if (Array.isArray(response)) {
    return {
      data: response.map((item) =>
        normalizeLessonHistoryEntry(item as unknown as UnknownRecord),
      ),
    };
  }
  const items = Array.isArray(response.data) ? response.data : [];
  return {
    data: items.map((item) =>
      normalizeLessonHistoryEntry(item as unknown as UnknownRecord),
    ),
  };
}

export async function fetchStudentReleases(studentGuid: string): Promise<StudentRelease[]> {
  const response = await apiFetch<unknown[] | { data: unknown[] }>(
    `/children/${encodeURIComponent(studentGuid)}/releases`,
  );
  const items = Array.isArray(response)
    ? response
    : (Array.isArray(response.data) ? response.data : []);

  return items
    .map((item) => normalizeStudentRelease(item as unknown as UnknownRecord))
    .filter((item) => !item.isDeleted);
}

export async function fetchSchoolActivities(studentGuid: string): Promise<SchoolActivity[]> {
  const response = await apiFetch<unknown[] | { data: unknown[] }>(
    `/children/${encodeURIComponent(studentGuid)}/school-activities`,
  );
  const items = Array.isArray(response)
    ? response
    : (Array.isArray(response.data) ? response.data : []);

  return items.map((item) => normalizeSchoolActivity(item as unknown as UnknownRecord));
}

export async function createStudentRelease(
  studentGuid: string,
  body: CreateStudentReleaseBody,
): Promise<void> {
  await apiFetch<void>(
    `/children/${encodeURIComponent(studentGuid)}/releases/request`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  );
}

export async function updateStudentRelease(
  studentGuid: string,
  releaseId: number,
  body: UpdateStudentReleaseBody,
): Promise<void> {
  await apiFetch<void>(
    `/children/${encodeURIComponent(studentGuid)}/releases/${releaseId}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  );
}

export async function deleteStudentRelease(
  studentGuid: string,
  releaseId: number,
): Promise<void> {
  await apiFetch<void>(
    `/children/${encodeURIComponent(studentGuid)}/releases/${releaseId}`,
    { method: 'DELETE' },
  );
}

function normalizeChildListItem(item: UnknownRecord): ChildListItem {
  return {
    studentGuid: String(item.studentGuid ?? ''),
    privateName: String(item.privateName ?? ''),
    familyName: String(item.familyName ?? ''),
    fullName: String(item.fullName ?? ''),
    classCode: String(item.classCode ?? ''),
    classNum: Number(item.classNum ?? 0),
    gender: String(item.gender ?? ''),
    isActive: Boolean(item.isActive ?? true),
    recentHomeworkCount: Number(item.recentHomeworkCount ?? 0),
    recentBehaviorCount: Number(item.recentBehaviorCount ?? 0),
    positiveBehaviorCount: Number(item.positiveBehaviorCount ?? 0),
    neutralBehaviorCount: Number(item.neutralBehaviorCount ?? 0),
    subjectCount: Number(item.subjectCount ?? 0),
    latestUpdateAt:
      typeof item.latestUpdateAt === 'string' ? item.latestUpdateAt : null,
    // Absent on a backend that predates school fields, which is a valid
    // response: null reads as "no badge", not as a school called "null".
    schoolId: typeof item.schoolId === 'string' ? item.schoolId : null,
    schoolName: typeof item.schoolName === 'string' ? item.schoolName : null,
    schoolShortLabel:
      typeof item.schoolShortLabel === 'string' ? item.schoolShortLabel : null,
    semel: typeof item.semel === 'number' ? item.semel : null,
  };
}

function normalizeChildWorkspace(response: UnknownRecord): ChildWorkspaceResponse {
  const studentRaw = (response.student ?? {}) as UnknownRecord;
  const homework = Array.isArray(response.homework) ? response.homework : [];
  const behavior = Array.isArray(response.behavior) ? response.behavior : [];
  const subjects = Array.isArray(response.subjects) ? response.subjects : [];
  const summaryRaw = (response.summary ?? {}) as UnknownRecord;

  return {
    student: {
      studentGuid: String(studentRaw.studentGuid ?? ''),
      privateName: String(studentRaw.privateName ?? ''),
      familyName: String(studentRaw.familyName ?? ''),
      fullName: String(studentRaw.fullName ?? ''),
      classCode: String(studentRaw.classCode ?? ''),
      classNum: Number(studentRaw.classNum ?? 0),
      gender: String(studentRaw.gender ?? ''),
      isActive: Boolean(studentRaw.isActive ?? true),
    },
    summary: {
      recentHomeworkCount: Number(
        summaryRaw.recentHomeworkCount ?? homework.length ?? 0,
      ),
      recentBehaviorCount: Number(
        summaryRaw.recentBehaviorCount ?? behavior.length ?? 0,
      ),
      positiveBehaviorCount: Number(summaryRaw.positiveBehaviorCount ?? 0),
      neutralBehaviorCount: Number(summaryRaw.neutralBehaviorCount ?? 0),
      subjectCount: Number(summaryRaw.subjectCount ?? subjects.length ?? 0),
      totalWeeklyHours: Number(summaryRaw.totalWeeklyHours ?? 0),
    },
    lastSyncAt: typeof response.lastSyncAt === 'string' ? response.lastSyncAt : null,
  };
}

function normalizeHomework(item: UnknownRecord) {
  return {
    ...item,
    id: String(item.id ?? ''),
    studentGuid: String(item.studentGuid ?? ''),
    lessonId: Number(item.lessonId ?? 0),
    groupId: Number(item.groupId ?? 0),
    lessonDate: String(item.lessonDate ?? ''),
    lesson: Number(item.lesson ?? 0),
    subjectName: String(item.subjectName ?? ''),
    homeworkText: String(item.homeworkText ?? ''),
    remark:
      typeof item.remark === 'string' || item.remark === null
        ? item.remark
        : null,
    files: Array.isArray(item.files) ? item.files : [],
    isNew: Boolean(item.isNew),
    isArchived: Boolean(item.isArchived),
    // Absent on a response from a backend that predates the derivation, which
    // reads as "this year" -- the behaviour the UI had before it existed.
    isPastYear: Boolean(item.isPastYear),
    updatedAt: String(item.updatedAt ?? ''),
  };
}

function normalizeBehavior(item: UnknownRecord) {
  const fallbackClassification =
    typeof item.classification === 'string' ? item.classification : 'neutral';
  const fallbackBucket =
    fallbackClassification === 'attention' ||
    fallbackClassification === 'positive' ||
    fallbackClassification === 'neutral'
      ? fallbackClassification
      : 'neutral';
  const achvaCode = Number(item.achvaCode ?? item.eventCode ?? 0);
  const behaviorMeta = classifyBehavior(achvaCode, String(item.achvaName ?? ''));
  const files = Array.isArray(item.files) ? item.files : [];

  return {
    ...item,
    id: String(item.id ?? ''),
    studentGuid: String(item.studentGuid ?? ''),
    lessonId: Number(item.lessonId ?? 0),
    groupId: Number(item.groupId ?? 0),
    eventCode: Number(item.eventCode ?? 0),
    achvaCode,
    achvaName: String(item.achvaName ?? ''),
    bucket:
      (typeof item.bucket === 'string' ? item.bucket : fallbackBucket) as BehaviorBucket,
    priority:
      (typeof item.priority === 'string' ? item.priority : behaviorMeta.priority) as
      | 'high'
      | 'medium'
      | 'low',
    justifiable: Boolean(item.justifiable),
    lessonDate: String(item.lessonDate ?? ''),
    lesson:
      typeof item.lesson === 'number' || item.lesson === null ? item.lesson : null,
    subject: String(item.subject ?? ''),
    reporter: String(item.reporter ?? ''),
    remark:
      typeof item.remark === 'string' || item.remark === null ? item.remark : null,
    justification:
      typeof item.justification === 'string' || item.justification === null
        ? item.justification
        : null,
    files,
    eventAt: String(item.eventAt ?? ''),
    isNew: Boolean(item.isNew),
    isArchived: Boolean(item.isArchived),
    isPastYear: Boolean(item.isPastYear),
    updatedAt: String(item.updatedAt ?? ''),
  };
}

function normalizeSubject(item: UnknownRecord) {
  return {
    id: String(item.id ?? ''),
    studentGuid: String(item.studentGuid ?? ''),
    groupId: Number(item.groupId ?? 0),
    groupName: String(item.groupName ?? ''),
    subjectName: String(item.subjectName ?? ''),
    teachers: Array.isArray(item.teachers) ? item.teachers : [],
    inactiveTeachers: Array.isArray(item.inactiveTeachers)
      ? item.inactiveTeachers
      : [],
    weeklyHours: Number(item.weeklyHours ?? 0),
    lessonsCount: Number(item.lessonsCount ?? 0),
    updatedAt: String(item.updatedAt ?? ''),
  };
}

function normalizeGrade(item: UnknownRecord) {
  return {
    id: String(item.id ?? ''),
    studentGuid: String(item.studentGuid ?? ''),
    gradingEventId: Number(item.gradingEventId ?? 0),
    grade: Number(item.grade ?? 0),
    gradingPeriod: Number(item.gradingPeriod ?? 0),
    gradeTypeId: Number(item.gradeTypeId ?? 0),
    gradeType: String(item.gradeType ?? ''),
    gradingEvent: String(item.gradingEvent ?? ''),
    groupId: Number(item.groupId ?? 0),
    groupName: String(item.groupName ?? ''),
    subjectName: String(item.subjectName ?? ''),
    teacherName: String(item.teacherName ?? ''),
    eventDate: String(item.eventDate ?? ''),
    enteredAt: String(item.enteredAt ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
  };
}

function normalizeNotice(item: UnknownRecord) {
  return {
    id: String(item.id ?? ''),
    studentGuid: String(item.studentGuid ?? ''),
    eventId: Number(item.eventId ?? 0),
    eventText: String(item.eventText ?? ''),
    expirationDate: String(item.expirationDate ?? ''),
    inSite: Boolean(item.inSite),
    updatedAt: String(item.updatedAt ?? ''),
  };
}

function normalizeTimetableEntry(item: UnknownRecord) {
  const teachersRaw = Array.isArray(item.teachers) ? item.teachers : [];
  return {
    id: String(item.id ?? ''),
    studentGuid: String(item.studentGuid ?? ''),
    groupId: Number(item.groupId ?? 0),
    day: Number(item.day ?? 0),
    lesson: Number(item.lesson ?? 0),
    roomNum: String(item.roomNum ?? ''),
    weeks: Number(item.weeks ?? -1),
    groupName: String(item.groupName ?? ''),
    subjectName: String(item.subjectName ?? ''),
    teachers: teachersRaw.map((t) => {
      const teacher = t as UnknownRecord;
      return {
        teacherGuid: String(teacher.teacherGuid ?? ''),
        teacherName: String(teacher.teacherName ?? ''),
      };
    }),
    updatedAt: String(item.updatedAt ?? ''),
  };
}

/** A clock reading the grid can render, or `undefined`. */
function normalizeClockValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : undefined;
}

function normalizeBellPeriod(item: unknown): BellPeriod | undefined {
  const row = (item ?? {}) as UnknownRecord;
  const lesson = Number(row.lesson);
  const startTime = normalizeClockValue(row.startTime);
  const endTime = normalizeClockValue(row.endTime);
  if (!Number.isInteger(lesson) || lesson <= 0 || !startTime || !endTime) return undefined;
  return { lesson, startTime, endTime };
}

function normalizeBellBreak(item: unknown): BellBreak | undefined {
  const row = (item ?? {}) as UnknownRecord;
  const afterLesson = Number(row.afterLesson);
  const minutes = Number(row.minutes);
  const startTime = normalizeClockValue(row.startTime);
  const endTime = normalizeClockValue(row.endTime);
  if (!Number.isInteger(afterLesson) || afterLesson <= 0) return undefined;
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (!startTime || !endTime) return undefined;
  return {
    afterLesson,
    startTime,
    endTime,
    minutes,
    kind: row.kind === 'lunch' ? 'lunch' : 'recess',
  };
}

/**
 * The bell schedule, or `undefined` when there is nothing usable in it.
 *
 * Tolerant by design: a backend older than this field answers without it, and
 * the grid has to render either way. A half-malformed payload loses only the
 * rows that are malformed — but a payload with no usable period at all is
 * reported as absent, because `source` without times would make the UI
 * caveat a schedule it is not showing.
 */
export function normalizeTimetableSchedule(value: unknown): TimetableSchedule | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as UnknownRecord;

  const periods = (Array.isArray(raw.periods) ? raw.periods : [])
    .map(normalizeBellPeriod)
    .filter((period): period is BellPeriod => period !== undefined);
  if (periods.length === 0) return undefined;

  const breaks = (Array.isArray(raw.breaks) ? raw.breaks : [])
    .map(normalizeBellBreak)
    .filter((item): item is BellBreak => item !== undefined);

  return {
    // Anything that is not explicitly the school's own is a default, so an
    // unrecognized value errs towards captioning the times as approximate.
    source: raw.source === 'school' ? 'school' : 'default',
    periods,
    breaks,
  };
}

function normalizeLessonPlan(item: UnknownRecord) {
  return {
    groupid: Number(item.groupid ?? 0),
    lessondate: String(item.lessondate ?? ''),
    lesson: Number(item.lesson ?? 0),
    plan: String(item.plan ?? ''),
    lessonLink:
      typeof item.lessonLink === 'string' && item.lessonLink.length > 0
        ? item.lessonLink
        : undefined,
  };
}

function normalizeLessonHistoryEntry(item: UnknownRecord) {
  const lessonLogRaw = (item.lessonLog ?? {}) as UnknownRecord;
  return {
    groupName: String(item.groupName ?? ''),
    subjectName: String(item.subjectName ?? ''),
    lessonLog: {
      lessonID: Number(lessonLogRaw.lessonID ?? 0),
      groupId: Number(lessonLogRaw.groupId ?? 0),
      lessonDate: String(lessonLogRaw.lessonDate ?? ''),
      lesson: Number(lessonLogRaw.lesson ?? 0),
      tookPlace: Boolean(lessonLogRaw.tookPlace),
      remark: String(lessonLogRaw.remark ?? ''),
      homeWork:
        typeof lessonLogRaw.homeWork === 'string' && lessonLogRaw.homeWork.length > 0
          ? lessonLogRaw.homeWork
          : undefined,
      lessontype: Number(lessonLogRaw.lessontype ?? 0),
      reporterid: Number(lessonLogRaw.reporterid ?? 0),
      reporterGuid: String(lessonLogRaw.reporterGuid ?? ''),
    },
  };
}

function normalizeStudentRelease(item: UnknownRecord): StudentRelease {
  return {
    id: Number(item.id ?? 0),
    studentGuid: String(item.studentGuid ?? ''),
    contactGuid: String(item.contactGuid ?? ''),
    releaseDate: String(item.releaseDate ?? ''),
    startHour: String(item.startHour ?? '00:00:00'),
    remark: typeof item.remark === 'string' ? item.remark : '',
    status: Number(item.status ?? 0),
    isDeleted: Boolean(item.isDeleted),
    requestEditTime: String(item.requestEditTime ?? ''),
  };
}

function normalizeSchoolActivity(item: UnknownRecord): SchoolActivity {
  return {
    id: Number(item.id ?? 0),
    createTime: String(item.createTime ?? ''),
    activityStartDate: String(item.activityStartDate ?? ''),
    activityEndDate: String(item.activityEndDate ?? ''),
    activityType: Number(item.activityType ?? 0),
    creatorGuid: String(item.creatorGuid ?? ''),
    title: String(item.title ?? ''),
    description: String(item.description ?? ''),
    endAnswerDate: String(item.endAnswerDate ?? ''),
    isAnswered: Boolean(item.isAnswered),
  };
}

export function markHomeworkIsNew(
  studentGuid: string,
  homeworkId: string,
  isNew: boolean,
): Promise<HomeworkItem> {
  const body: MarkIsNewRequest = { isNew };
  return apiFetch<HomeworkItem>(
    `/children/${studentGuid}/homework/${homeworkId}/is-new`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export function archiveHomework(
  studentGuid: string,
  homeworkId: string,
  isArchived: boolean,
): Promise<HomeworkItem> {
  const body: MarkArchivedRequest = { isArchived };
  return apiFetch<HomeworkItem>(
    `/children/${studentGuid}/homework/${homeworkId}/archive`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export function markBehaviorIsNew(
  studentGuid: string,
  behaviorId: string,
  isNew: boolean,
): Promise<BehaviorItem> {
  const body: MarkIsNewRequest = { isNew };
  return apiFetch<BehaviorItem>(
    `/children/${studentGuid}/behavior/${behaviorId}/is-new`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export function archiveBehavior(
  studentGuid: string,
  behaviorId: string,
  isArchived: boolean,
): Promise<BehaviorItem> {
  const body: MarkArchivedRequest = { isArchived };
  return apiFetch<BehaviorItem>(
    `/children/${studentGuid}/behavior/${behaviorId}/archive`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export function markHomeworkManyIsNew(
  studentGuid: string,
  homeworkIds: string[],
  isNew: boolean,
): Promise<BulkUpdateResponse> {
  const body: HomeworkBulkIsNewRequest = { homeworkIds, isNew };
  return apiFetch<BulkUpdateResponse>(
    `/children/${studentGuid}/homework/is-new`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export function archiveHomeworkMany(
  studentGuid: string,
  homeworkIds: string[],
  isArchived: boolean,
): Promise<BulkUpdateResponse> {
  const body: HomeworkBulkArchiveRequest = { homeworkIds, isArchived };
  return apiFetch<BulkUpdateResponse>(
    `/children/${studentGuid}/homework/archive`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export function markBehaviorManyIsNew(
  studentGuid: string,
  behaviorIds: string[],
  isNew: boolean,
): Promise<BulkUpdateResponse> {
  const body: BehaviorBulkIsNewRequest = { behaviorIds, isNew };
  return apiFetch<BulkUpdateResponse>(
    `/children/${studentGuid}/behavior/is-new`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export function archiveBehaviorMany(
  studentGuid: string,
  behaviorIds: string[],
  isArchived: boolean,
): Promise<BulkUpdateResponse> {
  const body: BehaviorBulkArchiveRequest = { behaviorIds, isArchived };
  return apiFetch<BulkUpdateResponse>(
    `/children/${studentGuid}/behavior/archive`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}
