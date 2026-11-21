import axios, { AxiosInstance } from 'axios';

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
export function createTelegramHttp(options: { timeoutMs?: number } = {}): AxiosInstance {
  return axios.create({
    baseURL: TELEGRAM_API_ROOT,
    timeout: options.timeoutMs ?? TELEGRAM_DEFAULT_TIMEOUT_MS,
    proxy: false,
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

/** Telegram's own reason for a failure when it gave one, else the transport's. */
export function describeTelegramError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const description = (error.response?.data as TelegramEnvelope<unknown> | undefined)
      ?.description;
    return description ?? `HTTP ${error.response?.status ?? 'unknown'}`;
  }
  return error instanceof Error ? error.message : String(error);
}
