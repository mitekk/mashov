/**
 * The origin a Telegram message may link back to, or null.
 *
 * Deliberately **not** `NEXT_PUBLIC_BASE_URL`. In Next, a `NEXT_PUBLIC_`
 * prefix means "inlined into the browser bundle", and this value is read by
 * the backend only -- naming it that way would tell the next reader something
 * untrue about where it ends up. It must name the same origin the frontend is
 * served from, because the links are deep links into that app.
 *
 * Unset is the default and means **render no link line at all**. Fail closed:
 * the alternative, a base of `undefined`, puts the literal string
 * "undefined/inbox/<id>" in a parent's chat, which is worse than no link.
 *
 * Lives in `src/telegram/` rather than `src/common/`: `common/**` is excluded
 * from `collectCoverageFrom`, and the only callers are the two things that
 * compose Telegram message text.
 */

/** Only an https origin, or http on localhost for a dev stack. */
const ALLOWED = /^(https:\/\/[^/\s]+|http:\/\/localhost(:\d+)?)(\/[^\s]*)?$/i;

/**
 * Validates and normalises `PUBLIC_BASE_URL`.
 *
 * Plain `http` to a real host is refused: a link in a Telegram chat is a
 * shared, forwardable artifact, and a parent's deep link should not travel in
 * clear. Trailing slashes come off so a caller can append `/home` with exactly
 * one separator.
 */
export function resolvePublicBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (!ALLOWED.test(trimmed)) return null;

  const withoutTrailingSlashes = trimmed.replace(/\/+$/, '');
  // Only reachable for an input that was nothing but slashes after a scheme,
  // which ALLOWED does not admit -- guarded rather than reasoned about.
  return withoutTrailingSlashes.length > 0 ? withoutTrailingSlashes : null;
}
