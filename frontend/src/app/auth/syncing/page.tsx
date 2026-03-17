'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getSyncStatus, triggerSyncRefresh } from '@/api/sync';

export default function SyncingPage() {
  const router = useRouter();
  const [showSkip, setShowSkip] = useState(false);
  const refreshTriggeredRef = useRef(false);

  const { data } = useQuery({
    queryKey: ['sync-status'],
    queryFn: getSyncStatus,
    staleTime: 0,
    refetchInterval: (query) => {
      if (query.state.data?.done) return false;
      return 3_000;
    },
  });

  useEffect(() => {
    if (refreshTriggeredRef.current) return;
    refreshTriggeredRef.current = true;
    triggerSyncRefresh().catch(() => {
      // Best-effort trigger: status polling + skip path still work if this fails.
    });
  }, []);

  useEffect(() => {
    if (data?.done) {
      router.push('/');
    }
  }, [data?.done, router]);

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), 10_000);
    return () => clearTimeout(timer);
  }, []);

  const completed = data?.sourcesCompleted ?? 0;
  const total = data?.sourcesTotal ?? 0;
  const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center space-y-8">
        <div className="space-y-3">
          <h1 className="text-2xl font-bold text-foreground">מגדירים את החשבון שלך…</h1>
          <p className="text-sm text-muted-foreground">
            אנחנו מסנכרנים את הנתונים שלך מבית הספר. זה עשוי לקחת כמה רגעים.
          </p>
        </div>

        {/* Spinner */}
        <div className="flex justify-center">
          <div
            className="h-14 w-14 rounded-full border-4 border-primary/20 border-t-primary animate-spin"
            role="progressbar"
            aria-label="טוען..."
          />
        </div>

        {/* Progress bar + text */}
        <div className="space-y-2">
          {total > 0 && (
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
          <p
            data-testid="syncing-progress-text"
            className="text-sm font-medium text-foreground"
          >
            {total > 0
              ? `${completed} / ${total} מקורות הושלמו`
              : 'מאתחל…'}
          </p>
        </div>

        {/* Skip button — visible after 10s */}
        {showSkip && (
          <button
            data-testid="syncing-skip-button"
            onClick={() => router.push('/')}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
          >
            דלג על הגדרה
          </button>
        )}
      </div>
    </div>
  );
}
