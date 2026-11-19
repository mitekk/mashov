/**
 * Attachment download URL builders.
 *
 * Every attachment URL in the app is built here so that `encodeURIComponent`
 * lives in exactly one audited file. The call sites used to interpolate the
 * owning ids (conversation / message / student guid / item id) raw and encode
 * only the file id, which breaks for any id carrying a `/`, `?` or `#`.
 *
 * Each builder is curried: the caller fixes the owning ids once and hands the
 * resulting `(fileId) => string` to `AttachmentList`, where it also feeds a
 * TanStack Query key — so memoize it at the call site to keep its identity
 * stable across renders.
 */

const API_BASE = '/api/v1';

/** `GET /api/v1/mail/conversations/:conversationId/messages/:messageId/files/:fileId` */
export function mailAttachmentHref(
  conversationId: string,
  messageId: string,
): (fileId: string) => string {
  const prefix =
    `${API_BASE}/mail/conversations/${encodeURIComponent(conversationId)}` +
    `/messages/${encodeURIComponent(messageId)}/files/`;
  return (fileId: string) => `${prefix}${encodeURIComponent(fileId)}`;
}

/** `GET /api/v1/children/:studentGuid/homework/:homeworkId/files/:fileId` */
export function homeworkAttachmentHref(
  studentGuid: string,
  homeworkId: string,
): (fileId: string) => string {
  const prefix =
    `${API_BASE}/children/${encodeURIComponent(studentGuid)}` +
    `/homework/${encodeURIComponent(homeworkId)}/files/`;
  return (fileId: string) => `${prefix}${encodeURIComponent(fileId)}`;
}

/** `GET /api/v1/children/:studentGuid/behavior/:behaviorId/files/:fileId` */
export function behaviorAttachmentHref(
  studentGuid: string,
  behaviorId: string,
): (fileId: string) => string {
  const prefix =
    `${API_BASE}/children/${encodeURIComponent(studentGuid)}` +
    `/behavior/${encodeURIComponent(behaviorId)}/files/`;
  return (fileId: string) => `${prefix}${encodeURIComponent(fileId)}`;
}
