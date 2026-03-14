import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchChild,
  fetchChildHomework,
  fetchChildHomeworkDetail,
  fetchChildBehavior,
  fetchChildBehaviorDetail,
  fetchChildSubjects,
  fetchChildNotices,
} from '@/api/children';
import { upsertReadState } from '@/api/readState';
import type { BehaviorBucket, ReadStateRequest } from '@/types/api';

export function useChild(studentGuid: string) {
  return useQuery({
    queryKey: ['child', studentGuid],
    queryFn: () => fetchChild(studentGuid),
    staleTime: 60_000,
    enabled: Boolean(studentGuid),
  });
}

export function useChildHomework(studentGuid: string, page = 1) {
  return useQuery({
    queryKey: ['child-homework', studentGuid, page],
    queryFn: () => fetchChildHomework(studentGuid, page),
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
) {
  return useQuery({
    queryKey: ['child-behavior', studentGuid, page, bucket],
    queryFn: () => fetchChildBehavior(studentGuid, page, 50, bucket),
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

export function useMarkHandled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: ReadStateRequest) => upsertReadState(req),
    onSuccess: (_data, variables) => {
      // Invalidate relevant queries
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (variables.itemType === 'homework') {
        void queryClient.invalidateQueries({ queryKey: ['child-homework'] });
        void queryClient.invalidateQueries({ queryKey: ['child-homework-detail'] });
      }
      if (variables.itemType === 'behavior') {
        void queryClient.invalidateQueries({ queryKey: ['child-behavior'] });
        void queryClient.invalidateQueries({ queryKey: ['child-behavior-detail'] });
      }
    },
  });
}
