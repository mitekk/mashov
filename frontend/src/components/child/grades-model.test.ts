import { describe, it, expect } from 'vitest';
import type { GradeItem } from '@/types/api';
import { groupGradesBySubject, overallAverage } from './grades-model';

function makeGrade(overrides: Partial<GradeItem> = {}): GradeItem {
  return {
    id: 'g-1',
    studentGuid: 'stu-1',
    gradingEventId: 1,
    grade: 90,
    gradingPeriod: 1,
    gradeTypeId: 1,
    gradeType: 'מבחן',
    gradingEvent: 'מבחן ראשון',
    groupId: 202,
    groupName: 'מתמטיקה ז8',
    subjectName: 'מתמטיקה',
    teacherName: 'קליין יעל',
    eventDate: '2026-11-19T00:00:00.000Z',
    enteredAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('groupGradesBySubject', () => {
  it('returns no groups for no grades', () => {
    expect(groupGradesBySubject([])).toEqual([]);
  });

  it('groups by subject name and sorts the groups by it', () => {
    const groups = groupGradesBySubject([
      makeGrade({ id: 'g-1', subjectName: 'מתמטיקה', groupId: 202 }),
      makeGrade({ id: 'g-2', subjectName: 'אנגלית', groupId: 301 }),
      makeGrade({ id: 'g-3', subjectName: 'מתמטיקה', groupId: 202 }),
    ]);

    expect(groups.map((g) => g.subjectName)).toEqual(['אנגלית', 'מתמטיקה']);
    expect(groups[1].grades.map((g) => g.id)).toEqual(['g-1', 'g-3']);
  });

  it('orders grades within a subject newest eventDate first', () => {
    // The backend already sends them this way, but the model is reused by a
    // view that may filter or merge: ordering here is what the card renders by.
    const groups = groupGradesBySubject([
      makeGrade({ id: 'old', eventDate: '2026-09-01T00:00:00.000Z' }),
      makeGrade({ id: 'new', eventDate: '2026-11-19T00:00:00.000Z' }),
      makeGrade({ id: 'mid', eventDate: '2026-10-05T00:00:00.000Z' }),
    ]);

    expect(groups[0].grades.map((g) => g.id)).toEqual(['new', 'mid', 'old']);
  });

  it('carries the group id of the subject it grouped', () => {
    const groups = groupGradesBySubject([makeGrade({ groupId: 777 })]);

    expect(groups[0].groupId).toBe(777);
  });

  it('averages the numeric grades as a plain mean', () => {
    // `rate`/`gradeRate` are 0.0 on every upstream row -- nothing is weighted,
    // so a weighted mean would be a division by zero wearing a formula.
    const groups = groupGradesBySubject([
      makeGrade({ id: 'a', grade: 90 }),
      makeGrade({ id: 'b', grade: 100 }),
      makeGrade({ id: 'c', grade: 80 }),
    ]);

    expect(groups[0].average).toBe(90);
  });

  it('rounds the average to one decimal', () => {
    const groups = groupGradesBySubject([
      makeGrade({ id: 'a', grade: 90 }),
      makeGrade({ id: 'b', grade: 91 }),
      makeGrade({ id: 'c', grade: 93 }),
    ]);

    // 274 / 3 = 91.333...
    expect(groups[0].average).toBe(91.3);
  });

  it('gives a subject with no numeric grade a null average, not NaN', () => {
    // A school in `textualGradesClasses` sends grades that are not numbers.
    // `NaN` would render as "ממוצע NaN"; null renders as the em dash.
    const groups = groupGradesBySubject([
      makeGrade({ id: 'a', grade: Number.NaN }),
      makeGrade({ id: 'b', grade: Number.NaN }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].average).toBeNull();
    // The rows are still listed -- only the arithmetic is skipped.
    expect(groups[0].grades).toHaveLength(2);
  });

  it('excludes an out-of-range grade from the average without dropping the row', () => {
    const groups = groupGradesBySubject([
      makeGrade({ id: 'ok', grade: 80 }),
      makeGrade({ id: 'bogus', grade: 1000 }),
      makeGrade({ id: 'negative', grade: -5 }),
    ]);

    expect(groups[0].average).toBe(80);
    expect(groups[0].grades.map((g) => g.id).sort()).toEqual(['bogus', 'negative', 'ok']);
  });

  it('excludes a non-finite grade from the average', () => {
    const groups = groupGradesBySubject([
      makeGrade({ id: 'ok', grade: 70 }),
      makeGrade({ id: 'inf', grade: Number.POSITIVE_INFINITY }),
    ]);

    expect(groups[0].average).toBe(70);
  });

  it('keeps the boundary grades 0 and 100 in the average', () => {
    const groups = groupGradesBySubject([
      makeGrade({ id: 'a', grade: 0 }),
      makeGrade({ id: 'b', grade: 100 }),
    ]);

    expect(groups[0].average).toBe(50);
  });
});

describe('overallAverage', () => {
  it('is null with no groups', () => {
    expect(overallAverage([])).toBeNull();
  });

  it('is null when no group has a numeric average', () => {
    const groups = groupGradesBySubject([makeGrade({ grade: Number.NaN })]);

    expect(overallAverage(groups)).toBeNull();
  });

  it('means the subject averages, not the raw grades', () => {
    // Otherwise a subject with ten quizzes outweighs one with a single test,
    // and the headline number stops describing the child's subjects.
    const groups = groupGradesBySubject([
      makeGrade({ id: 'a', subjectName: 'מתמטיקה', grade: 100 }),
      makeGrade({ id: 'b', subjectName: 'מתמטיקה', grade: 100 }),
      makeGrade({ id: 'c', subjectName: 'מתמטיקה', grade: 100 }),
      makeGrade({ id: 'd', subjectName: 'אנגלית', grade: 50 }),
    ]);

    expect(overallAverage(groups)).toBe(75);
  });

  it('skips a subject with no numeric average', () => {
    const groups = groupGradesBySubject([
      makeGrade({ id: 'a', subjectName: 'מתמטיקה', grade: 80 }),
      makeGrade({ id: 'b', subjectName: 'אנגלית', grade: Number.NaN }),
    ]);

    expect(overallAverage(groups)).toBe(80);
  });

  it('rounds to one decimal', () => {
    const groups = groupGradesBySubject([
      makeGrade({ id: 'a', subjectName: 'מתמטיקה', grade: 90 }),
      makeGrade({ id: 'b', subjectName: 'אנגלית', grade: 91 }),
      makeGrade({ id: 'c', subjectName: 'היסטוריה', grade: 93 }),
    ]);

    expect(overallAverage(groups)).toBe(91.3);
  });
});
