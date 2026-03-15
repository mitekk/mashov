import { apiFetch } from './client';
import type {
  MailSummary,
  ConversationsResponse,
  ConversationDetail,
  MailBulkActionRequest,
  MailBulkActionResponse,
} from '@/types/api';

type UnknownRecord = Record<string, unknown>;

export function fetchMailSummary(): Promise<MailSummary> {
  return apiFetch<MailSummary>('/mail/summary');
}

export function fetchConversations(
  page = 1,
  limit = 20,
  filter: 'all' | 'new' | 'archived' = 'all',
): Promise<ConversationsResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    filter,
  });
  return apiFetch<ConversationsResponse>(`/mail/conversations?${params.toString()}`);
}

export function fetchConversationDetail(id: string): Promise<ConversationDetail> {
  return apiFetch<ConversationDetail | LegacyConversationResponse>(`/mail/conversations/${id}`)
    .then((response) => normalizeConversationDetail(response));
}

export function markConversationsRead(
  conversationIds: string[],
): Promise<MailBulkActionResponse> {
  const body: MailBulkActionRequest = { conversationIds };
  return apiFetch<MailBulkActionResponse>('/mail/conversations/mark-read', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
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

export function unarchiveConversations(
  conversationIds: string[],
): Promise<MailBulkActionResponse> {
  const body: MailBulkActionRequest = { conversationIds };
  return apiFetch<MailBulkActionResponse>('/mail/conversations/unarchive', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

interface LegacyConversationResponse {
  conversation: UnknownRecord;
  messages: UnknownRecord[];
}

function normalizeConversationDetail(
  response: ConversationDetail | LegacyConversationResponse,
): ConversationDetail {
  if ('conversationId' in response) {
    return {
      ...response,
      subject:
        typeof response.subject === 'string' && response.subject.trim().length > 0
          ? response.subject
          : 'ללא נושא',
      isNew: Boolean((response as unknown as UnknownRecord).isNew ?? (response as unknown as UnknownRecord).isUnread),
      messages: response.messages.map((msg) => ({
        ...msg,
        isNew: Boolean((msg as unknown as UnknownRecord).isNew ?? (msg as unknown as UnknownRecord).isUnread),
        bodyHtmlSanitized: normalizeMessageHtml(
          msg.bodyHtmlSanitized,
          msg.bodyTextPreview,
        ),
        bodyTextPreview: msg.bodyTextPreview ?? '',
        recipients: Array.isArray(msg.recipients) ? msg.recipients : [],
        hasAttachments: Boolean(
          (msg as unknown as UnknownRecord).hasAttachments
          ?? (Array.isArray((msg as unknown as UnknownRecord).files)
            && ((msg as unknown as UnknownRecord).files as unknown[]).length > 0),
        ),
      })),
    };
  }

  const conversation = (response.conversation ?? {}) as UnknownRecord;
  const messages = Array.isArray(response.messages) ? response.messages : [];

  return {
    conversationId: String(conversation.conversationId ?? ''),
    subject:
      typeof conversation.subject === 'string' && conversation.subject.trim().length > 0
        ? conversation.subject
        : 'ללא נושא',
    sendTime: String(conversation.sendTime ?? new Date().toISOString()),
    isNew: Boolean(conversation.isNew ?? conversation.isUnread),
    hasDrafts: Boolean(conversation.hasDrafts),
    hasAttachments: Boolean(conversation.hasAttachments),
    preventReply: Boolean(conversation.preventReply),
    labels: Array.isArray(conversation.labels) ? (conversation.labels as string[]) : [],
    lastFetchedAt: String(conversation.lastFetchedAt ?? new Date().toISOString()),
    messages: messages.map((msg, index) => {
      const message = msg as UnknownRecord;
      return {
        messageId: String(message.messageId ?? `legacy-${index}`),
        conversationId: String(
          message.conversationId ?? conversation.conversationId ?? '',
        ),
        senderId: String(message.senderId ?? ''),
        senderName: String(message.senderName ?? ''),
        subject: String(message.subject ?? ''),
        bodyHtmlSanitized: normalizeMessageHtml(
          message.bodyHtmlSanitized,
          message.bodyTextPreview,
        ),
        bodyTextPreview: String(message.bodyTextPreview ?? ''),
        sendTime: String(message.sendTime ?? new Date().toISOString()),
        isNew: Boolean(message.isNew ?? message.isUnread),
        recipients: normalizeRecipients(message.recipients),
        hasAttachments: Boolean(
          message.hasAttachments
          ?? (Array.isArray(message.files) && message.files.length > 0),
        ),
        preventReply: Boolean(message.preventReply),
        sentViaEmail: Boolean(message.sentViaEmail),
        sentViaSms: Boolean(message.sentViaSms),
      };
    }),
  };
}

function normalizeRecipients(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.map((recipient, index) => {
    if (recipient && typeof recipient === 'object') {
      const candidate = recipient as UnknownRecord;
      return {
        displayOrder:
          typeof candidate.displayOrder === 'number'
            ? candidate.displayOrder
            : index,
        displayName:
          typeof candidate.displayName === 'string'
            ? candidate.displayName
            : '',
        valueType:
          typeof candidate.valueType === 'string' ? candidate.valueType : '',
        targetType:
          typeof candidate.targetType === 'string' ? candidate.targetType : '',
        isGroup: Boolean(candidate.isGroup),
      };
    }

    return {
      displayOrder: index,
      displayName: '',
      valueType: '',
      targetType: '',
      isGroup: false,
    };
  });
}

function normalizeMessageHtml(html: unknown, preview: unknown): string {
  if (typeof html === 'string' && html.trim().length > 0) return html;
  if (typeof preview === 'string' && preview.trim().length > 0) {
    return `<p>${escapeHtml(preview)}</p>`;
  }
  return '<p>תוכן ההודעה אינו זמין בשלב 1.</p>';
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}
