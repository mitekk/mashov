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
import { holdsOnlyEarlierYears } from './section-emptiness';
import { TimetableDayAgenda } from './TimetableDayAgenda';
import { TimetableWeekGrid } from './TimetableWeekGrid';
import {
  buildGrid,
  buildHistoryIndex,
  buildPlanIndex,
  buildScheduleIndex,
  getTodaySchoolDay,
  type GridModel,
} from './timetable-model';

interface TimetableSectionProps {
  studentGuid: string;
}

/**
 * The child's week, in two presentations over one model.
 *
 * Both children stay in the DOM and are switched by CSS (`md:hidden` /
 * `hidden md:block`), never by a `useMediaQuery` conditional: a JS switch lets
 * SSR pick one arm and the client flip it, which is a hydration flicker on
 * exactly the slow devices this app targets. Each presentation owns its own
 * testids, so neither resolves twice under Playwright's strict mode.
 */
export function TimetableSection({ studentGuid }: TimetableSectionProps) {
  const { data: timetableData, isLoading, isError, refetch } = useChildTimetable(studentGuid);
  const { data: plansData } = useChildLessonPlans(studentGuid);
  const { data: historyData } = useChildLessonHistory(studentGuid);
  const todaySchoolDay = getTodaySchoolDay();

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

  return (
    <section
      data-testid="timetable-section"
      // The tab rail above already names this section, so the heading is
      // `sr-only` -- the outline needs it, the eye does not.
      // `aria-labelledby` rather than `aria-label`: the two would otherwise
      // announce the same name twice, once as the region and once as the
      // heading.
      aria-labelledby="timetable-section-title"
      className="section-stack py-1"
    >
      <h2 id="timetable-section-title" className="sr-only">לוח שיעורים</h2>
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
      {/* See `SubjectsSection`: "no grid" and "this year's grid is not out
          yet" are different facts, and only one of them is ours to assert. */}
      {timetableData &&
        timetableData.data.length === 0 &&
        !holdsOnlyEarlierYears(timetableData.meta) && (
          <EmptyState
            icon={<CalendarDays className="w-8 h-8" />}
            title="לא נמצא לוח שיעורים"
          />
        )}
      {timetableData &&
        timetableData.data.length === 0 &&
        holdsOnlyEarlierYears(timetableData.meta) && (
          <EmptyState
            icon={<CalendarDays className="w-8 h-8" />}
            title="לוח השיעורים לשנה הנוכחית עוד לא פורסם"
            subtitle="הלוח שיש לנו הוא משנת הלימודים הקודמת, ולכן לא מוצג כאן. הוא יתעדכן כשבית הספר יפרסם את הלוח החדש."
          />
        )}
      {gridModel && (
        <>
          <div className="md:hidden">
            <TimetableDayAgenda
              // Keyed by child: the agenda holds the selected day in local
              // state, and a remount is the cleanest way to re-derive today
              // when the parent switches children.
              key={studentGuid}
              model={gridModel}
              schedule={scheduleIndex}
              planIndex={planIndex}
              historyIndex={historyIndex}
              todaySchoolDay={todaySchoolDay}
            />
          </div>
          <div className="hidden md:block">
            <TimetableWeekGrid
              model={gridModel}
              schedule={scheduleIndex}
              planIndex={planIndex}
              historyIndex={historyIndex}
              todaySchoolDay={todaySchoolDay}
            />
          </div>
        </>
      )}
    </section>
  );
}
