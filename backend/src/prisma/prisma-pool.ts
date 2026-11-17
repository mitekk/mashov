/**
 * Connection pool sizing for the Prisma client.
 *
 * Prisma takes these as query parameters on the connection URL, which in a
 * hosted deployment means they live inside a masked secret -- invisible to
 * this repo, unreviewable, and silently lost whenever the service is
 * recreated. That is how the default of `num_cpus * 2 + 1` (nine, here) went
 * unnoticed until sixteen cron tasks and the request path started timing out
 * against it:
 *
 *   Timed out fetching a new connection from the connection pool.
 *   (Current connection pool timeout: 10, connection limit: 9)
 *
 * So the sizing is applied here instead, from ordinary non-secret environment
 * variables with defaults, and `DATABASE_URL` goes back to carrying only
 * credentials.
 */

/**
 * Postgres' own `max_connections` defaults to 100 and only this service uses
 * the instance, so 25 leaves ample headroom for psql and admin sessions.
 */
export const DEFAULT_CONNECTION_LIMIT = 25;

/** Seconds a query may wait for a connection. Prisma's own default is 10. */
export const DEFAULT_POOL_TIMEOUT_SECONDS = 20;

type EnvLike = Record<string, string | undefined>;

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns `url` with pool settings appended.
 *
 * Deliberately string concatenation rather than `new URL()`: a round trip
 * through the WHATWG parser re-encodes reserved characters in the password,
 * which breaks authentication in a way that looks like a wrong credential.
 * The credentials must come out byte for byte.
 *
 * A parameter already present in the URL is left alone -- an operator who
 * pinned a value there has the final say, and appending a duplicate would
 * leave which one wins up to Prisma's parser.
 */
export function withPoolSettings(
  url: string | undefined,
  env: EnvLike = process.env,
): string | undefined {
  if (!url) {
    return url;
  }

  const candidates: Array<[string, number]> = [
    ['connection_limit', positiveIntOr(env.DATABASE_CONNECTION_LIMIT, DEFAULT_CONNECTION_LIMIT)],
    ['pool_timeout', positiveIntOr(env.DATABASE_POOL_TIMEOUT, DEFAULT_POOL_TIMEOUT_SECONDS)],
  ];

  let result = url;
  for (const [key, value] of candidates) {
    if (new RegExp(`[?&]${key}=`).test(result)) {
      continue;
    }
    result += `${result.includes('?') ? '&' : '?'}${key}=${value}`;
  }

  return result;
}
