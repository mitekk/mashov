import React from 'react';
import { CalendarClock, CalendarCheck, CalendarX } from 'lucide-react';
import type { ContentFreshness } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface ContentFreshnessCardProps {
  contentFreshness?: ContentFreshness | null;
}

/**
 * Shows the age of the content rather than of the last sync. For five months
 * every sync source read "fresh" while the newest homework in the database was
 * from a school year that had already ended, so the one number a parent needs
 * is how old the newest item actually is.
 */
export function ContentFreshnessCard({ contentFreshness }: ContentFreshnessCardProps) {
  if (!contentFreshness) return null;

  const { status, expectedSchoolYear, observedSchoolYear, newestContentAt, contentAgeDays } =
    contentFreshness;

  const label =
    status === 'current'
      ? 'המידע מעודכן לשנת הלימודים הנוכחית'
      : status === 'stale_year'
        ? 'המידע הוא משנת לימודים שהסתיימה'
        : 'אין עדיין מידע';

  const Icon =
    status === 'current' ? CalendarCheck : status === 'stale_year' ? CalendarX : CalendarClock;

  return (
    <div
      data-testid="content-freshness-card"
      data-status={status}
      className="card-base flex items-start gap-3 px-4 py-3"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 h-4 w-4 flex-shrink-0',
          status === 'current' && 'text-positive',
          status === 'stale_year' && 'text-destructive',
          status === 'no_content' && 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1">
        <p
          data-testid="content-freshness-label"
          className={cn(
            'text-sm font-medium',
            status === 'stale_year' ? 'text-destructive' : 'text-foreground',
          )}
        >
          {label}
        </p>
        <p data-testid="content-freshness-years" className="mt-0.5 text-xs text-muted-foreground">
          שנה מבוקשת {expectedSchoolYear} · שנה מחוברת {observedSchoolYear || '—'}
        </p>
        {newestContentAt && (
          <p data-testid="content-freshness-newest" className="text-xs text-muted-foreground">
            הפריט החדש ביותר: {formatRelativeHe(newestContentAt)}
            {contentAgeDays !== null && ` (${contentAgeDays} ימים)`}
          </p>
        )}
      </div>
    </div>
  );
}
