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
  NoticesResponse,
  BehaviorBucket,
  MarkIsNewRequest,
  MarkArchivedRequest,
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
  status: 'active' | 'archived' = 'active',
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
  status: 'active' | 'archived' = 'active',
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
    subjectCount: Number(item.subjectCount ?? 0),
    latestUpdateAt:
      typeof item.latestUpdateAt === 'string' ? item.latestUpdateAt : null,
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
      subjectCount: Number(summaryRaw.subjectCount ?? subjects.length ?? 0),
      totalWeeklyHours: Number(summaryRaw.totalWeeklyHours ?? 0),
      attentionBehaviorCount: Number(summaryRaw.attentionBehaviorCount ?? 0),
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
