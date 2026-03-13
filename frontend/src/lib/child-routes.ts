export const CHILD_SECTIONS = ['homework', 'behavior', 'subjects', 'notices'] as const;

export type ChildSectionId = (typeof CHILD_SECTIONS)[number];

export const DEFAULT_CHILD_SECTION: ChildSectionId = 'homework';

export function isChildSection(value: string): value is ChildSectionId {
  return (CHILD_SECTIONS as readonly string[]).includes(value);
}

function normalizeStudentGuid(studentGuid: string | null | undefined): string | null {
  if (typeof studentGuid !== 'string') return null;
  const trimmed = studentGuid.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) return null;
  return trimmed;
}

export function buildChildSectionHref(
  studentGuid: string | null | undefined,
  section: ChildSectionId = DEFAULT_CHILD_SECTION,
): string | null {
  const normalizedGuid = normalizeStudentGuid(studentGuid);
  if (!normalizedGuid) return null;
  return `/children/${encodeURIComponent(normalizedGuid)}/${section}`;
}

export function getChildrenNavHref(
  selectedChildGuid: string | null | undefined,
  section: ChildSectionId = DEFAULT_CHILD_SECTION,
): string {
  return buildChildSectionHref(selectedChildGuid, section) ?? '/children';
}
