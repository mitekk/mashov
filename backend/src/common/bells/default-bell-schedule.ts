import type { BellPeriod } from './derive-breaks';

/**
 * The bundled fallback, used when the school serves no bell schedule.
 *
 * The start times are the ones the early-release picker has shipped with since
 * it was built (they used to live in `ReleasesDialog.tsx` as a client-only
 * map); the end times are those starts plus a 45-minute lesson. That makes the
 * gaps 5, 10, 5, 25, 5, 5 and 5 minutes — so the post-fourth-period gap is the
 * day's longest and `deriveBreaks` reads it as lunch, which is where an
 * Israeli elementary school day actually puts it.
 *
 * These times are approximate and school-agnostic. Anything that renders them
 * must say so: `getTimetable` reports `source: 'default'` precisely so the UI
 * can caveat them rather than pass them off as the school's own (ADR-0037).
 */
export const DEFAULT_BELL_SCHEDULE: readonly BellPeriod[] = [
  { lesson: 1, startTime: '08:00', endTime: '08:45' },
  { lesson: 2, startTime: '08:50', endTime: '09:35' },
  { lesson: 3, startTime: '09:45', endTime: '10:30' },
  { lesson: 4, startTime: '10:35', endTime: '11:20' },
  { lesson: 5, startTime: '11:45', endTime: '12:30' },
  { lesson: 6, startTime: '12:35', endTime: '13:20' },
  { lesson: 7, startTime: '13:25', endTime: '14:10' },
  { lesson: 8, startTime: '14:15', endTime: '15:00' },
];
