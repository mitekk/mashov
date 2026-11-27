/**
 * The paths a sign-in bounce will restore.
 *
 * Exported so the backend's Telegram deep links can be asserted against these
 * very patterns rather than against a hand-copied duplicate of them --
 * `tests/integration/notify-links-routes.test.ts` is the only place both trees
 * are available at once, and it is what keeps `notify-links.ts` from drifting
 * away from the routes this app actually serves. See ADR-0047.
 */
export const PHASE1_ROUTE_PATTERNS = [
  /^\/home(?:[/?#].*)?$/,
  /^\/children(?:\/[^/?#]+(?:\/[^/?#]+)*)?(?:[/?#].*)?$/,
  /^\/inbox(?:\/[^/?#]+)?(?:[/?#].*)?$/,
  /^\/more(?:[/?#].*)?$/,
];

function isSafeInternalPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//')) return false;
  if (path.includes('://')) return false;
  return true;
}

export function isPhase1Route(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false;
  if (path.trim().length === 0) return false;
  if (!isSafeInternalPath(path)) return false;
  return PHASE1_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

export function getPhase1HrefOrNull(path: string | null | undefined): string | null {
  return isPhase1Route(path) ? path! : null;
}
