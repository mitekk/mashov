import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FeedItem } from '@/types/api';
import {
  archiveBehaviorMany,
  archiveHomeworkMany,
  markBehaviorManyIsNew,
  markHomeworkManyIsNew,
} from '@/api/children';
import {
  archiveConversations,
  markConversationsRead,
  markConversationsUnread,
  unarchiveConversations,
} from '@/api/mail';

interface FeedBulkIsNewInput {
  items: FeedItem[];
  isNew: boolean;
}

interface FeedBulkArchiveInput {
  items: FeedItem[];
  isArchived: boolean;
}

function hasStudentGuid(item: FeedItem): item is FeedItem & { studentGuid: string } {
  return typeof item.studentGuid === 'string' && item.studentGuid.trim().length > 0;
}

function groupByStudentGuid(items: FeedItem[]): Map<string, FeedItem[]> {
  const grouped = new Map<string, FeedItem[]>();

  items.forEach((item) => {
    if (!hasStudentGuid(item)) return;
    const group = grouped.get(item.studentGuid) ?? [];
    group.push(item);
    grouped.set(item.studentGuid, group);
  });

  return grouped;
}

function uniqueIds(items: FeedItem[], source: 'id' | 'sourceId' = 'id'): string[] {
  return [...new Set(items.map((item) => item[source]).filter((value) => value.length > 0))];
}

export function useFeedBulkActions() {
  const queryClient = useQueryClient();

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['children'] });
    void queryClient.invalidateQueries({ queryKey: ['child-homework'] });
    void queryClient.invalidateQueries({ queryKey: ['child-behavior'] });
    void queryClient.invalidateQueries({ queryKey: ['child'] });
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['mail-summary'] });
  };

  const markIsNew = useMutation({
    mutationFn: async ({ items, isNew }: FeedBulkIsNewInput) => {
      if (items.length === 0) return;

      const activeItems = items.filter((item) => !item.isArchived);
      const homeworkItems = activeItems.filter((item) => item.sourceType === 'homework');
      const behaviorItems = activeItems.filter(
        (item) => item.sourceType === 'behavior' || item.sourceType === 'positive',
      );
      const mailItems = activeItems.filter((item) => item.sourceType === 'mail');

      const homeworkGroups = groupByStudentGuid(homeworkItems);
      const behaviorGroups = groupByStudentGuid(behaviorItems);
      const tasks: Array<Promise<unknown>> = [];

      homeworkGroups.forEach((groupItems, studentGuid) => {
        const homeworkIds = uniqueIds(groupItems, 'id');
        if (homeworkIds.length === 0) return;
        tasks.push(markHomeworkManyIsNew(studentGuid, homeworkIds, isNew));
      });

      behaviorGroups.forEach((groupItems, studentGuid) => {
        const behaviorIds = uniqueIds(groupItems, 'id');
        if (behaviorIds.length === 0) return;
        tasks.push(markBehaviorManyIsNew(studentGuid, behaviorIds, isNew));
      });

      const conversationIds = uniqueIds(mailItems, 'sourceId');
      if (conversationIds.length > 0) {
        tasks.push(isNew
          ? markConversationsUnread(conversationIds)
          : markConversationsRead(conversationIds));
      }

      await Promise.all(tasks);
    },
    onSuccess: invalidateAll,
  });

  const archive = useMutation({
    mutationFn: async ({ items, isArchived }: FeedBulkArchiveInput) => {
      if (items.length === 0) return;

      const homeworkItems = items.filter((item) => item.sourceType === 'homework');
      const behaviorItems = items.filter(
        (item) => item.sourceType === 'behavior' || item.sourceType === 'positive',
      );
      const mailItems = items.filter((item) => item.sourceType === 'mail');

      const homeworkGroups = groupByStudentGuid(homeworkItems);
      const behaviorGroups = groupByStudentGuid(behaviorItems);
      const tasks: Array<Promise<unknown>> = [];

      homeworkGroups.forEach((groupItems, studentGuid) => {
        const homeworkIds = uniqueIds(groupItems, 'id');
        if (homeworkIds.length === 0) return;
        tasks.push(archiveHomeworkMany(studentGuid, homeworkIds, isArchived));
      });

      behaviorGroups.forEach((groupItems, studentGuid) => {
        const behaviorIds = uniqueIds(groupItems, 'id');
        if (behaviorIds.length === 0) return;
        tasks.push(archiveBehaviorMany(studentGuid, behaviorIds, isArchived));
      });

      const conversationIds = uniqueIds(mailItems, 'sourceId');
      if (conversationIds.length > 0) {
        tasks.push(isArchived
          ? archiveConversations(conversationIds)
          : unarchiveConversations(conversationIds));
      }

      await Promise.all(tasks);
    },
    onSuccess: invalidateAll,
  });

  return { markIsNew, archive };
}
