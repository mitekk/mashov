/**
 * Whether a file goes to Telegram as a photo or as a document.
 *
 * `sendPhoto` is worth reaching for because it previews inline, which is the
 * whole point of putting a letter in the chat rather than a link to it. It is
 * also the wrong choice for almost everything else: it RE-ENCODES and
 * downscales, so a scanned permission slip comes out unreadable, and it
 * refuses a non-image with an opaque error.
 *
 * So the rule is a narrow allow-list, not a `startsWith('image/')` test. gif,
 * svg, heic, webp and tiff are all images Telegram either animates, refuses,
 * or renders differently than the sender expected; a PDF previews natively as
 * a document. Everything not on the list is a document.
 */

/** sendPhoto's bot-upload ceiling is 10 MB; this stays well inside it. */
export const DEFAULT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const PHOTO_TYPES = ['image/jpeg', 'image/png'];

export type TelegramMediaMethod = 'sendPhoto' | 'sendDocument';

export function chooseTelegramMediaMethod(
  contentType: string | null | undefined,
  byteLength: number,
  photoMaxBytes: number = DEFAULT_PHOTO_MAX_BYTES,
): TelegramMediaMethod {
  // "image/jpeg; charset=binary" is what some upstreams send.
  const normalized = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!PHOTO_TYPES.includes(normalized)) return 'sendDocument';
  return byteLength <= photoMaxBytes ? 'sendPhoto' : 'sendDocument';
}
