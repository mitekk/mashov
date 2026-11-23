import type {
  BellBreak,
  BellPeriod,
  LessonHistoryEntry,
  LessonPlan,
  TimetableEntry,
  TimetableSchedule,
} from '@/types/api';

/**
 * The timetable's data layer, lifted out of TimetableSection unchanged so the
 * week grid and the day agenda can share one model rather than two readings of
 * it. Nothing here knows how it will be drawn.
 */

export interface GridModel {
  days: number[];
  lessons: number[];
  grid: Map<number, Map<number, TimetableEntry>>;
}

export interface SlotTextIndex {
  byGroup: Map<string, string>;
  bySlot: Map<string, string>;
}

export interface LessonHistoryNote {
  remark?: string;
  homeWork?: string;
}

export interface LessonHistoryIndex {
  byGroup: Map<string, LessonHistoryNote>;
  bySlot: Map<string, LessonHistoryNote>;
}

/**
 * The clock, indexed the way the grid reads it.
 *
 * Both maps span the WHOLE bell schedule, not the rows on screen: a view shows
 * only the periods the child has a lesson in, and which break to draw is
 * decided per rendered row by the view.
 */
export interface ScheduleIndex {
  periodsByLesson: Map<number, BellPeriod>;
  breaksAfterLesson: Map<number, BellBreak>;
}

export const DAY_ABBREV: Record<number, string> = {
  1: 'א׳',
  2: 'ב׳',
  3: 'ג׳',
  4: 'ד׳',
  5: 'ה׳',
  6: 'ו׳',
};

export const DAY_FULL: Record<number, string> = {
  1: 'ראשון',
  2: 'שני',
  3: 'שלישי',
  4: 'רביעי',
  5: 'חמישי',
  6: 'שישי',
};

export function subjectColor(name: string): string {
  const hues = [210, 152, 32, 0, 280, 180, 340, 60];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return `hsl(${hues[hash % hues.length]}, 65%, 45%)`;
}

export function getCurrentWeekDates(): Map<number, Date> {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay());
  sunday.setHours(0, 0, 0, 0);

  const map = new Map<number, Date>();
  for (let dayOffset = 0; dayOffset < 6; dayOffset += 1) {
    const date = new Date(sunday);
    date.setDate(sunday.getDate() + dayOffset);
    map.set(dayOffset + 1, date);
  }
  return map;
}

