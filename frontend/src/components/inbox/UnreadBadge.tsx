import React from 'react';

interface UnreadBadgeProps {
  count: number;
}

/**
 * `aria-label`, because the only thing beside this badge is the app header's
 * title span, which is `aria-hidden` (see `AppHeader`). Without a name a
 * screen reader reads out a bare number with no idea what it counts.
 */
export function UnreadBadge({ count }: UnreadBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={count === 1 ? 'שיחה אחת שלא נקראה' : `${count} שיחות שלא נקראו`}
      className="min-w-[20px] h-5 px-1.5 bg-destructive text-destructive-foreground text-xs font-bold rounded-full inline-flex items-center justify-center tabular-nums"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
