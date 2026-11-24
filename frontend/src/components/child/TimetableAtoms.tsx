import React from 'react';
import { cn } from '@/lib/utils';

/** Presentational atoms the week grid and the day agenda both draw. */

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
export function ClockRange({ startTime, endTime, className, testId }: ClockRangeProps) {
  return (
    <span dir="ltr" data-testid={testId} className={cn('tabular-nums', className)}>
      {startTime}–{endTime}
    </span>
  );
}

interface LessonDetailsProps {
  label: string;
  text: string;
  className?: string;
}

export function LessonDetails({ label, text, className }: LessonDetailsProps) {
  return (
    <p className={cn('text-2xs leading-relaxed text-foreground/75 whitespace-pre-wrap', className)}>
      <span className="font-semibold text-foreground">{label}: </span>
      {text}
    </p>
  );
}
