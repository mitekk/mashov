import type { QueryClient } from '@tanstack/react-query';

/**
 * Every query whose answer depends on which schools a household has.
 *
 * Deliberately NOT `queryClient.clear()`. Clearing drops `['me']`, and the app
 * shell renders from it -- so the whole layout flashes through its null state
 * on the way to a screen that is only showing one more school. Invalidating
 * keeps the current data on screen until the refetch lands.
 */
const HOUSEHOLD_SCOPED_KEYS = [
  'me',
  'school-links',
  'children',
  'dashboard',
  'feed',
  'conversations',
  'mail-summary',
  'source-health',
  'profile',
  'sync-status',
] as const;

export function invalidateHouseholdScopedQueries(queryClient: QueryClient): void {
  for (const key of HOUSEHOLD_SCOPED_KEYS) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }

  // Per-child queries are keyed by studentGuid and carry no school segment --
  // a guid is globally unique and belongs to one school, so adding school to
  // the key would only fragment the cache. That makes predicate removal the
  // only way to reach them, and it is cheap: there are a handful per child.
  queryClient.removeQueries({
    predicate: (query) => {
      const first = query.queryKey[0];
      return typeof first === 'string' && first.startsWith('child-');
    },
  });
}
