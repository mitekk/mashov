/**
 * Telegram's HTML parse mode, and the three things that make it safe to use.
 *
 * This project sent every message flat for a long time, and the reason was
 * sound: Markdown and MarkdownV2 reject an ENTIRE message over an unbalanced
 * `*` or an unescaped `.`, and teacher remarks, filenames and mail bodies are
 * full of both. A rejected digest failed, released its claims, and the next
 * hourly run built the same message and failed identically.
 *
 * HTML parse mode is a different bargain. Its reserved set is three
 * characters -- `&`, `<`, `>` -- and not one of them appears in ordinary
 * Hebrew free text, so escaping is a boundary a template can actually hold,
 * rather than a running battle with punctuation. See ADR-0047.
 *
 * The three things:
 *
 * 1. `escapeTelegramHtml` on every interpolated value. Teacher remarks,
 *    filenames, mail subjects and bodies are untrusted input here.
 * 2. `clampLine`, which keeps the chunker's one unsafe cut unreachable --
 *    `chunkTelegramText` prefers a blank line, then a newline, and only then
 *    cuts hard, so as long as every tag opens and closes inside one line and
 *    no rendered line approaches the chunk limit, a hard cut cannot land
 *    inside a tag.
 * 3. `stripTelegramHtml`, the payload the senders retry with when Telegram
 *    complains about the markup anyway. A parse failure must never cost a
 *    parent the whole message.
 */

/**
 * The per-line ceiling every template interpolation is clamped to, measured
 * in the UTF-16 code units Telegram counts -- AFTER escaping.
 *
 * Well under `TELEGRAM_CHUNK_LIMIT` (4000) on purpose: a rendered line is this
 * plus the template's own markup, which for the worst case -- a bulleted item
 * line wrapped in an anchor to a deep link -- is a couple of hundred
 * characters of tag, URL, guid and item id.
 */
export const TELEGRAM_LINE_BUDGET = 900;

/**
 * The only three characters HTML parse mode reserves.
 *
 * `&` is replaced first and unconditionally, including inside something that
 * already looks like an entity: `&amp;` becomes `&amp;amp;`, so a remark that
 * happens to contain entity syntax renders as the characters the teacher
 * typed instead of being re-parsed.
 */
export function escapeTelegramHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The same text with the markup taken back out: tags dropped, the three
 * entities decoded.
 *
 * This is the fallback payload. It is deliberately a plain-text producer and
 * not an HTML sanitiser -- it runs on text this project composed, after
 * Telegram has already refused to parse it, and its one job is that the words
 * still reach the parent.
 *
 * `&amp;` is decoded LAST, so `&amp;lt;` comes out as the literal `&lt;` a
 * teacher typed rather than as a `<` that the next thing to read this would
 * see as a tag. Identity on text that carries no markup, which is what the
 * `TELEGRAM_HTML_ENABLED=false` path relies on.
 */
export function stripTelegramHtml(html: string): string {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * One line, no longer than `budget` once escaped.
 *
 * Two guarantees, and both are load-bearing for the chunker:
 *
 * The newline collapse is what makes "every tag opens and closes inside one
 * line" true of values this project does not control. A homework text with a
 * newline in it would otherwise split an anchor across two lines, and a hard
 * cut between them would send Telegram half a tag.
 *
 * The budget is measured on the ESCAPED string, not the raw one. Escaping
 * turns one `&` into five characters, so a raw-length budget of 900 admits a
 * 4500-character rendered line -- past the chunk limit, which is the one thing
 * this function exists to prevent. The cut lands on a code-point boundary: a
 * lone surrogate renders as a replacement character in the parent's chat.
 */
export function clampLine(text: string, budget: number = TELEGRAM_LINE_BUDGET): string {
  if (typeof text !== 'string') return '';

  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return '';
  if (escapedLength(oneLine) <= budget) return oneLine;
  if (budget <= 1) return budget === 1 ? '…' : '';

  // One character of the budget is the ellipsis, which escapes to itself.
  const room = budget - 1;
  let used = 0;
  let kept = '';
  for (const codePoint of oneLine) {
    const cost = escapedLength(codePoint);
    if (used + cost > room) break;
    used += cost;
    kept += codePoint;
  }

  return `${kept}…`;
}

/** What `escapeTelegramHtml(text).length` would be, without building it. */
function escapedLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '&') length += 5;
    else if (char === '<' || char === '>') length += 4;
    else length += 1;
  }
  return length;
}

/**
 * Descriptions that mean "Telegram could not read the markup", as opposed to
 * "Telegram will not take this message".
 *
 * The distinction decides whether a retry is honest. A parse complaint is
 * about the payload and the same text stripped flat will be accepted, so
 * retrying costs one extra call and saves the parent the message. Anything
 * else -- a 429, a 502, a blocked bot -- must stay a failure: retrying it as
 * plain text would report success for a message that never arrived, and the
 * digest would confirm its claims and bury the day's news for good.
 *
 * Matched as case-insensitive substrings because Telegram prefixes these
 * inconsistently (`Bad Request: `) and this project's senders prefix them
 * again with their own text. The same closed-list discipline as
 * `isPermanentTelegramFailure`.
 */
const PARSE_FAILURE_PHRASES = [
  "can't parse entities",
  'unsupported start tag',
  'unclosed',
];

export function looksLikeParseFailure(description: string): boolean {
  if (typeof description !== 'string' || description.length === 0) return false;
  const text = description.toLowerCase();
  return PARSE_FAILURE_PHRASES.some((phrase) => text.includes(phrase));
}
