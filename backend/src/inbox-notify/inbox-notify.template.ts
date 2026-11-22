import sanitizeHtml = require('sanitize-html');

/**
 * The Hebrew text of an inbox notification.
 *
 * Plain text, no markup, for the same reason the digest report has none:
 * Telegram rejects an entire message whose text carries unbalanced markup, and
 * a school mail body routinely contains * _ - . and !. Hebrew renders
 * right-to-left without any.
 *
 * Lives in `src/inbox-notify/` rather than `src/common/`: `common/**` is
 * excluded from `collectCoverageFrom`, and these are the functions the 80%
 * line gate most wants to see.
 */

/** How much of a mail body goes in the chat before it is cut. */
export const DEFAULT_BODY_CHARS = 700;

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
 * Block-level tags that mean "a line ended here".
 *
 * Replaced BEFORE the tags are stripped. Stripping first glues the paragraphs
 * into one run of words -- "שלוםנבקש להביא" -- because there is no whitespace
 * between `</p>` and `<p>` in the markup Mashov sends.
 */
const LINE_BREAKS = /<\s*br\s*\/?\s*>|<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi;

/** The entities sanitize-html leaves in its output, and the ones Mashov sends. */
const ENTITIES: [RegExp, string][] = [
  [/&nbsp;/gi, ' '],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&apos;/gi, "'"],
  [/&#0*39;/g, "'"],
  [/&#0*34;/g, '"'],
  [/&#0*160;/g, ' '],
  // Last, so a doubly-encoded "&amp;lt;" does not become a tag.
  [/&amp;/gi, '&'],
];

/**
 * A mail body as text a parent can read in a chat.
 *
 * `nonTextTags` matters as much as `allowedTags: []` does: with allowedTags
 * empty, sanitize-html strips the `<script>` element but keeps its CONTENT,
 * which would put JavaScript in a parent's chat as prose.
 */
export function stripMailHtmlToText(
  html: string | null | undefined,
  budget: number = DEFAULT_BODY_CHARS,
): string {
  if (!html) return '';

  const withBreaks = html.replace(LINE_BREAKS, '\n');
  const stripped = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'head', 'textarea', 'noscript'],
  });

  let text = stripped;
  for (const [pattern, replacement] of ENTITIES) {
    text = text.replace(pattern, replacement);
  }

  const collapsed = text
    .replace(/\r\n?/g, '\n')
    // sanitize-html decodes &nbsp; to U+00A0 itself, and a non-breaking space
    // is invisible in a chat but is not a space to any later trim or split.
    .replace(/\u00a0/g, ' ')
    // Trailing spaces first, so a line of nothing but spaces counts as blank.
    .replace(/[ \t ]+$/gm, '')
    .replace(/^[ \t ]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (budget > 0 && collapsed.length > budget) {
    return `${collapsed.slice(0, budget)}…`;
  }
  return collapsed;
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
