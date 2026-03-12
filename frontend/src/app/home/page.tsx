'use client';

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SummaryStrip } from '@/components/home/SummaryStrip';
import { NeedsAttentionSection } from '@/components/home/NeedsAttentionSection';
import { LatestFeed } from '@/components/home/LatestFeed';
import { ChildQuickCard } from '@/components/home/ChildQuickCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useDashboard, useSyncRefresh } from '@/hooks/useDashboard';
import { formatRelativeHe } from '@/lib/dates';
import type { DashboardResponse } from '@/types/api';

const EMPTY_DASHBOARD: DashboardResponse = {
  freshness: {
    state: 'fresh',
    lastSyncAt: null,
    staleSources: [],
  },
  summary: {
    unreadConversations: 0,
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    childrenCount: 0,
  },
  needsAttention: [],
  feed: [],
  children: [],
  school: {
    schoolName: '',
    schoolYear: new Date().getFullYear(),
  },
};

export default function HomePage() {
  const { data, isLoading, isError, refetch } = useDashboard();
  const { mutate: triggerRefresh, isPending: isRefreshing } = useSyncRefresh();

  const handleRefresh = () => {
    triggerRefresh(undefined, { onSuccess: () => void refetch() });
  };

  if (isLoading) return <AppShell><LoadingState message="טוען נתונים..." /></AppShell>;

  const dashboard = data ?? EMPTY_DASHBOARD;

  const now = new Date();
  const currentDateHe = now.toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <AppShell>
      <div className="px-4 pb-4 space-y-5">
        {/* Header strip */}
        <header data-testid="home-header" className="flex items-start justify-between pt-4 gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">מרכז הורים</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{currentDateHe}</p>
            {dashboard.freshness.lastSyncAt && (
              <p className="text-xs text-muted-foreground">
                סונכרן {formatRelativeHe(dashboard.freshness.lastSyncAt)}
              </p>
            )}
          </div>
          <button
            data-testid="refresh-button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label="רענן נתונים"
            className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </header>

        {isError && (
          <ErrorState
            message="אירעה שגיאה בטעינת הדשבורד. מוצגים נתונים חלקיים."
            onRetry={() => void refetch()}
          />
        )}

        {/* Summary strip */}
        <SummaryStrip summary={dashboard.summary} />

        {/* Needs attention */}
        {dashboard.needsAttention.length > 0 && (
          <NeedsAttentionSection items={dashboard.needsAttention} />
        )}

        {/* Child quick cards */}
        {dashboard.children.length > 0 && (
          <section data-testid="children-section">
            <h2 className="text-base font-semibold text-foreground mb-3">ילדים</h2>
            <div className="grid gap-3">
              {dashboard.children.map((child) => (
                <ChildQuickCard key={child.studentGuid} child={child} />
              ))}
            </div>
          </section>
        )}

        {/* Latest feed */}
        <LatestFeed items={dashboard.feed} />
      </div>
    </AppShell>
  );
}
