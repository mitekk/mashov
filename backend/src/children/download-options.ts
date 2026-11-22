/**
 * A per-download wall-clock override.
 *
 * `createMashovAxios` bounds every request with `timeout: 10s` AND
 * `signal ??= AbortSignal.timeout(10s)`, with no retry-on-abort. Ten seconds is
 * right for a JSON read and wrong for a multi-megabyte PDF over ADR-0023's
 * residential hop. The `??=` is the opening: a per-request `signal` is honoured
 * because the interceptor only fills one in when the caller supplied none, and
 * a per-request `timeout` overrides the instance's.
 *
 * BOTH have to be set. Setting only `timeout` leaves the signal aborting at ten
 * seconds; setting only `signal` leaves axios' own timer doing the same.
 */
export interface DownloadOptions {
  timeoutMs?: number;
}

/** The axios config fragment for a download, with or without an override. */
export function downloadTimeoutConfig(options?: DownloadOptions) {
  const timeoutMs = options?.timeoutMs;
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return {};
  return { timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
}
