import { apiFetch } from './client';
import type { CreateFeedbackBody, FeedbackReceipt, FeedbackResponse } from '@/types/api';

/**
 * Send one feedback report.
 *
 * Write-only: the receipt carries an id and a timestamp and nothing the parent
 * wrote, because there is no screen that reads a report back.
 */
export async function submitFeedback(body: CreateFeedbackBody): Promise<FeedbackReceipt> {
  const response = await apiFetch<FeedbackResponse>('/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response.data;
}
