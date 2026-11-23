/**
 * How Mashov's attachment metadata is read, in one pure place.
 *
 * Lifted out of ChildrenService's private methods because a second caller
 * needs it: the digest now has to enumerate a homework or behaviour item's
 * files to send them to Telegram, and it must do that WITHOUT the attachment
 * payload entering `DigestPayload` -- which feeds `buildPrompt` and is the PII
 * boundary (ADR-0026). A copy of the key lists in a second file is how the two
 * readers would drift apart on the next field Mashov renames.
 *
 * Mashov is inconsistent about which key carries an id, a name and a URL, and
 * it varies by endpoint -- hence the lists rather than a single field name.
 * Nothing here does I/O, so it is unit-testable and inside the coverage gate.
 */

export interface AttachmentMeta {
  fileId: string;
  fileName: string;
  url?: string;
  /** Behaviour attachments are fetched per lesson, so the id travels with them. */
  lessonId?: number;
}

/**
 * The union of what the two readers used to look for.
 *
 * MailService's lists were strict supersets of ChildrenService's -- mail
 * endpoints send `fileGuid`, `nameWithExtension` and `downloadPath` where the
 * student endpoints send `id`, `name` and `url`. Unified rather than kept
 * apart: the extra aliases only fire when none of the primary keys is present,
 * where the narrower list returned null and DROPPED the attachment. An
 * attachment listed instead of dropped is the better failure.
 */
const ID_KEYS = ['fileId', 'id', 'guid', 'attachmentId', 'fileGuid', 'attachmentGuid'];
const NAME_KEYS = [
  'fileName',
  'name',
  'title',
  'originalFileName',
  'originalName',
  'nameWithExtension',
  'displayName',
];
const URL_KEYS = [
  'url',
  'link',
  'downloadUrl',
  'href',
  'fileUrl',
  'downloadPath',
  'path',
  'uri',
];

/**
 * One attachment's metadata, or null when there is no id to fetch it by.
 *
 * Null rather than a half-built object: a download needs the id, and an entry
 * without one is not something a caller can do anything with.
 */
export function parseAttachmentMeta(
  value: unknown,
  fallbackLessonId?: number,
): AttachmentMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const fileId = pickFirstString(record, ID_KEYS);
  if (!fileId) return null;

  const fileName = pickFirstString(record, NAME_KEYS) ?? fileId;
  const url = pickFirstString(record, URL_KEYS);
  const lessonId = pickFirstNumber(record, ['lessonId']) ?? fallbackLessonId;

  return {
    fileId,
    fileName,
    ...(url ? { url } : {}),
    ...(typeof lessonId === 'number' ? { lessonId } : {}),
  };
}

/**
 * A behaviour item's attachments.
 *
 * Out of `rawPayload`, because `behavior_item` has no `files` column -- the
 * only record of a scanned letter attached to a discipline note is the raw
 * upstream payload the sync task stored.
 */
export function extractBehaviorFiles(
  rawPayload: unknown,
  fallbackLessonId: number,
): AttachmentMeta[] {
  if (!rawPayload || typeof rawPayload !== 'object') return [];

  const payload = rawPayload as Record<string, unknown>;
  const sources: unknown[] = [];
  if (Array.isArray(payload.files)) sources.push(...payload.files);
  if (Array.isArray(payload.attachments)) sources.push(...payload.attachments);

  return sources
    .map((entry) => parseAttachmentMeta(entry, fallbackLessonId))
    .filter((entry): entry is AttachmentMeta => entry !== null);
}

/**
 * The attachments in a `files` JSON column -- `homework_item.files` or
 * `mail_message.files`. Both hold the same shape of list.
 */
export function parseAttachmentList(files: unknown): AttachmentMeta[] {
  if (!Array.isArray(files)) return [];
  return files
    .map((entry) => parseAttachmentMeta(entry))
    .filter((entry): entry is AttachmentMeta => entry !== null);
}

/** Named for its caller; `homework_item.files` is a plain attachment list. */
export const extractHomeworkFiles = parseAttachmentList;

function pickFirstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    // Mashov sends a numeric id on some endpoints, which the mail reader
    // already accepted and the student one silently dropped.
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickFirstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
