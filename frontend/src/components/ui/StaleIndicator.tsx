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
          ? 'border-b border-attention/45 bg-attention-subtle px-4 py-1.5'
          : 'border-b border-attention/35 bg-attention-subtle/85 px-4 py-1'
      }
      role="status"
      aria-live="polite"
    >
      <p
        className={
          isDegraded
            ? 'text-center text-xs font-medium text-attention'
            : 'text-center text-xs text-attention'
        }
      >
        {isDegraded
          ? 'שגיאת סנכרון — הנתונים עשויים להיות ישנים'
          : 'הנתונים עשויים להיות ישנים'}
      </p>
    </div>
  );
}
