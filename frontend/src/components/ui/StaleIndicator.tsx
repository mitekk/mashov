import React from 'react';
import type { FreshnessState } from '@/types/api';

interface StaleIndicatorProps {
  status: FreshnessState;
}

export function StaleIndicator({ status }: StaleIndicatorProps) {
  if (status === 'fresh' || status === 'syncing') {
    return null;
  }

  const isDegraded = status === 'degraded';

  return (
    <div
      className={
        isDegraded
          ? 'bg-amber-100 border-b border-amber-300 px-4 py-1.5'
          : 'bg-amber-50 border-b border-amber-200 px-4 py-1'
      }
      role="status"
      aria-live="polite"
    >
      <p
        className={
          isDegraded
            ? 'text-xs font-medium text-amber-800 text-center'
            : 'text-xs text-amber-700 text-center'
        }
      >
        {isDegraded
          ? 'שגיאת סנכרון — הנתונים עשויים להיות ישנים'
          : 'הנתונים עשויים להיות ישנים'}
      </p>
    </div>
  );
}
