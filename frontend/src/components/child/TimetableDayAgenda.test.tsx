import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TimetableEntry, TimetableSchedule } from '@/types/api';
import {
  buildGrid,
  buildScheduleIndex,
  type LessonHistoryIndex,
  type SlotTextIndex,
} from './timetable-model';
import { TimetableDayAgenda } from './TimetableDayAgenda';

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

function renderAgenda({
  todaySchoolDay = 1,
  planIndex = EMPTY_PLANS,
  historyIndex = EMPTY_HISTORY,
  entries = ENTRIES,
}: {
  todaySchoolDay?: number;
  planIndex?: SlotTextIndex;
  historyIndex?: LessonHistoryIndex;
  entries?: TimetableEntry[];
} = {}) {
  return render(
    <TimetableDayAgenda
      model={buildGrid(entries)}
      schedule={buildScheduleIndex(schedule)}
      planIndex={planIndex}
      historyIndex={historyIndex}
      todaySchoolDay={todaySchoolDay}
    />,
  );
}

describe('TimetableDayAgenda', () => {
  it('offers a chip per day the child has lessons on', () => {
    renderAgenda();

    expect(screen.getByTestId('timetable-agenda-day-1')).not.toBeNull();
    expect(screen.getByTestId('timetable-agenda-day-3')).not.toBeNull();
    // Day 2 has no lessons, so it is not a day in this child's week.
    expect(screen.queryByTestId('timetable-agenda-day-2')).toBeNull();
  });

  it('preselects today', () => {
    // This is the whole point of the agenda: "today is the selected tab" rather
    // than "auto-scroll a 950px table to today".
    renderAgenda({ todaySchoolDay: 3 });

    expect(screen.getByTestId('timetable-agenda-day-3').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('timetable-agenda-day-1').getAttribute('aria-pressed')).toBe('false');
  });

  it('falls back to the first school day when today has no lessons', () => {
    renderAgenda({ todaySchoolDay: 6 });

    expect(screen.getByTestId('timetable-agenda-day-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('lists only the selected day lessons', () => {
    renderAgenda({ todaySchoolDay: 1 });

    expect(screen.getAllByTestId('timetable-agenda-lesson')).toHaveLength(2);
    expect(screen.getByText('מתמטיקה')).not.toBeNull();
    expect(screen.queryByText('היסטוריה')).toBeNull();
  });

  it('switches the day when another chip is pressed', () => {
    renderAgenda({ todaySchoolDay: 1 });

    fireEvent.click(screen.getByTestId('timetable-agenda-day-3'));

    expect(screen.getAllByTestId('timetable-agenda-lesson')).toHaveLength(1);
    expect(screen.getByText('היסטוריה')).not.toBeNull();
  });

  it('shows the teacher, room and clock window for a lesson', () => {
    renderAgenda({ todaySchoolDay: 1 });

    const first = screen.getAllByTestId('timetable-agenda-lesson')[0];
    expect(first.textContent).toContain('רונית לוי');
    expect(first.textContent).toContain('חדר 204');
    expect(first.textContent).toContain('08:15–09:00');
  });

  it('renders the break between two lessons of the selected day', () => {
    renderAgenda({ todaySchoolDay: 1 });

    const breaks = screen.getAllByTestId('timetable-agenda-break');
    expect(breaks).toHaveLength(1);
    expect(breaks[0].textContent).toContain('הפסקה');
    expect(breaks[0].textContent).toContain('09:00–09:10');
  });

  it('keeps the break out of the preceding lesson list item', () => {
    // Sharing an <li> with the lesson above it makes a screen reader read
    // "lesson ... break ..." as one item. The break gets its own
    // presentational <li> instead, so it is still a sibling in source order
    // but is not counted as a lesson.
    renderAgenda({ todaySchoolDay: 1 });

    const breakEl = screen.getAllByTestId('timetable-agenda-break')[0];
    const item = breakEl.closest('li');

    expect(item).not.toBeNull();
    expect(item?.querySelector('[data-testid="timetable-agenda-lesson"]')).toBeNull();
    expect(item?.getAttribute('role')).toBe('presentation');
  });

  it('counts only lessons as list items', () => {
    renderAgenda({ todaySchoolDay: 1 });

    expect(screen.getAllByRole('listitem')).toHaveLength(
      screen.getAllByTestId('timetable-agenda-lesson').length,
    );
  });

  it('omits a trailing break after the day last lesson', () => {
    // The gap after the child's last period is the end of their day, not a
    // recess they stay at school for.
    renderAgenda({ todaySchoolDay: 3 });

    expect(screen.queryByTestId('timetable-agenda-break')).toBeNull();
  });

  it('renders the plan, remark and homework for a lesson', () => {
    const planIndex: SlotTextIndex = {
      byGroup: new Map([['1-1-10', 'פרק 3']]),
      bySlot: new Map(),
    };
    const historyIndex: LessonHistoryIndex = {
      byGroup: new Map([['1-1-10', { remark: 'נבחן בעל פה', homeWork: 'תרגילים 1-10' }]]),
      bySlot: new Map(),
    };
    renderAgenda({ todaySchoolDay: 1, planIndex, historyIndex });

    const first = screen.getAllByTestId('timetable-agenda-lesson')[0];
    expect(first.textContent).toContain('פרק 3');
    expect(first.textContent).toContain('נבחן בעל פה');
    expect(first.textContent).toContain('תרגילים 1-10');
  });

  it('falls back to the slot-level plan when the group has none', () => {
    const planIndex: SlotTextIndex = {
      byGroup: new Map(),
      bySlot: new Map([['1-2', 'יחידה 4']]),
    };
    renderAgenda({ todaySchoolDay: 1, planIndex });

    const second = screen.getAllByTestId('timetable-agenda-lesson')[1];
    expect(second.textContent).toContain('יחידה 4');
  });

  it('keeps every day chip a tap target', () => {
    renderAgenda();

    expect(screen.getByTestId('timetable-agenda-day-1').className).toContain('tap-target');
  });
});
