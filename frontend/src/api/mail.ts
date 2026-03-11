import { apiFetch } from './client';
import type {
  MailSummary,
  ConversationsResponse,
  ConversationDetail,
  MailBulkActionRequest,
  MailBulkActionResponse,
} from '@/types/api';

export function fetchMailSummary(): Promise<MailSummary> {
  return apiFetch<MailSummary>('/mail/summary');
}

export function fetchConversations(
  page = 1,
  limit = 20,
  unreadOnly = false,
): Promise<ConversationsResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    unreadOnly: String(unreadOnly),
  });
  return apiFetch<ConversationsResponse>(`/mail/conversations?${params.toString()}`);
}

export function fetchConversationDetail(id: string): Promise<ConversationDetail> {
  return apiFetch<ConversationDetail>(`/mail/conversations/${id}`);
}

export function markConversationsUnread(
  conversationIds: string[],
): Promise<MailBulkActionResponse> {
  const body: MailBulkActionRequest = { conversationIds };
  return apiFetch<MailBulkActionResponse>('/mail/conversations/mark-unread', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function archiveConversations(
  conversationIds: string[],
): Promise<MailBulkActionResponse> {
  const body: MailBulkActionRequest = { conversationIds };
  return apiFetch<MailBulkActionResponse>('/mail/conversations/archive', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
