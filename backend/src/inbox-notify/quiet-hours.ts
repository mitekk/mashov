/**
 * The hours of the night the inbox notifier stays silent.
 *
 * Checked inside the handler rather than expressed in the cron. A `@Cron`
 * expression is evaluated when the decorator runs, so it cannot come from
 * ConfigService -- and more importantly, mail that arrives at 02:00 must
 * **wait** for the window to close rather than be dropped. The lookback window
 * is what carries it over; this only decides whether to speak now.
 */

/** "21:00" -> 1260. Null for anything this cannot read as a time of day. */
function minutesOfDay(raw: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * The local time in `timeZone`, in minutes past midnight.
 *
 * Through Intl, so DST is the platform's problem. The container runs at
 * TZ=UTC, which in Israel is one or two hours behind -- reading the process
 * clock would open the window at the wrong time twice a year.
 */
function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const field = (type: 'hour' | 'minute'): number =>
    Number(parts.find((part) => part.type === type)?.value);

  return field('hour') * 60 + field('minute');
}

/**
 * Whether `now` falls inside the quiet window.
 *
 * Fails open on an unparseable window: a typo that makes the window
 * permanently quiet kills the feature with no error anyone sees, while a typo
 * that makes it never quiet costs one message at an awkward hour.
 */
export function isWithinQuietHours(
  now: Date,
  timeZone: string,
  from: string,
  to: string,
): boolean {
  const start = minutesOfDay(from);
  const end = minutesOfDay(to);
  if (start === null || end === null || start === end) return false;

  const current = localMinutes(now, timeZone);
  // The default window (21:00 -> 07:00) wraps midnight, which a plain
  // start <= current < end misses entirely.
  return start < end ? current >= start && current < end : current >= start || current < end;
}
