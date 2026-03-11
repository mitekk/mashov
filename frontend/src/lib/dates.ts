import {
  formatDistanceToNow,
  format,
  parseISO,
  isValid,
  differenceInHours,
  differenceInDays,
} from 'date-fns';

/**
 * Returns a relative time string in Hebrew.
 * For dates older than 7 days, returns absolute date.
 */
export function formatRelativeHe(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = parseISO(isoString);
  if (!isValid(date)) return '';

  const now = new Date();
  const hoursAgo = differenceInHours(now, date);
  const daysAgo = differenceInDays(now, date);

  if (hoursAgo < 1) return 'לפני פחות משעה';
  if (hoursAgo === 1) return 'לפני שעה';
  if (hoursAgo < 24) return `לפני ${hoursAgo} שעות`;
  if (daysAgo === 1) return 'אתמול';
  if (daysAgo < 7) return `לפני ${daysAgo} ימים`;

  return formatAbsoluteHe(isoString);
}

/**
 * Returns an absolute date in a natural Hebrew format.
 * e.g. "5 במרץ 2026"
 */
export function formatAbsoluteHe(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = parseISO(isoString);
  if (!isValid(date)) return '';

  const months = [
    'בינואר', 'בפברואר', 'במרץ', 'באפריל', 'במאי', 'ביוני',
    'ביולי', 'באוגוסט', 'בספטמבר', 'באוקטובר', 'בנובמבר', 'בדצמבר',
  ];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${day} ${month} ${year}`;
}

/**
 * Returns date in short format e.g. "05/03/26"
 */
export function formatShortDate(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = parseISO(isoString);
  if (!isValid(date)) return '';
  return format(date, 'dd/MM/yy');
}

/**
 * Returns time in HH:mm format
 */
export function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = parseISO(isoString);
  if (!isValid(date)) return '';
  return format(date, 'HH:mm');
}

/**
 * Returns both relative and absolute:  "לפני 3 ימים (5 במרץ)"
 */
export function formatRelativeWithAbsolute(
  isoString: string | null | undefined,
): string {
  if (!isoString) return '';
  const date = parseISO(isoString);
  if (!isValid(date)) return '';

  const daysAgo = differenceInDays(new Date(), date);
  if (daysAgo < 7) {
    return `${formatRelativeHe(isoString)} (${formatAbsoluteHe(isoString)})`;
  }
  return formatAbsoluteHe(isoString);
}

/**
 * Formats date for display in header (e.g. "יום שלישי, 11 במרץ 2026")
 */
export function formatHeaderDate(date: Date = new Date()): string {
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const dayName = days[date.getDay()];
  const months = [
    'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
  ];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `יום ${dayName}, ${day} ב${month} ${year}`;
}

/**
 * Returns a "last synced X ago" string.
 */
export function formatLastSync(isoString: string | null | undefined): string {
  if (!isoString) return 'טרם סונכרן';
  const date = parseISO(isoString);
  if (!isValid(date)) return '';
  return `סונכרן ${formatRelativeHe(isoString)}`;
}

// Re-export for convenience
export { formatDistanceToNow, parseISO, isValid };
