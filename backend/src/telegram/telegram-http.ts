import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

export const TELEGRAM_API_ROOT = 'https://api.telegram.org';

/** Enough for a sendMessage round trip; long-pollers pass their own. */
export const TELEGRAM_DEFAULT_TIMEOUT_MS = 15_000;

/** The shape every Bot API method wraps its result in. */
export interface TelegramEnvelope<T> {
  ok: boolean;
  description?: string;
  result?: T;
}

/**
 * The one place that owns how this project talks to the Telegram Bot API.
 *
 * Two things here are deliberate and load-bearing, and they are centralised
 * precisely so a second caller cannot forget either one.
 *
 * `proxy: false` -- HTTPS_PROXY is process-wide and plain axios honours it.
 * ADR-0023's egress hop is a single residential tinyproxy with a 10s
 * AbortSignal and no retry-on-abort, meant only for Mashov. A parent's message
 * -- and the long poll that carries their chat id -- must never traverse it, so
 * the proxy is switched off explicitly rather than left to the environment.
 *
 * The bot token is kept out of `baseURL` and put on each request path instead
 * (see `botPath`). An axios error carries `config.url`, which ends up in logs
 * and error trackers; a token in the base URL would be in every one of them.
 */
export function createTelegramHttp(
  options: { timeoutMs?: number } & Pick<AxiosRequestConfig, 'maxBodyLength' | 'maxContentLength'> = {},
): AxiosInstance {
  const { timeoutMs, ...rest } = options;
  return axios.create({
    baseURL: TELEGRAM_API_ROOT,
    timeout: timeoutMs ?? TELEGRAM_DEFAULT_TIMEOUT_MS,
    proxy: false,
    // The media sender needs both at Infinity: axios defaults them to 10 MB
    // and refuses a larger body LOCALLY, before any request is made.
    ...rest,
  });
}

/** The per-request path that carries the token, never the base URL. */
export function botPath(token: string, method: string): string {
  return `/bot${token.trim()}/${method}`;
}

/**
 * Axios puts the request URL into both the error message and `config.url`, and
 * those reach logs and error trackers. The token is redacted from whatever text
 * we extract rather than trusted not to be in it.
 */
export function redact(text: string, token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) return text;
  return text.split(trimmed).join('[redacted]');
}

/**
 * Telegram's own reason for a failure when it gave one, else the transport's.
 *
 * A request that never got a response -- a timed-out long poll, a DNS failure
 * -- has no status to report, and this string is not purely diagnostic: it
 * lands in `confirmationError` and is shown to the parent on the wizard's last
 * step. So the transport's own `code` and `message` are used there rather than
 * the word "unknown", which told nobody anything.
 */
export function describeTelegramError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const description = (error.response?.data as TelegramEnvelope<unknown> | undefined)
      ?.description;
    if (description) return description;
    if (error.response?.status) return `HTTP ${error.response.status}`;
    return [error.code, error.message].filter(Boolean).join(': ') || 'request failed';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Telegram's own refusal, when an axios rejection carries one.
 *
 * The distinction the senders' retry depends on, and it is NOT the HTTP
 * status: the Bot API reports a parse error as **HTTP 400** with an `ok:false`
 * envelope, which axios rejects under its default `validateStatus`. Treating
 * every rejection as a transport failure is what made the strip-and-retry
 * unreachable in production while the unit tests -- which mocked a resolved
 * `ok:false`, a shape axios cannot produce for a 400 -- passed.
 *
 * So the line is drawn where it belongs: a rejection with a `response` means
 * Telegram ANSWERED and its description is a refusal the caller may act on; a
 * rejection without one never reached Telegram, returns null, and the caller
 * rethrows. A 502 still cannot reach a retry.
 */
export function telegramRefusal(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const response = error.response;
  if (!response) return null;
  return describeTelegramError(error) || `HTTP ${response.status}`;
}

/**
 * The Bot API's hard ceiling for `sendMessage.text`, in UTF-16 code units --
 * which is what `String.length` counts, and what Telegram counts too.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * What this project actually splits at. Below the ceiling on purpose: the
 * remaining headroom absorbs anything a caller appends after chunking (a link
 * line, a part marker) without pushing a part back over the limit.
 */
export const TELEGRAM_CHUNK_LIMIT = 4000;

