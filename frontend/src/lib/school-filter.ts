import type { MeSchool } from '@/types/api';

/** `'all'` or a school's semel. */
export type SchoolFilter = 'all' | number;

export const ALL_SCHOOLS: SchoolFilter = 'all';

/**
 * Read the filter out of a URL, falling back to `'all'` on anything unknown.
 *
 * NEVER falls back to an empty screen. A filter that silently hides one of a
 * parent's children is the worst failure this feature can have, so an unknown
 * semel -- a school since unlinked, a hand-edited URL, a stale bookmark --
 * shows everything rather than nothing.
 *
 * Keyed by semel rather than by connection id: a semel survives unlinking and
 * re-linking the same school, and it is the stable thing to put in a URL a
 * parent might bookmark or paste into a support request.
 */
export function parseSchoolFilter(
  raw: string | null | undefined,
  schools: MeSchool[],
): SchoolFilter {
  if (!raw || raw === 'all') return ALL_SCHOOLS;

  const semel = Number(raw);
  if (!Number.isInteger(semel)) return ALL_SCHOOLS;

  return schools.some((school) => school.semel === semel) ? semel : ALL_SCHOOLS;
}

/** The query-param value for a filter, or null when it should be removed. */
export function serializeSchoolFilter(filter: SchoolFilter): string | null {
  return filter === ALL_SCHOOLS ? null : String(filter);
}

/** Does an item belong to the filtered school? */
export function matchesSchoolFilter(
  filter: SchoolFilter,
  itemSemel: number | null | undefined,
): boolean {
  if (filter === ALL_SCHOOLS) return true;
  // An item with no school -- an unstamped child, or mail, which is
  // household-wide -- stays visible. Hiding it under a chip it can never
  // match would make it unreachable.
  if (itemSemel === null || itemSemel === undefined) return true;
  return itemSemel === filter;
}
