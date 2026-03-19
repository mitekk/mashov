import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import {
  markHomeworkIsNew,
  markBehaviorIsNew,
} from '@/api/children';
import {
  markConversationsRead,
  markConversationsUnread,
} from '@/api/mail';

export type MarkNewItemType = 'homework' | 'behavior' | 'conversation';

interface UseMarkNewOptions {
  type: MarkNewItemType;
  id: string;
  studentGuid?: string;
  invalidateKeys?: QueryKey[];
}

export function useMarkNew({
  type,
  id,
  studentGuid,
  invalidateKeys = [['dashboard']],
}: UseMarkNewOptions) {
  const queryClient = useQueryClient();

  const mutationFn = async (isNew: boolean): Promise<unknown> => {
    if (type === 'homework') {
      if (!studentGuid) throw new Error('studentGuid required for homework');
      return markHomeworkIsNew(studentGuid, id, isNew);
    }
    if (type === 'behavior') {
      if (!studentGuid) throw new Error('studentGuid required for behavior');
      return markBehaviorIsNew(studentGuid, id, isNew);
    }
    // conversation: isNew=false → mark-read, isNew=true → mark-unread
    if (!isNew) {
      return markConversationsRead([id]);
    }
    return markConversationsUnread([id]);
  };

  return useMutation({
    mutationFn,
    onSuccess: () => {
      invalidateKeys.forEach((key) => {
        void queryClient.invalidateQueries({ queryKey: key });
      });
      if (studentGuid) {
        void queryClient.invalidateQueries({ queryKey: ['children'] });
        void queryClient.invalidateQueries({ queryKey: ['child', studentGuid] });
      }
    },
  });
}
