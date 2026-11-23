'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { ClockRange, LessonDetails } from './TimetableAtoms';
import {
  DAY_ABBREV,
  DAY_FULL,
  breakLabel,
  defaultAgendaDay,
  lessonsForDay,
  resolveHistory,
  resolvePlan,
  subjectColor,
  type GridModel,
  type LessonHistoryIndex,
  type ScheduleIndex,
  type SlotTextIndex,
} from './timetable-model';

interface TimetableDayAgendaProps {
  model: GridModel;
  schedule: ScheduleIndex;
  planIndex: SlotTextIndex;
  historyIndex: LessonHistoryIndex;
  todaySchoolDay: number;
}

/**
 * The timetable below `md`: day chips, then the selected day as a single
 * vertical column.
 *
 * Why not the week grid at phone width. At 360px, with 32px of shell padding,
 * the viewport shows 328px of a ~950px table -- and the `w-20` lesson column
 * plus the 196px "today" column is 276px of it, 84% of the visible width for
 * one day of six. The cells are not atoms either: each stacks a subject, a
 * teacher, a room pill and up to three detail paragraphs at 11px inside 144px,
 * and a table row's height is set by its worst cell, so one long plan note
 * inflates all six days.
 *
 * The clearest evidence was in the code: the week grid's `headerRefs` +
 * `hasAutoScrolledRef` + `scrollIntoView({inline:'center'})` machinery exists
 * solely to compensate for this. "Auto-scroll to today" is a worse version of
 * "today is the selected tab".
 *
 * Every testid here is the agenda's own (`timetable-agenda-*`). That is what
 * lets both presentations sit in the DOM together, switched by CSS, without
 * the week grid's `timetable-lesson-cell` / `timetable-break-row` assertions
 * resolving twice under Playwright's strict mode.
 */
export function TimetableDayAgenda({
  model,
  schedule,
  planIndex,
  historyIndex,
  todaySchoolDay,
}: TimetableDayAgendaProps) {
  const fallbackDay = defaultAgendaDay(model, todaySchoolDay);
  const [chosenDay, setChosenDay] = React.useState<number | null>(null);

  // `chosenDay` stays null until the parent taps a chip, so a child switch
  // (which replaces `model`) re-derives today rather than keeping the previous
  // child's selected day.
  const selectedDay =
    chosenDay !== null && model.days.includes(chosenDay) ? chosenDay : fallbackDay;

  if (selectedDay === null) return null;

  const rows = lessonsForDay(model, schedule, selectedDay);

  return (
    <div data-testid="timetable-agenda" className="space-y-3">
      <div
        role="group"
        aria-label="בחר יום"
        className="rail rail-bleed pb-1"
      >
        {model.days.map((day) => {
          const isSelected = day === selectedDay;
          return (
            <button
              key={day}
              type="button"
              data-testid={`timetable-agenda-day-${day}`}
              onClick={() => setChosenDay(day)}
              aria-pressed={isSelected}
              aria-label={DAY_FULL[day] ?? String(day)}
              className={cn(
                'tap-target inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
                isSelected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/80 bg-card/90 text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <span>{DAY_ABBREV[day] ?? String(day)}</span>
              {day === todaySchoolDay && (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-3xs font-semibold',
                    isSelected ? 'bg-primary-foreground/20' : 'bg-primary/15 text-primary',
                  )}
                >
                  היום
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ol className="space-y-2">
        {rows.map((row) => {
          const plan = resolvePlan(planIndex, row.entry);
          const history = resolveHistory(historyIndex, row.entry);
          const firstTeacher = row.entry.teachers[0];
          const color = subjectColor(row.entry.subjectName);

          return (
            <li key={row.lesson}>
              <article
                data-testid="timetable-agenda-lesson"
                className="card-base flex gap-3 p-3"
              >
                <div className="flex w-14 flex-shrink-0 flex-col items-center gap-0.5 text-center">
                  <span className="text-xs font-medium text-muted-foreground">{row.lesson}</span>
                  {row.period && (
                    <ClockRange
                      startTime={row.period.startTime}
                      endTime={row.period.endTime}
                      className="text-3xs text-muted-foreground"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5 text-start">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold leading-tight" style={{ color }}>
                      {row.entry.subjectName}
                    </span>
                    {firstTeacher && (
                      <span className="text-2xs text-muted-foreground">
                        {firstTeacher.teacherName}
                      </span>
                    )}
                    {row.entry.roomNum && (
                      <span className="text-3xs rounded-full border border-border/60 px-1.5 py-0.5 text-muted-foreground">
                        חדר {row.entry.roomNum}
                      </span>
                    )}
                  </div>
                  {plan && <LessonDetails label="תכנון" text={plan} />}
                  {history?.remark && <LessonDetails label="הערה" text={history.remark} />}
                  {history?.homeWork && (
                    <LessonDetails label="שיעורי בית" text={history.homeWork} />
                  )}
                </div>
              </article>

              {row.breakAfter && (
                // The week grid's BreakRow as a slim divider: same content, a
                // <div> rather than a <tr>, because there is no table here.
                <div
                  data-testid="timetable-agenda-break"
                  className="flex flex-wrap items-center justify-center gap-x-2 py-1.5 text-2xs text-muted-foreground"
                >
                  <span>{breakLabel(row.breakAfter)}</span>
                  <ClockRange
                    startTime={row.breakAfter.startTime}
                    endTime={row.breakAfter.endTime}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
