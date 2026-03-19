'use client';

import React, { useEffect, useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { SummaryStrip } from '@/components/home/SummaryStrip';
import { ChildQuickCard } from '@/components/home/ChildQuickCard';
import { LatestFeed } from '@/components/home/LatestFeed';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { useDashboard } from '@/hooks/useDashboard';
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
  feed: [],
  children: [],
  school: {
    schoolName: '',
    schoolYear: new Date().getFullYear(),
  },
};

export default function HomePage() {
  const { data, isLoading, isError, refetch } = useDashboard();
  const {
    selectedChildGuid,
    setSelectedChildGuid,
    hasHydrated: hasSelectedChildHydrated,
  } = useSelectedChild();

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
            <RefreshButton />
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
                />
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