/**
 * Splits a message into parts Telegram will accept.
 *
 * Nothing in this project used to handle the limit at all: an over-long message
 * failed, the digest's `deliver` threw, the claims were released, and the next
 * hourly run built the same over-long message and failed identically -- forever.
 * Mail bodies and a longer report make that reachable, so this is the backstop.
 * Per-template truncation budgets stay, so reaching it should stay rare.
 *
 * Where it cuts, in order of preference: the last blank line inside the window,
 * so a section is never split from its header; else the last newline; else a
 * hard cut. A hard cut never lands between the halves of a surrogate pair --
 * a lone surrogate renders as a replacement character in the parent's chat.
 *
 * Trailing whitespace is trimmed from each part and leading newlines from the
 * next, so a run of blank lines at a boundary cannot produce an empty part --
 * which Telegram rejects outright.
 */
export function chunkTelegramText(text: string, limit = TELEGRAM_CHUNK_LIMIT): string[] {
  if (limit <= 0 || text.length <= limit) return [text];

  const parts: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const cut = cutPoint(rest, limit);
    const head = rest.slice(0, cut).replace(/\s+$/, '');
    if (head.length > 0) parts.push(head);
    rest = rest.slice(cut).replace(/^\n+/, '');
  }

  const tail = rest.replace(/\s+$/, '');
  if (tail.length > 0) parts.push(tail);

  // Only reachable for input that is all whitespace past the limit, which has
  // no visible content to carry -- return something rather than nothing, so a
  // caller never silently sends zero messages and reports success.
  return parts.length > 0 ? parts : [text.slice(0, limit)];
}

/** Always >= 1, so the loop above cannot fail to make progress. */
function cutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);

  const blankLine = window.lastIndexOf('\n\n');
  if (blankLine >= 0) return blankLine + 2;

  const newline = window.lastIndexOf('\n');
  if (newline >= 0) return newline + 1;

  const code = text.charCodeAt(limit - 1);
  const splitsAPair = code >= 0xd800 && code <= 0xdbff;
  const hard = splitsAPair && limit > 1 ? limit - 1 : limit;

  return beforeEntity(text, hard);
}

/**
 * The longest HTML entity this project's escaping produces is `&quot;` (6).
 * One more than that is all the lookback a cut needs.
 */
const ENTITY_LOOKBACK = 7;

/**
 * Backs a hard cut up out of a half-written entity.
 *
 * `&amp;` cut between `&am` and `p;` is `can't parse entities` for the part
 * that carries the opening half -- the same class of damage as a split tag,
 * and from the same cut. The templates' per-line clamping is what keeps a hard
 * cut unreachable in the first place; this is the backstop for the case where
 * that invariant has already failed, so it should not then fail loudly.
 *
 * Never returns 0: the chunking loop needs progress more than it needs a
 * whole entity.
 */
function beforeEntity(text: string, cut: number): number {
  for (let index = cut - 1; index >= Math.max(1, cut - ENTITY_LOOKBACK); index -= 1) {
    const char = text[index];
    if (char === ';') return cut;
    if (!/[a-z0-9#&]/i.test(char)) return cut;
    if (char === '&') return index;
  }
  return cut;
}

/**
 * Descriptions that mean "this chat will never accept another message".
 *
 * Matched as substrings because Telegram prefixes them inconsistently
 * (`Forbidden: `, `Bad Request: `) and this project's senders prefix them
 * again with their own text.
 *
 * Deliberately a closed list of four rather than a heuristic. Everything else
 * -- a 429, a 502, a timeout, an empty-text rejection -- is transient and must
 * be retried, and a wrong "permanent" silently stops a parent's digest with no
 * error anyone sees. A code this list does not know costs one wasted retry per
 * run; a code it wrongly claims costs a parent the feature.
 */
const PERMANENT_TELEGRAM_FAILURES = [
  'bot was blocked by the user',
  'chat not found',
  'user is deactivated',
  "bot can't initiate conversation",
];

/**
 * Whether a failed send should stop being retried and retire the chat.
 *
 * A transient failure releases the dedup claims so the next run tries again. A
 * permanent one must not: the items would be re-claimed, re-summarized (a
 * model call each time) and re-sent to a chat that cannot receive them, on
 * every run, forever. So the caller confirms the ledger rows anyway and
 * disables the recipient.
 */
export function isPermanentTelegramFailure(description: string): boolean {
  const text = description.toLowerCase();
  return PERMANENT_TELEGRAM_FAILURES.some((phrase) => text.includes(phrase));
}
