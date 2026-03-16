import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  markHomeworkManyIsNew,
  archiveHomeworkMany,
  markBehaviorManyIsNew,
  archiveBehaviorMany,
} from '@/api/children';

interface HomeworkBulkIsNewInput {
  homeworkIds: string[];
  isNew: boolean;
}

interface HomeworkBulkArchiveInput {
  homeworkIds: string[];
  isArchived: boolean;
}

interface BehaviorBulkIsNewInput {
  behaviorIds: string[];
  isNew: boolean;
}

interface BehaviorBulkArchiveInput {
  behaviorIds: string[];
  isArchived: boolean;
}

export function useBulkHomeworkIsNew(studentGuid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ homeworkIds, isNew }: HomeworkBulkIsNewInput) =>
      markHomeworkManyIsNew(studentGuid, homeworkIds, isNew),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['child-homework', studentGuid] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useBulkHomeworkArchive(studentGuid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ homeworkIds, isArchived }: HomeworkBulkArchiveInput) =>
      archiveHomeworkMany(studentGuid, homeworkIds, isArchived),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['child-homework', studentGuid] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useBulkBehaviorIsNew(studentGuid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ behaviorIds, isNew }: BehaviorBulkIsNewInput) =>
      markBehaviorManyIsNew(studentGuid, behaviorIds, isNew),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['child-behavior', studentGuid] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useBulkBehaviorArchive(studentGuid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ behaviorIds, isArchived }: BehaviorBulkArchiveInput) =>
      archiveBehaviorMany(studentGuid, behaviorIds, isArchived),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['child-behavior', studentGuid] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
