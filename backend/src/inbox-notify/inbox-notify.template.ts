import {
  DEFAULT_BODY_CHARS,
  stripMailHtmlToText,
} from '../telegram/html-to-text';

/**
 * The Hebrew text of an inbox notification.
 *
 * Plain text, no markup, for the same reason the digest report has none:
 * Telegram rejects an entire message whose text carries unbalanced markup, and
 * a school mail body routinely contains * _ - . and !. Hebrew renders
 * right-to-left without any.
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

  const blocks = [
    [
      'דואר חדש מבית הספר',
      `${message.senderName} · ${formatMailMoment(message.sendTime)}`,
      message.subject,
    ].join('\n'),
    body,
  ];

  const link = options.publicBaseUrl
    ? `${options.publicBaseUrl}/inbox/${message.conversationId}`
    : null;

  // Named before the link, so the link reads as the answer to it.
  for (const fileName of options.unsentFileNames ?? []) {
    blocks.push(
      link
        ? `קובץ גדול מדי לשליחה: ${fileName} — ניתן לפתוח באתר: ${link}`
        : `קובץ גדול מדי לשליחה: ${fileName}`,
    );
  }

  if (link) blocks.push(link);

  return blocks.filter((block) => block.trim().length > 0).join('\n\n');
}

/**
 * What goes out instead when a run finds more mail than it will send.
 *
 * Above the per-run ceiling the alternative is a burst of N messages into one
 * chat, which Telegram rate-limits and a parent reads as spam. The whole batch
 * is still claimed and confirmed, so the next run does not re-send it.
 */
export function renderInboxSummary(count: number, options: InboxLinkOptions): string {
  const blocks = [`הגיעו ${count} הודעות חדשות בתיבת הדואר`];
  if (options.publicBaseUrl) {
    blocks.push(`${options.publicBaseUrl}/inbox`);
  }
  return blocks.join('\n\n');
}