export function getTodaySchoolDay(): number {
  return new Date().getDay() + 1;
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function slotKey(day: number, lesson: number): string {
  return `${day}-${lesson}`;
}

function slotGroupKey(day: number, lesson: number, groupId: number): string {
  return `${day}-${lesson}-${groupId}`;
}

export function buildPlanIndex(plans: LessonPlan[]): SlotTextIndex {
  const weekDates = getCurrentWeekDates();
  const byGroup = new Map<string, string>();
  const bySlot = new Map<string, string>();

  for (const planEntry of plans) {
    const planText = normalizedText(planEntry.plan);
    if (!planText) continue;

    const lessonDate = new Date(planEntry.lessondate);
    const day = lessonDate.getDay() + 1;
    const weekDate = weekDates.get(day);
    if (!weekDate || lessonDate.toDateString() !== weekDate.toDateString()) continue;

    byGroup.set(slotGroupKey(day, planEntry.lesson, planEntry.groupid), planText);
    if (!bySlot.has(slotKey(day, planEntry.lesson))) {
      bySlot.set(slotKey(day, planEntry.lesson), planText);
    }
  }

  return { byGroup, bySlot };
}

function mergeHistoryNote(
  current: LessonHistoryNote | undefined,
  incoming: LessonHistoryNote,
): LessonHistoryNote {
  return {
    remark: incoming.remark ?? current?.remark,
    homeWork: incoming.homeWork ?? current?.homeWork,
  };
}

export function buildHistoryIndex(historyEntries: LessonHistoryEntry[]): LessonHistoryIndex {
  const weekDates = getCurrentWeekDates();
  const byGroup = new Map<string, LessonHistoryNote>();
  const bySlot = new Map<string, LessonHistoryNote>();

  for (const item of historyEntries) {
    const lessonLog = item.lessonLog;
    const lessonDate = new Date(lessonLog.lessonDate);
    const day = lessonDate.getDay() + 1;
    const weekDate = weekDates.get(day);
    if (!weekDate || lessonDate.toDateString() !== weekDate.toDateString()) continue;

    const note: LessonHistoryNote = {
      remark: normalizedText(lessonLog.remark),
      homeWork: normalizedText(lessonLog.homeWork),
    };
    if (!note.remark && !note.homeWork) continue;

    const groupKey = slotGroupKey(day, lessonLog.lesson, lessonLog.groupId);
    byGroup.set(groupKey, mergeHistoryNote(byGroup.get(groupKey), note));

    const dayLessonKey = slotKey(day, lessonLog.lesson);
    bySlot.set(dayLessonKey, mergeHistoryNote(bySlot.get(dayLessonKey), note));
  }

  return { byGroup, bySlot };
}

export function resolvePlan(index: SlotTextIndex, entry: TimetableEntry): string | undefined {
  return (
    index.byGroup.get(slotGroupKey(entry.day, entry.lesson, entry.groupId))
    ?? index.bySlot.get(slotKey(entry.day, entry.lesson))
  );
}

export function resolveHistory(
  index: LessonHistoryIndex,
  entry: TimetableEntry,
): LessonHistoryNote | undefined {
  return (
    index.byGroup.get(slotGroupKey(entry.day, entry.lesson, entry.groupId))
    ?? index.bySlot.get(slotKey(entry.day, entry.lesson))
  );
}

export function buildGrid(entries: TimetableEntry[]): GridModel {
  const byLesson = new Map<number, Map<number, TimetableEntry>>();
  const daySet = new Set<number>();
  const lessonSet = new Set<number>();

  for (const entry of entries) {
    daySet.add(entry.day);
    lessonSet.add(entry.lesson);
    if (!byLesson.has(entry.lesson)) byLesson.set(entry.lesson, new Map());
    byLesson.get(entry.lesson)!.set(entry.day, entry);
  }

  return {
    days: [...daySet].sort((a, b) => a - b),
    lessons: [...lessonSet].sort((a, b) => a - b),
    grid: byLesson,
  };
}

export function buildScheduleIndex(schedule: TimetableSchedule | undefined): ScheduleIndex {
  const periodsByLesson = new Map<number, BellPeriod>();
  const breaksAfterLesson = new Map<number, BellBreak>();

  for (const period of schedule?.periods ?? []) periodsByLesson.set(period.lesson, period);
  for (const item of schedule?.breaks ?? []) breaksAfterLesson.set(item.afterLesson, item);

  return { periodsByLesson, breaksAfterLesson };
}

export function breakLabel(item: BellBreak): string {
  const kindLabel = item.kind === 'lunch' ? 'הפסקת אוכל' : 'הפסקה';
  return `${kindLabel} · ${item.minutes} דק׳`;
}

/**
 * The lessons of one day, in order, each paired with the break that follows it
 * — and never a trailing break, because the gap after the child's last period
 * is the end of their day, not a recess they stay at school for.
 *
 * The week grid decides the same thing per row; the agenda needs it per day,
 * which is a different set of lessons (only the ones this day actually has).
 */
export function lessonsForDay(
  model: GridModel,
  schedule: ScheduleIndex,
  day: number,
): Array<{ lesson: number; entry: TimetableEntry; period?: BellPeriod; breakAfter?: BellBreak }> {
  const rows = model.lessons
    .map((lesson) => ({ lesson, entry: model.grid.get(lesson)?.get(day) }))
    .filter((row): row is { lesson: number; entry: TimetableEntry } => row.entry !== undefined);

  return rows.map((row, index) => ({
    lesson: row.lesson,
    entry: row.entry,
    period: schedule.periodsByLesson.get(row.lesson),
    breakAfter:
      index === rows.length - 1
        ? undefined
        : schedule.breaksAfterLesson.get(row.lesson),
  }));
}

/** Today when the child has lessons on it, otherwise their first school day. */
export function defaultAgendaDay(model: GridModel, todaySchoolDay: number): number | null {
  if (model.days.length === 0) return null;
  return model.days.includes(todaySchoolDay) ? todaySchoolDay : model.days[0];
}
