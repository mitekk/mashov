'use client';

import React, { useEffect, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SummaryStrip } from '@/components/home/SummaryStrip';
import { ChildQuickCard } from '@/components/home/ChildQuickCard';
import { NeedsAttentionSection } from '@/components/home/NeedsAttentionSection';
import { LatestFeed } from '@/components/home/LatestFeed';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useDashboard, useSyncRefresh } from '@/hooks/useDashboard';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import { formatRelativeHe } from '@/lib/dates';
import type { DashboardResponse } from '@/types/api';

const EMPTY_DASHBOARD: DashboardResponse = {
  freshness: {
    state: 'fresh',
    lastSyncAt: null,
    staleSources: [],
  },
  summary: {
    newConversations: 0,
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
  const {
    selectedChildGuid,
    setSelectedChildGuid,
    hasHydrated: hasSelectedChildHydrated,
  } = useSelectedChild();

  const handleRefresh = () => {
    triggerRefresh(undefined, { onSuccess: () => void refetch() });
  };

  const dashboard = data ?? EMPTY_DASHBOARD;
  const hasChildren = dashboard.children.length > 0;

  const selectedChild = useMemo(
    () => dashboard.children.find((child) => child.studentGuid === selectedChildGuid) ?? null,
    [dashboard.children, selectedChildGuid],
  );

  useEffect(() => {
    if (!hasSelectedChildHydrated || !hasChildren) return;

    if (!selectedChildGuid || !selectedChild) {
      setSelectedChildGuid(dashboard.children[0].studentGuid);
    }
  }, [
    hasSelectedChildHydrated,
    hasChildren,
    selectedChildGuid,
    selectedChild,
    setSelectedChildGuid,
    dashboard.children,
  ]);

  if (isLoading) return <AppShell><LoadingState message="טוען נתונים..." /></AppShell>;

  const now = new Date();
  const currentDateHe = now.toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <AppShell>
      <div className="page-shell space-y-6">
        {/* Header strip */}
        <header data-testid="home-header" className="page-header">
          <div className="min-w-0 flex-1">
            <h1 className="page-title">מרכז הורים</h1>
            <p className="page-subtitle">{currentDateHe}</p>
            {dashboard.freshness.lastSyncAt && (
              <p className="mt-1 text-xs text-muted-foreground">
                סונכרן {formatRelativeHe(dashboard.freshness.lastSyncAt)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              data-testid="refresh-button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              aria-label="רענן נתונים"
              className="icon-button disabled:opacity-50"
            >
              <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </header>

        {isError && (
          <ErrorState
            message="אירעה שגיאה בטעינת הדשבורד. מוצגים נתונים חלקיים."
            onRetry={() => void refetch()}
          />
        )}

        {/* Summary strip */}
        <SummaryStrip summary={dashboard.summary} />

        {hasChildren && (
          <section data-testid="home-children" className="section-stack">
            <h2 className="text-lg font-semibold text-foreground">ילדים</h2>
            <div className="flex gap-2.5 overflow-x-auto pb-1 scrollbar-hide">
              {dashboard.children.map((child) => (
                <ChildQuickCard
                  key={child.studentGuid}
                  child={child}
                  isSelected={selectedChild?.studentGuid === child.studentGuid}
                />
              ))}
            </div>
          </section>
        )}

        {/* Needs attention */}
        {dashboard.needsAttention.length > 0 && (
          <NeedsAttentionSection items={dashboard.needsAttention} />
        )}

        {/* Latest feed */}
        <LatestFeed items={dashboard.feed} />
      </div>
    </AppShell>
  );
}
