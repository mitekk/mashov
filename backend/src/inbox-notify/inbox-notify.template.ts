import {
  DEFAULT_BODY_CHARS,
  stripMailHtmlToText,
} from '../telegram/html-to-text';
import { clampLine, escapeTelegramHtml } from '../telegram/telegram-html';
import { inboxConversationUrl } from '../telegram/notify-links';

/**
 * The Hebrew text of an inbox notification, as Telegram HTML.
 *
 * Structure only, and deliberately **no model**. The school wrote the mail; a
 * summary of it would be a second-hand account of something the parent can
 * read verbatim, and the digest's summarizer exists because a day's worth of
 * rows is not a message, which a single mail already is. So what changed here
 * is layout: a bold heading, the sender and time as a quiet meta line, the
 * subject in bold, the school's own words in a blockquote, and the link
 * anchored on words instead of printed raw. See ADR-0047.
 *
 * Recipients stay absent and must stay absent: a school mail's recipients name
 * every other parent in the class.
 *
 * Everything interpolated is escaped and clamped to one line. The clamping is
 * what keeps `chunkTelegramText`'s hard cut -- its only tag-unsafe cut -- out
 * of reach; the body is already budgeted by `DEFAULT_BODY_CHARS`, and
 * collapsing its paragraphs onto one line is what stops a `<blockquote>` from
 * spanning two.
 *
 * The HTML stripper itself lives in `src/telegram/html-to-text.ts`, because the
 * digest's message-board section needs the same reading and must not import
 * from this module.
 */

export { DEFAULT_BODY_CHARS, stripMailHtmlToText };

export interface InboxLinkOptions {
  /** Already validated by `resolvePublicBaseUrl`. Absent renders no link. */
  publicBaseUrl?: string | null;
  /**
   * Files named in the text because they are NOT being uploaded -- too large,
   * or past the per-message cap. The parent has to be told they exist, or the
   * message is quietly less than the mail it describes.
   */
  unsentFileNames?: string[];
}

/** The fields of a MailMessage the notification is allowed to use. */
export interface InboxNotifiableMessage {
  messageId: string;
  conversationId: string;
  senderName: string;
  subject: string;
  bodyHtmlSanitized: string | null;
  bodyTextPreview: string | null;
  sendTime: Date;
}

/**
 * "17/11 09:05".
 *
 * UTC getters, like `formatSchoolDate`. Mashov sends naive local timestamps
 * and the container runs at TZ=UTC, so the UTC fields of the stored value ARE
 * the original Israeli wall clock. Converting would move it by two hours.
 */
export function formatMailMoment(sendTime: Date): string {
  const day = String(sendTime.getUTCDate()).padStart(2, '0');
  const month = String(sendTime.getUTCMonth() + 1).padStart(2, '0');
  const hour = String(sendTime.getUTCHours()).padStart(2, '0');
  const minute = String(sendTime.getUTCMinutes()).padStart(2, '0');
  return `${day}/${month} ${hour}:${minute}`;
}

/** The heading a parent recognises in a list of chats. */
const INBOX_TITLE = 'דואר חדש מבית הספר';

/**
 * One mail message as its own Telegram message.
 *
 * The recipients list is deliberately absent and must stay absent: a school
 * mail's recipients name every other parent in the class.
 */
export function renderInboxMessage(
  message: InboxNotifiableMessage,
  options: InboxLinkOptions,
  budget: number = DEFAULT_BODY_CHARS,
): string {
  const body =
    stripMailHtmlToText(message.bodyHtmlSanitized, budget) ||
    stripMailHtmlToText(message.bodyTextPreview, budget);

  const lines = [
    `📬 <b>${escapeTelegramHtml(INBOX_TITLE)}</b>`,
    // Quiet, because it is context rather than content: who it is from and
    // when, on one line the eye can skip.
    `<i>${escaped(`${message.senderName} · ${formatMailMoment(message.sendTime)}`)}</i>`,
    `<b>${escaped(message.subject)}</b>`,
  ];

  // The school's own words, visibly theirs. Omitted rather than rendered as an
  // empty quote when upstream gave us no body -- which is most of the time,
  // because the inbox list payload carries none until a parent opens the
  // thread.
  const quoted = escaped(body);
  if (quoted.length > 0) lines.push(`<blockquote>${quoted}</blockquote>`);

  const href = inboxConversationUrl(options.publicBaseUrl, message.conversationId);

  // Named before the link, so the link reads as the answer to it.
  for (const fileName of options.unsentFileNames ?? []) {
    const name = escaped(fileName);
    if (name.length > 0) lines.push(`📎 קובץ גדול מדי לשליחה: ${name}`);
  }

  if (href) lines.push(anchor(href, 'לפתוח את ההודעה'));

  return lines.join('\n');
}

/**
 * What goes out instead when a run finds more mail than it will send.
 *
 * Above the per-run ceiling the alternative is a burst of N messages into one
 * chat, which Telegram rate-limits and a parent reads as spam. The whole batch
 * is still claimed and confirmed, so the next run does not re-send it.
 */
export function renderInboxSummary(count: number, options: InboxLinkOptions): string {
  const lines = [
    `📬 <b>${escapeTelegramHtml(`הגיעו ${count} הודעות חדשות בתיבת הדואר`)}</b>`,
  ];

  const base = options.publicBaseUrl?.trim();
  if (base) lines.push(anchor(`${base}/inbox`, 'לפתוח את תיבת הדואר'));

  return lines.join('\n');
}

/** One escaped line, with the newlines collapsed out of it. */
function escaped(raw: string | null | undefined): string {
  return escapeTelegramHtml(clampLine(raw ?? ''));
}

/** Anchored on words, so the message carries no bare URL. */
function anchor(href: string, label: string): string {
  return `<a href="${escapeTelegramHtml(href)}">${escapeTelegramHtml(label)}</a>`;
}
