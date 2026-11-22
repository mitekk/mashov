'use client';

import React from 'react';
import { CalendarDays } from 'lucide-react';
import {
  useChildTimetable,
  useChildLessonPlans,
  useChildLessonHistory,
} from '@/hooks/useChild';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { TableSkeleton } from '@/components/ui/LoadingState';
import type {
  TimetableEntry,
  LessonPlan,
  LessonHistoryEntry,
  BellPeriod,
  BellBreak,
  TimetableSchedule,
} from '@/types/api';

interface TimetableSectionProps {
  studentGuid: string;
}

interface GridModel {
  days: number[];
  lessons: number[];
  grid: Map<number, Map<number, TimetableEntry>>;
}

interface SlotTextIndex {
  byGroup: Map<string, string>;
  bySlot: Map<string, string>;
}

interface LessonHistoryNote {
  remark?: string;
  homeWork?: string;
}

interface LessonHistoryIndex {
  byGroup: Map<string, LessonHistoryNote>;
  bySlot: Map<string, LessonHistoryNote>;
}

const DAY_ABBREV: Record<number, string> = {
  1: 'א׳',
  2: 'ב׳',
  3: 'ג׳',
  4: 'ד׳',
  5: 'ה׳',
  6: 'ו׳',
};

const DAY_FULL: Record<number, string> = {
  1: 'ראשון',
  2: 'שני',
  3: 'שלישי',
  4: 'רביעי',
  5: 'חמישי',
  6: 'שישי',
};

function subjectColor(name: string): string {
  const hues = [210, 152, 32, 0, 280, 180, 340, 60];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return `hsl(${hues[hash % hues.length]}, 65%, 45%)`;
}

