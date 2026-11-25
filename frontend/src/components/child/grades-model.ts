import type { GradeItem } from '@/types/api';

/**
 * The grades view's data layer — the `timetable-model.ts` precedent: the
 * backend answers with flat year-scoped rows and every bit of arithmetic
 * happens here, where it is unit-tested without a renderer.
 *
 * Nothing here knows how it will be drawn.
 */

export interface SubjectGrades {
  subjectName: string;
  /** The class group the subject's grades came from; the card's testid key. */
  groupId: number;
  /** Plain mean of the usable grades, one decimal. Null when there are none. */
  average: number | null;
  /** Newest `eventDate` first. */
  grades: GradeItem[];
}

/** Upstream grades are 0-100. */
const MIN_GRADE = 0;
const MAX_GRADE = 100;

/**
 * Is this grade safe to average?
 *
 * A school in `textualGradesClasses` (see `apis/post-api-login.md`) does not
 * grade numerically, and a normalizer coercing `"עובר"` with `Number()` yields
 * `NaN`. One `NaN` in a sum makes the whole subject average `NaN`, which the
 * card would render as "ממוצע NaN" — worse than no average at all. The row is
 * still listed; only the arithmetic skips it.
 */
function isUsableGrade(grade: number): boolean {
  return Number.isFinite(grade) && grade >= MIN_GRADE && grade <= MAX_GRADE;
}

/** One decimal, or null for an empty set — never `NaN`, never `-0`. */
function meanToOneDecimal(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

/** The same total order the backend applies, so neither side decides ties. */
function byEventDateDesc(a: GradeItem, b: GradeItem): number {
  return (
    b.eventDate.localeCompare(a.eventDate) ||
    b.enteredAt.localeCompare(a.enteredAt) ||
    b.gradingEventId - a.gradingEventId
  );
}

/**
 * One entry per subject, sorted by subject name, each with its own average.
 *
 * Grouped by `subjectName` rather than `groupId`: the parent thinks in
 * subjects, and a child who changes class group mid-year would otherwise get
 * two מתמטיקה cards with half the grades each.
 */
export function groupGradesBySubject(grades: GradeItem[]): SubjectGrades[] {
  const bySubject = new Map<string, GradeItem[]>();

  for (const grade of grades) {
    const existing = bySubject.get(grade.subjectName);
    if (existing) {
      existing.push(grade);
    } else {
      bySubject.set(grade.subjectName, [grade]);
    }
  }

  return [...bySubject.entries()]
    .map(([subjectName, items]) => {
      const ordered = [...items].sort(byEventDateDesc);
      return {
        subjectName,
        groupId: ordered[0].groupId,
        average: meanToOneDecimal(
          ordered.map((item) => item.grade).filter(isUsableGrade),
        ),
        grades: ordered,
      };
    })
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName, 'he'));
}

