const PHASE1_ROUTE_PATTERNS = [
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
