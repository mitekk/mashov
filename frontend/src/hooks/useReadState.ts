import { useMutation, useQueryClient } from '@tanstack/react-query';
import { upsertReadState } from '@/api/readState';
import type { ReadStateRequest, ReadStateItemType } from '@/types/api';

interface UseReadStateOptions {
  invalidateKeys?: string[][];
}

export function useReadState(options: UseReadStateOptions = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: ReadStateRequest) => upsertReadState(req),
    onSuccess: () => {
      const keys = options.invalidateKeys ?? [['dashboard']];
      keys.forEach((key) => {
        void queryClient.invalidateQueries({ queryKey: key });
      });
    },
  });
}

export function useMarkHandled(
  itemType: ReadStateItemType,
  itemId: string,
  invalidateKeys?: string[][],
) {
  const { mutate, isPending } = useReadState({ invalidateKeys });

  const markHandled = (isHandled: boolean) => {
    mutate({ itemType, itemId, isRead: true, isHandled });
  };

  return { markHandled, isPending };
}
