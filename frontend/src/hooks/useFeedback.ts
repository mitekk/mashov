import { useMutation } from '@tanstack/react-query';
import { submitFeedback } from '@/api/feedback';
import type { CreateFeedbackBody } from '@/types/api';

/**
 * Send one report.
 *
 * No `onSuccess` invalidation: nothing in the app reads feedback back, so
 * there is no cached query a successful send could stale.
 */
export function useSubmitFeedback() {
  return useMutation({
    mutationFn: (body: CreateFeedbackBody) => submitFeedback(body),
  });
}
