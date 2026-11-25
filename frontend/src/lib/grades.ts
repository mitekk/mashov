/**
 * Presentation for grades, mirroring `lib/behavior.ts`: what a grade *means*
 * on screen lives here, so the section component holds no colour decisions.
 */

export type GradeBandVariant = 'positive' | 'info' | 'attention';

/** Band edges, inclusive at the bottom. 85+ is good, 70+ is fine, below is not. */
const GOOD_FROM = 85;
const FAIR_FROM = 70;

/**
 * Which `Badge` variant a grade wears.
 *
 * Reuses the three existing semantic variants rather than introducing a grade
 * palette: the app already teaches the parent that positive is green, info is
 * blue and attention is amber, and a fourth scale would be a new thing to learn
 * for no new information.
 *
 * A grade that is not a usable number lands in `info`, not `attention`: we do
 * not know that it is bad, and colouring an unparseable grade as a problem
 * would be the view inventing a fact.
 */
export function gradeBandVariant(grade: number): GradeBandVariant {
  if (!Number.isFinite(grade)) return 'info';
  if (grade >= GOOD_FROM) return 'positive';
  if (grade >= FAIR_FROM) return 'info';
  return 'attention';
}
