'use client';

import React from 'react';
import type { BellBreak, TimetableEntry } from '@/types/api';
import { ClockRange, LessonDetails } from './TimetableAtoms';
import {
  DAY_ABBREV,
  DAY_FULL,
  breakLabel,
  resolveHistory,
  resolvePlan,
  subjectColor,
  type GridModel,
  type LessonHistoryIndex,
  type ScheduleIndex,
  type SlotTextIndex,
} from './timetable-model';

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
        <span className="inline-flex flex-wrap items-center justify-center gap-x-2 text-2xs text-muted-foreground">
          <span>{breakLabel(item)}</span>
          <ClockRange startTime={item.startTime} endTime={item.endTime} />
        </span>
      </td>
    </tr>
  );
}

interface LessonCellProps {
  entry: TimetableEntry;
  isToday: boolean;
  plan?: string;
  remark?: string;
  homeWork?: string;
}

function LessonCell({ entry, isToday, plan, remark, homeWork }: LessonCellProps) {
  const firstTeacher = entry.teachers[0];
  const color = subjectColor(entry.subjectName);

  return (
    <td
      data-testid="timetable-lesson-cell"
      className={`px-2.5 py-2.5 align-top border-s border-border/50 md:min-w-0 ${
        isToday ? 'min-w-[196px] bg-primary/5' : 'min-w-[144px]'
      }`}
    >
      <div className="flex flex-col gap-1.5 text-start">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold leading-tight" style={{ color }}>
            {entry.subjectName}
          </span>
          {firstTeacher && (
            <span className="text-2xs text-muted-foreground leading-tight">
              {firstTeacher.teacherName}
            </span>
          )}
          {entry.roomNum && (
            <span className="text-3xs rounded-full border border-border/60 px-1.5 py-0.5 mt-0.5 inline-block w-fit text-muted-foreground">
              חדר {entry.roomNum}
            </span>
          )}
        </div>

        {/* At md a column is only ~109px wide, so a long plan note would set
            the height of all six days in the row. Clamped there, released from
            lg where the columns are ~150px and up. */}
        {plan && <LessonDetails label="תכנון" text={plan} className="md:line-clamp-3 lg:line-clamp-none" />}
        {remark && <LessonDetails label="הערה" text={remark} className="md:line-clamp-3 lg:line-clamp-none" />}
        {homeWork && (
          <LessonDetails label="שיעורי בית" text={homeWork} className="md:line-clamp-3 lg:line-clamp-none" />
        )}
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
      className={`px-2.5 py-2.5 text-center align-top border-s border-border/50 text-muted-foreground/40 text-xs md:min-w-0 ${
        isToday ? 'min-w-[196px] bg-primary/5' : 'min-w-[144px]'
      }`}
    >
      —
    </td>
  );
}

interface TimetableWeekGridProps {
  model: GridModel;
  schedule: ScheduleIndex;
  planIndex: SlotTextIndex;
  historyIndex: LessonHistoryIndex;
  todaySchoolDay: number;
}

/**
 * The timetable from `md` up: the whole week as one table.
 *
 * `overflow-x-auto` stays at every width as a free safety wrapper -- a school
 * with unusual day counts should scroll rather than push the page -- but the
 * per-cell `min-w` floors are released at md (`md:min-w-0` plus
 * `md:table-fixed`), which is what lets six days share the width instead of
 * demanding 950px of it. Columns land at roughly 109px at 768, 150px at 1024
 * and 190px at 1280 with `page-shell-wide`.
 *
 * There is deliberately no auto-scroll-to-today. The old one could not fire:
 * its sibling reset effect ran after the ref callbacks had attached and
 * cleared the ref map, so the scroll effect always found nothing and returned
 * early -- true in `TimetableSection` before this was split out, too. Even
 * repaired it would have had nothing to do, because `table-fixed` at `w-full`
 * cannot overflow its scroller, and below md this grid is `display:none`.
 * Today is selected directly by the day agenda at those widths.
 */
export function TimetableWeekGrid({
  model,
  schedule,
  planIndex,
  historyIndex,
  todaySchoolDay,
}: TimetableWeekGridProps) {
  return (
    <div className="card-base overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse md:table-fixed">
          <thead>
            <tr className="border-b border-border bg-muted/55">
              <th
                className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-center w-20"
                scope="col"
              >
                שיעור
              </th>
              {model.days.map((day) => {
                const isToday = day === todaySchoolDay;
                return (
                  <th
                    key={day}
                    scope="col"
                    title={DAY_FULL[day]}
                    aria-label={DAY_FULL[day]}
                    className={`px-3 py-2.5 text-xs font-semibold text-center border-s border-border/50 md:min-w-0 ${
                      isToday
                        ? 'min-w-[196px] bg-primary/15 text-foreground border-b-2 border-primary/40'
                        : 'min-w-[144px] text-muted-foreground'
                    }`}
                  >
                    <div className="inline-flex items-center gap-1.5">
                      <span>{DAY_ABBREV[day] ?? String(day)}</span>
                      {isToday && (
                        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-3xs font-semibold text-primary">
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
            {model.lessons.map((lesson, lessonIndex) => {
              const period = schedule.periodsByLesson.get(lesson);
              // A break only belongs between two rows that are both on screen:
              // the last rendered period's trailing gap is the end of the
              // child's day, not a recess they stay at school for.
              const isLastRenderedLesson = lessonIndex === model.lessons.length - 1;
              const breakAfter = isLastRenderedLesson
                ? undefined
                : schedule.breaksAfterLesson.get(lesson);

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
                            className="text-3xs font-normal text-muted-foreground whitespace-nowrap"
                          />
                        )}
                      </span>
                    </td>
                    {model.days.map((day) => {
                      const entry = model.grid.get(lesson)?.get(day);
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
                    <BreakRow item={breakAfter} columnCount={model.days.length + 1} />
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
