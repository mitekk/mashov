import type { SectionYearMeta } from '@/types/api';

/**
 * Whether the only rows we hold for this section are from a school year the
 * reader will not serve.
 *
 * This is what separates "your school has not published this yet" from "you
 * have nothing" — two states that used to render the same bare empty message,
 * which is how a child's מקצועות and לוח שיעורים sat empty for a week while
 * looking exactly like a child who legitimately had no data.
 *
 * `0` is excluded deliberately: it is `UNSCOPED_SCHOOL_YEAR`, meaning "year
 * unknown" on a pre-migration row, and the backend's `currentYearScope` DOES
 * serve it. Reading it as an earlier year would tell a parent their data is
 * last year's when it is being served to them right now.
 */
export function holdsOnlyEarlierYears(meta: SectionYearMeta | undefined): boolean {
  if (!meta || meta.yearsAvailable.length === 0) return false;
  return meta.yearsAvailable.every((year) => year > 0 && year < meta.schoolYear);
}
