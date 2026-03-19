import { useQuery } from '@tanstack/react-query';
import {
  fetchChild,
  fetchChildHomework,
  fetchChildHomeworkDetail,
  fetchChildBehavior,
  fetchChildBehaviorDetail,
  fetchChildSubjects,
  fetchChildNotices,
  fetchChildTimetable,
  fetchChildLessonPlans,
  fetchChildLessonHistory,
} from '@/api/children';
import type { BehaviorBucket } from '@/types/api';

export function useChild(studentGuid: string) {
  return useQuery({
    queryKey: ['child', studentGuid],
    queryFn: () => fetchChild(studentGuid),
    staleTime: 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildHomework(
  studentGuid: string,
  page = 1,
  status: 'new' | 'archived' | 'all' = 'new',
) {
  return useQuery({
    queryKey: ['child-homework', studentGuid, page, status],
    queryFn: () => fetchChildHomework(studentGuid, page, 50, status),
    staleTime: 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildHomeworkDetail(studentGuid: string, homeworkId: string) {
  return useQuery({
    queryKey: ['child-homework-detail', studentGuid, homeworkId],
    queryFn: () => fetchChildHomeworkDetail(studentGuid, homeworkId),
    staleTime: 60_000,
    enabled: Boolean(studentGuid && homeworkId),
  });
}

export function useChildBehavior(
  studentGuid: string,
  page = 1,
  bucket: BehaviorBucket | 'all' = 'all',
  status: 'new' | 'archived' | 'all' = 'new',
) {
  return useQuery({
    queryKey: ['child-behavior', studentGuid, page, bucket, status],
    queryFn: () => fetchChildBehavior(studentGuid, page, 50, bucket, status),
    staleTime: 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildBehaviorDetail(studentGuid: string, behaviorId: string) {
  return useQuery({
    queryKey: ['child-behavior-detail', studentGuid, behaviorId],
    queryFn: () => fetchChildBehaviorDetail(studentGuid, behaviorId),
    staleTime: 60_000,
    enabled: Boolean(studentGuid && behaviorId),
  });
}

export function useChildSubjects(studentGuid: string) {
  return useQuery({
    queryKey: ['child-subjects', studentGuid],
    queryFn: () => fetchChildSubjects(studentGuid),
    staleTime: 5 * 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildNotices(studentGuid: string) {
  return useQuery({
    queryKey: ['child-notices', studentGuid],
    queryFn: () => fetchChildNotices(studentGuid),
    staleTime: 5 * 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildTimetable(studentGuid: string) {
  return useQuery({
    queryKey: ['child-timetable', studentGuid],
    queryFn: () => fetchChildTimetable(studentGuid),
    staleTime: 5 * 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildLessonPlans(studentGuid: string) {
  return useQuery({
    queryKey: ['child-lesson-plans', studentGuid],
    queryFn: () => fetchChildLessonPlans(studentGuid),
    staleTime: 30 * 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildLessonHistory(studentGuid: string) {
  return useQuery({
    queryKey: ['child-lesson-history', studentGuid],
    queryFn: () => fetchChildLessonHistory(studentGuid),
    staleTime: 30 * 60_000,
    enabled: Boolean(studentGuid),
  });
}
