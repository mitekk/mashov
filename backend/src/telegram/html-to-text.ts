/**
 * HTML into plain text for a Telegram message.
 *
 * Two readers need exactly this: a mail body, and a message-board notice --
 * the message-board sync task sanitizes the notice but KEEPS its markup
 * (`<a>`, `<p>`, `<br>`, `<strong>`), so the stored value is still HTML. One
 * copy, because two would differ on the next tag either of them met.
 *
 * Lives in `src/telegram/` rather than `src/common/`: `common/**` is excluded
 * from `collectCoverageFrom`, and this is exactly the kind of pure function
 * the 80% line gate should be looking at.
 */
import sanitizeHtml = require('sanitize-html');

/** How much of a body goes in the chat before it is cut. */
export const DEFAULT_BODY_CHARS = 700;

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
 * A sanitized HTML body as text a parent can read in a chat.
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

