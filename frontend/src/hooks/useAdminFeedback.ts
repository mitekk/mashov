import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAdminFeedback,
  fetchAdminFeedbackDetail,
  markAdminFeedbackResponded,
} from '@/api/adminFeedback';
import type { AdminFeedbackFilter } from '@/types/api';

/**
 * The triage list, narrowed to one lens.
 *
 * `filter` and `page` are part of the key, so switching lens refetches
 * server-side rather than re-filtering a page already in hand -- the house
 * rule, documented at `useMail.ts`. It is also what makes the totals be over
 * the filtered set: a client-side pass would show "43" next to three rows.
 */
export function useAdminFeedbackList(filter: AdminFeedbackFilter, page = 1) {
  return useQuery({
    queryKey: ['admin-feedback', filter, page],
    queryFn: () => fetchAdminFeedback(filter, page),
    staleTime: 15_000,
  });
}

/**
 * One report.
 *
 * `staleTime: 0` deliberately: this GET has a side effect server-side (it
 * stamps `readAt`), and an operator who navigates back and forth should see
 * the state they just caused rather than a cached row that still says "new".
 */
export function useAdminFeedbackDetail(id: string) {
  return useQuery({
    queryKey: ['admin-feedback-detail', id],
    queryFn: () => fetchAdminFeedbackDetail(id),
    enabled: id.length > 0,
    staleTime: 0,
  });
}

/**
 * Record that this parent has been answered.
 *
 * Invalidates by bare key prefix, so every lens and page of the list is
 * refetched -- a row leaving `awaiting` must leave it everywhere. No optimistic
 * update: there are none anywhere in this codebase, and the server's response
 * is the row itself.
 */
export function useMarkAdminFeedbackResponded(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markAdminFeedbackResponded(id),
    onSuccess: (response) => {
      queryClient.setQueryData(['admin-feedback-detail', id], response);
      void queryClient.invalidateQueries({ queryKey: ['admin-feedback'] });
    },
  });
}