function getCurrentWeekDates(): Map<number, Date> {
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

function getTodaySchoolDay(): number {
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

function buildPlanIndex(plans: LessonPlan[]): SlotTextIndex {
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

function buildHistoryIndex(historyEntries: LessonHistoryEntry[]): LessonHistoryIndex {
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

function resolvePlan(index: SlotTextIndex, entry: TimetableEntry): string | undefined {
  return (
    index.byGroup.get(slotGroupKey(entry.day, entry.lesson, entry.groupId))
    ?? index.bySlot.get(slotKey(entry.day, entry.lesson))
  );
}

function resolveHistory(
  index: LessonHistoryIndex,
  entry: TimetableEntry,
): LessonHistoryNote | undefined {
  return (
    index.byGroup.get(slotGroupKey(entry.day, entry.lesson, entry.groupId))
    ?? index.bySlot.get(slotKey(entry.day, entry.lesson))
  );
}

function buildGrid(entries: TimetableEntry[]): GridModel {
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

/**
 * The clock, indexed the way the grid reads it.
 *
 * Both maps span the WHOLE bell schedule, not the rows on screen: the grid
 * shows only the periods the child has a lesson in, and which break to draw is
 * decided per rendered row below.
 */
interface ScheduleIndex {
  periodsByLesson: Map<number, BellPeriod>;
  breaksAfterLesson: Map<number, BellBreak>;
}

function buildScheduleIndex(schedule: TimetableSchedule | undefined): ScheduleIndex {
  const periodsByLesson = new Map<number, BellPeriod>();
  const breaksAfterLesson = new Map<number, BellBreak>();

  for (const period of schedule?.periods ?? []) periodsByLesson.set(period.lesson, period);
  for (const item of schedule?.breaks ?? []) breaksAfterLesson.set(item.afterLesson, item);

  return { periodsByLesson, breaksAfterLesson };
}

function breakLabel(item: BellBreak): string {
  const kindLabel = item.kind === 'lunch' ? 'הפסקת אוכל' : 'הפסקה';
  return `${kindLabel} · ${item.minutes} דק׳`;
}

interface ClockRangeProps {
  startTime: string;
  endTime: string;
  className?: string;
  testId?: string;
}

/**
 * A time range, forced LTR.
 *
 * Without `dir="ltr"` the surrounding RTL layout reorders the two clock
 * readings around the dash, so a lesson from 08:15 to 09:00 renders as
 * "09:00–08:15".
 */
function ClockRange({ startTime, endTime, className, testId }: ClockRangeProps) {
  return (
    <span dir="ltr" data-testid={testId} className={`tabular-nums ${className ?? ''}`}>
      {startTime}–{endTime}
    </span>
  );
}

interface BreakRowProps {
  item: BellBreak;
  columnCount: number;
}

function BreakRow({ item, columnCount }: BreakRowProps) {
  return (
    <tr
      data-testid="timetable-break-row"
      className="border-b border-border bg-muted/40 last:border-0"
    >
      <td colSpan={columnCount} className="px-3 py-1.5 text-center">
        <span className="inline-flex flex-wrap items-center justify-center gap-x-2 text-[11px] text-muted-foreground">
          <span>{breakLabel(item)}</span>
          <ClockRange startTime={item.startTime} endTime={item.endTime} />
        </span>
      </td>
    </tr>
  );
}

interface LessonDetailsProps {
  label: string;
  text: string;
}

function LessonDetails({ label, text }: LessonDetailsProps) {
  return (
    <p className="text-[11px] leading-relaxed text-foreground/75 whitespace-pre-wrap">
      <span className="font-semibold text-foreground">{label}: </span>
      {text}
    </p>
  );
}

interface LessonCellProps {
  entry: TimetableEntry;
  isToday: boolean;
  plan?: string;
  remark?: string;
  homeWork?: string;
}

function LessonCell({
  entry,
  isToday,
  plan,
  remark,
  homeWork,
}: LessonCellProps) {
  const firstTeacher = entry.teachers[0];
  const color = subjectColor(entry.subjectName);

  return (
    <td
      data-testid="timetable-lesson-cell"
      className={`px-2.5 py-2.5 align-top border-s border-border/50 ${
        isToday ? 'min-w-[196px] bg-primary/5' : 'min-w-[144px]'
      }`}
    >
      <div className="flex flex-col gap-1.5 text-start">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold leading-tight" style={{ color }}>
            {entry.subjectName}
          </span>
          {firstTeacher && (
            <span className="text-[11px] text-muted-foreground leading-tight">
              {firstTeacher.teacherName}
            </span>
          )}
          {entry.roomNum && (
            <span className="text-[10px] rounded-full border border-border/60 px-1.5 py-0.5 mt-0.5 inline-block w-fit text-muted-foreground">
              חדר {entry.roomNum}
            </span>
          )}
        </div>

        {plan && <LessonDetails label="תכנון" text={plan} />}
        {remark && <LessonDetails label="הערה" text={remark} />}
        {homeWork && <LessonDetails label="שיעורי בית" text={homeWork} />}
      </div>
    </td>
  );
}

interface EmptyCellProps {
  isToday: boolean;
}

function EmptyCell({ isToday }: EmptyCellProps) {
  return (
    <td
      data-testid="timetable-empty-cell"
      className={`px-2.5 py-2.5 text-center align-top border-s border-border/50 text-muted-foreground/40 text-xs ${
        isToday ? 'min-w-[196px] bg-primary/5' : 'min-w-[144px]'
      }`}
    >
      —
    </td>
  );
}

export function TimetableSection({ studentGuid }: TimetableSectionProps) {
  const { data: timetableData, isLoading, isError, refetch } = useChildTimetable(studentGuid);
  const { data: plansData } = useChildLessonPlans(studentGuid);
  const { data: historyData } = useChildLessonHistory(studentGuid);
  const todaySchoolDay = getTodaySchoolDay();

  const headerRefs = React.useRef<Record<number, HTMLTableCellElement | null>>({});
  const hasAutoScrolledRef = React.useRef(false);

  React.useEffect(() => {
    hasAutoScrolledRef.current = false;
    headerRefs.current = {};
  }, [studentGuid]);

  const gridModel = React.useMemo<GridModel | null>(() => {
    if (!timetableData || timetableData.data.length === 0) return null;
    return buildGrid(timetableData.data);
  }, [timetableData]);

  const scheduleIndex = React.useMemo(
    () => buildScheduleIndex(timetableData?.schedule),
    [timetableData?.schedule],
  );

  const planIndex = React.useMemo(
    () => buildPlanIndex(plansData?.data ?? []),
    [plansData?.data],
  );

  const historyIndex = React.useMemo(
    () => buildHistoryIndex(historyData?.data ?? []),
    [historyData?.data],
  );

  React.useEffect(() => {
    if (!gridModel || gridModel.days.length === 0 || hasAutoScrolledRef.current) return;

    const targetDay = gridModel.days.includes(todaySchoolDay)
      ? todaySchoolDay
      : gridModel.days[0];
    const targetHeader = headerRefs.current[targetDay];
    if (!targetHeader) return;

    targetHeader.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
      inline: 'center',
    });
    hasAutoScrolledRef.current = true;
  }, [gridModel, todaySchoolDay]);

  return (
    <section data-testid="timetable-section" className="section-stack py-1">
      <h2 className="text-lg font-semibold text-foreground">לוח שיעורים</h2>
      {gridModel && timetableData?.schedule?.source === 'default' && (
        <p
          data-testid="timetable-schedule-approximate"
          className="text-xs text-muted-foreground"
        >
          השעות מוצגות לפי לוח זמנים ברירת מחדל ועשויות לא להתאים לבית הספר
        </p>
      )}
      {isLoading && <TableSkeleton rows={8} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון לוח שיעורים"
          onRetry={() => void refetch()}
        />
      )}
      {timetableData && timetableData.data.length === 0 && (
        <EmptyState
          icon={<CalendarDays className="w-8 h-8" />}
          title="לא נמצא לוח שיעורים"
        />
      )}
      {gridModel && (
        <div className="card-base overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border bg-muted/55">
                  <th
                    className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-center w-20"
                    scope="col"
                  >
                    שיעור
                  </th>
                  {gridModel.days.map((day) => {
                    const isToday = day === todaySchoolDay;
                    return (
                      <th
                        key={day}
                        ref={(element) => {
                          headerRefs.current[day] = element;
                        }}
                        scope="col"
                        title={DAY_FULL[day]}
                        aria-label={DAY_FULL[day]}
                        className={`px-3 py-2.5 text-xs font-semibold text-center border-s border-border/50 ${
                          isToday
                            ? 'min-w-[196px] bg-primary/15 text-foreground border-b-2 border-primary/40'
                            : 'min-w-[144px] text-muted-foreground'
                        }`}
                      >
                        <div className="inline-flex items-center gap-1.5">
                          <span>{DAY_ABBREV[day] ?? String(day)}</span>
                          {isToday && (
                            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                              היום
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {gridModel.lessons.map((lesson, lessonIndex) => {
                  const period = scheduleIndex.periodsByLesson.get(lesson);
                  // A break only belongs between two rows that are both on
                  // screen: the last rendered period's trailing gap is the end
                  // of the child's day, not a recess they stay at school for.
                  const isLastRenderedLesson = lessonIndex === gridModel.lessons.length - 1;
                  const breakAfter = isLastRenderedLesson
                    ? undefined
                    : scheduleIndex.breaksAfterLesson.get(lesson);

                  return (
                    <React.Fragment key={lesson}>
                      <tr className="border-b border-border last:border-0">
                        <td className="px-3 py-2 text-center align-top w-20 font-medium text-muted-foreground text-xs">
                          <span className="flex flex-col items-center gap-0.5">
                            <span>{lesson}</span>
                            {period && (
                              <ClockRange
                                testId="timetable-lesson-time"
                                startTime={period.startTime}
                                endTime={period.endTime}
                                className="text-[10px] font-normal text-muted-foreground whitespace-nowrap"
                              />
                            )}
                          </span>
                        </td>
                        {gridModel.days.map((day) => {
                          const entry = gridModel.grid.get(lesson)?.get(day);
                          if (!entry) {
                            return <EmptyCell key={day} isToday={day === todaySchoolDay} />;
                          }

                          const plan = resolvePlan(planIndex, entry);
                          const history = resolveHistory(historyIndex, entry);

                          return (
                            <LessonCell
                              key={day}
                              entry={entry}
                              isToday={day === todaySchoolDay}
                              plan={plan}
                              remark={history?.remark}
                              homeWork={history?.homeWork}
                            />
                          );
                        })}
                      </tr>
                      {breakAfter && (
                        <BreakRow item={breakAfter} columnCount={gridModel.days.length + 1} />
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
