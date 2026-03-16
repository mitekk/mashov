'use client';

import React from 'react';
import { CalendarDays } from 'lucide-react';
import { useChildTimetable } from '@/hooks/useChild';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { TableSkeleton } from '@/components/ui/LoadingState';
import type { TimetableEntry } from '@/types/api';

interface TimetableSectionProps {
  studentGuid: string;
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

function buildGrid(entries: TimetableEntry[]): {
  days: number[];
  lessons: number[];
  grid: Map<number, Map<number, TimetableEntry>>;
} {
  const byLesson = new Map<number, Map<number, TimetableEntry>>();
  const daySet = new Set<number>();
  const lessonSet = new Set<number>();
  for (const e of entries) {
    daySet.add(e.day);
    lessonSet.add(e.lesson);
    if (!byLesson.has(e.lesson)) byLesson.set(e.lesson, new Map());
    byLesson.get(e.lesson)!.set(e.day, e);
  }
  return {
    days: [...daySet].sort((a, b) => a - b),
    lessons: [...lessonSet].sort((a, b) => a - b),
    grid: byLesson,
  };
}

interface LessonCellProps {
  entry: TimetableEntry;
}

function LessonCell({ entry }: LessonCellProps) {
  const firstTeacher = entry.teachers[0];
  const color = subjectColor(entry.subjectName);
  return (
    <td
      data-testid="timetable-lesson-cell"
      className="px-2 py-2 text-center align-top min-w-[100px]"
    >
      <div className="flex flex-col items-center gap-0.5">
        <span
          className="text-xs font-semibold leading-tight"
          style={{ color }}
        >
          {entry.subjectName}
        </span>
        {firstTeacher && (
          <span className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[90px]">
            {firstTeacher.teacherName}
          </span>
        )}
        {entry.roomNum && (
          <span className="text-[10px] rounded-full border border-border/60 px-1.5 py-0.5 mt-0.5 inline-block text-muted-foreground">
            {entry.roomNum}
          </span>
        )}
      </div>
    </td>
  );
}

function EmptyCell() {
  return (
    <td
      data-testid="timetable-empty-cell"
      className="px-2 py-2 text-center align-top min-w-[100px] text-muted-foreground/40 text-xs"
    >
      —
    </td>
  );
}

export function TimetableSection({ studentGuid }: TimetableSectionProps) {
  const { data, isLoading, isError, refetch } = useChildTimetable(studentGuid);

  return (
    <section data-testid="timetable-section" className="section-stack py-1">
      <h2 className="text-lg font-semibold text-foreground">לוח שיעורים</h2>
      {isLoading && <TableSkeleton rows={8} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון לוח שיעורים"
          onRetry={() => void refetch()}
        />
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<CalendarDays className="w-8 h-8" />}
          title="לא נמצא לוח שיעורים"
        />
      )}
      {data && data.data.length > 0 && (() => {
        const { days, lessons, grid } = buildGrid(data.data);
        return (
          <div className="card-base overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/55">
                    <th
                      className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-center w-12"
                      scope="col"
                    >
                      שיעור
                    </th>
                    {days.map((day) => (
                      <th
                        key={day}
                        scope="col"
                        title={DAY_FULL[day]}
                        aria-label={DAY_FULL[day]}
                        className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-center min-w-[100px]"
                      >
                        {DAY_ABBREV[day] ?? String(day)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lessons.map((lesson) => (
                    <tr
                      key={lesson}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-3 py-2 text-center align-top w-12 font-medium text-muted-foreground text-xs">
                        {lesson}
                      </td>
                      {days.map((day) => {
                        const entry = grid.get(lesson)?.get(day);
                        return entry
                          ? <LessonCell key={day} entry={entry} />
                          : <EmptyCell key={day} />;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
