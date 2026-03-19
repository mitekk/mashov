import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import {
  archiveHomework,
  archiveBehavior,
} from '@/api/children';

export type ArchiveItemType = 'homework' | 'behavior';

interface UseArchiveOptions {
  type: ArchiveItemType;
  id: string;
  studentGuid: string;
  invalidateKeys?: QueryKey[];
}

export function useArchive({
  type,
  id,
  studentGuid,
  invalidateKeys = [['dashboard']],
}: UseArchiveOptions) {
  const queryClient = useQueryClient();

  const mutationFn = (isArchived: boolean): Promise<unknown> => {
    if (type === 'homework') {
      return archiveHomework(studentGuid, id, isArchived);
    }
    return archiveBehavior(studentGuid, id, isArchived);
  };

  return useMutation({
    mutationFn,
    onSuccess: () => {
      invalidateKeys.forEach((key) => {
        void queryClient.invalidateQueries({ queryKey: key });
      });
      void queryClient.invalidateQueries({ queryKey: ['children'] });
      void queryClient.invalidateQueries({ queryKey: ['child', studentGuid] });
    },
  });
}
