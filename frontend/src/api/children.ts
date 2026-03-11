import { apiFetch } from './client';
import type {
  ChildrenResponse,
  ChildWorkspaceResponse,
  HomeworkResponse,
  BehaviorResponse,
  SubjectsResponse,
  NoticesResponse,
  BehaviorBucket,
} from '@/types/api';

export function fetchChildren(): Promise<ChildrenResponse> {
  return apiFetch<ChildrenResponse>('/children');
}

export function fetchChild(studentGuid: string): Promise<ChildWorkspaceResponse> {
  return apiFetch<ChildWorkspaceResponse>(`/children/${studentGuid}`);
}

export function fetchChildHomework(
  studentGuid: string,
  page = 1,
  limit = 50,
): Promise<HomeworkResponse> {
  return apiFetch<HomeworkResponse>(
    `/children/${studentGuid}/homework?page=${page}&limit=${limit}`,
  );
}

export function fetchChildBehavior(
  studentGuid: string,
  page = 1,
  limit = 50,
  bucket: BehaviorBucket | 'all' = 'all',
): Promise<BehaviorResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    bucket,
  });
  return apiFetch<BehaviorResponse>(
    `/children/${studentGuid}/behavior?${params.toString()}`,
  );
}

export function fetchChildSubjects(studentGuid: string): Promise<SubjectsResponse> {
  return apiFetch<SubjectsResponse>(`/children/${studentGuid}/subjects`);
}

export function fetchChildNotices(studentGuid: string): Promise<NoticesResponse> {
  return apiFetch<NoticesResponse>(`/children/${studentGuid}/notices`);
}
