import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimetableEntry, TimetableSchedule } from '@/types/api';
import {
  buildGrid,
  buildScheduleIndex,
  type LessonHistoryIndex,
  type SlotTextIndex,
} from './timetable-model';
import { TimetableWeekGrid } from './TimetableWeekGrid';

function entry(overrides: Partial<TimetableEntry>): TimetableEntry {
  return {
    id: `${overrides.day}-${overrides.lesson}`,
    studentGuid: 'guid-1',
    groupId: 10,
    day: 1,
    lesson: 1,
    roomNum: '204',
    weeks: 1,
    groupName: 'קבוצה',
    subjectName: 'מתמטיקה',
    teachers: [{ teacherName: 'רונית לוי' }],
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as TimetableEntry;
}

const schedule: TimetableSchedule = {
  source: 'school',
  periods: [
    { lesson: 1, startTime: '08:15', endTime: '09:00' },
    { lesson: 2, startTime: '09:10', endTime: '09:55' },
  ],
  breaks: [
    { afterLesson: 1, startTime: '09:00', endTime: '09:10', minutes: 10, kind: 'recess' },
  ],
};

const ENTRIES = [
  entry({ day: 1, lesson: 1, subjectName: 'מתמטיקה' }),
  entry({ day: 1, lesson: 2, subjectName: 'אנגלית', groupId: 11 }),
  entry({ day: 3, lesson: 1, subjectName: 'היסטוריה', groupId: 12 }),
];

const EMPTY_PLANS: SlotTextIndex = { byGroup: new Map(), bySlot: new Map() };
const EMPTY_HISTORY: LessonHistoryIndex = { byGroup: new Map(), bySlot: new Map() };

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  // jsdom does not implement it; without a stub a call would throw rather than
  // be observable.
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderGrid(todaySchoolDay = 1) {
  return render(
    <TimetableWeekGrid
      model={buildGrid(ENTRIES)}
      schedule={buildScheduleIndex(schedule)}
      planIndex={EMPTY_PLANS}
      historyIndex={EMPTY_HISTORY}
      todaySchoolDay={todaySchoolDay}
    />,
  );
}

describe('TimetableWeekGrid', () => {
  it('renders a column per school day the child has lessons on', () => {
    renderGrid();

    expect(screen.getByLabelText('ראשון')).not.toBeNull();
    expect(screen.getByLabelText('שלישי')).not.toBeNull();
    expect(screen.queryByLabelText('שני')).toBeNull();
  });

  it('renders a cell per lesson, and an empty cell where there is none', () => {
    renderGrid();

    // Two lesson rows x two days = 4 cells, of which 3 hold a lesson.
    expect(screen.getAllByTestId('timetable-lesson-cell')).toHaveLength(3);
    expect(screen.getAllByTestId('timetable-empty-cell')).toHaveLength(1);
  });

  it('marks today', () => {
    renderGrid(3);

    expect(screen.getByLabelText('שלישי').className).toContain('bg-primary/15');
    expect(screen.getByLabelText('ראשון').className).not.toContain('bg-primary/15');
  });

  it('renders the break between two lesson rows', () => {
    renderGrid();

    const breaks = screen.getAllByTestId('timetable-break-row');
    expect(breaks).toHaveLength(1);
    expect(breaks[0].textContent).toContain('09:00–09:10');
  });

  it('never scrolls itself', () => {
    // The grid used to auto-scroll today's column into view, which only ever
    // made sense while it could be wider than its scroller. It cannot be:
    // from md it is `table-fixed` at `w-full`, and below md the parent renders
    // it inside `hidden md:block`, where scrollIntoView has no box to act on.
    // The agenda selects today directly at those widths instead.
    renderGrid(3);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
