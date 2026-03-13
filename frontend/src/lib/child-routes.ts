export const CHILD_SECTIONS = ['homework', 'behavior', 'subjects', 'notices'] as const;
export const CHILD_BEHAVIOR_FILTERS = ['all', 'attention', 'positive', 'neutral'] as const;

export type ChildSectionId = (typeof CHILD_SECTIONS)[number];
export type ChildBehaviorFilter = (typeof CHILD_BEHAVIOR_FILTERS)[number];

export const DEFAULT_CHILD_SECTION: ChildSectionId = 'homework';
export const DEFAULT_CHILD_BEHAVIOR_FILTER: ChildBehaviorFilter = 'all';

export function isChildSection(value: string): value is ChildSectionId {
  return (CHILD_SECTIONS as readonly string[]).includes(value);
}

export function isChildBehaviorFilter(value: string): value is ChildBehaviorFilter {
  return (CHILD_BEHAVIOR_FILTERS as readonly string[]).includes(value);
}

export function parseChildSection(
  value: string | null | undefined,
): ChildSectionId {
  return typeof value === 'string' && isChildSection(value)
    ? value
    : DEFAULT_CHILD_SECTION;
}

export function parseChildBehaviorFilter(
  value: string | null | undefined,
): ChildBehaviorFilter {
  return typeof value === 'string' && isChildBehaviorFilter(value)
    ? value
    : DEFAULT_CHILD_BEHAVIOR_FILTER;
}

function normalizeStudentGuid(studentGuid: string | null | undefined): string | null {
  if (typeof studentGuid !== 'string') return null;
  const trimmed = studentGuid.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) return null;
  return trimmed;
}

interface BuildChildSectionHrefOptions {
  behavior?: string | null | undefined;
}

export function buildChildSectionHref(
  studentGuid: string | null | undefined,
  section: ChildSectionId = DEFAULT_CHILD_SECTION,
  options?: BuildChildSectionHrefOptions,
): string | null {
  const normalizedGuid = normalizeStudentGuid(studentGuid);
  if (!normalizedGuid) return null;

  const behavior = parseChildBehaviorFilter(options?.behavior);
  const params = new URLSearchParams();
  params.set('section', section);
  params.set('behavior', behavior);
  return `/children/${encodeURIComponent(normalizedGuid)}?${params.toString()}`;
}

export function getChildrenNavHref(
  selectedChildGuid: string | null | undefined,
  section: ChildSectionId = DEFAULT_CHILD_SECTION,
  options?: BuildChildSectionHrefOptions,
): string {
  return buildChildSectionHref(selectedChildGuid, section, options) ?? '/children';
}
