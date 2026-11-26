import { describe, it, expect } from 'vitest';
import type { GradeItem } from '@/types/api';
import { groupGradesBySubject } from './grades-model';

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

describe('ordering within a subject', () => {
  it('breaks an eventDate tie by enteredAt, then by gradingEventId', () => {
    // A test and a quiz on one day is ordinary, and without a tiebreaker the
    // two rows could swap places between refetches.
    const groups = groupGradesBySubject([
      makeGrade({
        id: 'older-entry',
        gradingEventId: 10,
        enteredAt: '2026-11-20T08:00:00.000Z',
      }),
      makeGrade({
        id: 'newer-entry',
        gradingEventId: 11,
        enteredAt: '2026-11-20T09:00:00.000Z',
      }),
      makeGrade({
        id: 'same-entry-higher-event',
        gradingEventId: 12,
        enteredAt: '2026-11-20T09:00:00.000Z',
      }),
    ]);

    expect(groups[0].grades.map((g) => g.id)).toEqual([
      'same-entry-higher-event',
      'newer-entry',
      'older-entry',
    ]);
  });

  it('is stable whatever order the rows arrive in', () => {
    const ids = (grades: GradeItem[]) =>
      groupGradesBySubject(grades)[0].grades.map((g) => g.id);
    const a = makeGrade({ id: 'a', gradingEventId: 1, eventDate: '2026-11-18T00:00:00.000Z' });
    const b = makeGrade({ id: 'b', gradingEventId: 2, eventDate: '2026-11-19T00:00:00.000Z' });

    expect(ids([a, b])).toEqual(ids([b, a]));
  });
});
