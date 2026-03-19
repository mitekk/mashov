'use client';

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useSyncRefresh } from '@/hooks/useDashboard';
import { cn } from '@/lib/utils';

interface RefreshButtonProps {
  className?: string;
}

export function RefreshButton({ className }: RefreshButtonProps) {
  const mutation = useSyncRefresh();
  const isRefreshing = mutation.isPending;

  return (
    <button
      type="button"
      data-testid="refresh-button"
      onClick={() => mutation.mutate()}
      disabled={isRefreshing}
      aria-label="רענן נתונים"
      className={cn('icon-button disabled:opacity-50', className)}
    >
      <RefreshCw className={cn('h-5 w-5', isRefreshing && 'animate-spin')} />
    </button>
  );
}
