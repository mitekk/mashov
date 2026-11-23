'use client';

import React, { Suspense, useEffect, useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
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
import { useRouter, useSearchParams } from 'next/navigation';
import { SchoolFilterChips } from '@/components/school/SchoolFilterChips';
import { useMe } from '@/hooks/useAuth';
import {
  matchesSchoolFilter,
  parseSchoolFilter,
  serializeSchoolFilter,
  type SchoolFilter,
} from '@/lib/school-filter';

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
};

function HomePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, isLoading, isError, refetch } = useDashboard();
  const { data: me } = useMe();
  const {
    selectedChildGuid,
    setSelectedChildGuid,
    hasHydrated: hasSelectedChildHydrated,
  } = useSelectedChild();

  const dashboard = data ?? EMPTY_DASHBOARD;
  const hasChildren = dashboard.children.length > 0;

  const schoolFilter = parseSchoolFilter(searchParams.get('school'), me?.schools ?? []);

  function setSchoolFilter(next: SchoolFilter) {
    const params = new URLSearchParams(searchParams.toString());
    const value = serializeSchoolFilter(next);
    if (value === null) params.delete('school');
    else params.set('school', value);
    const query = params.toString();
    router.replace(query ? `/home?${query}` : '/home');
  }

  /**
   * The filter is RENDER-ONLY. It never touches the selected child.
   *
   * Child selection is a workspace concern persisted in
   * localStorage['mashov.selectedChildGuid'], and the auto-select effect below
   * deliberately keeps operating on the UNFILTERED list -- otherwise merely
   * looking at one school would silently reassign which child the rest of the
   * app is about.
   */
  const visibleChildren = useMemo(
    () =>
      dashboard.children.filter((child) =>
        matchesSchoolFilter(schoolFilter, semelOf(child.schoolId, me?.schools)),
      ),
    [dashboard.children, schoolFilter, me?.schools],
  );

  const visibleFeed = useMemo(
    () =>
      dashboard.feed.filter((item) =>
        matchesSchoolFilter(schoolFilter, semelOf(item.schoolId, me?.schools)),
      ),
    [dashboard.feed, schoolFilter, me?.schools],
  );

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

        <SchoolFilterChips value={schoolFilter} onChange={setSchoolFilter} />

        {hasChildren && (
          <section data-testid="home-children" className="section-stack">
            <h2 className="text-lg font-semibold text-foreground">ילדים</h2>
            {/*
              A scroll-snap rail on a phone, a grid once there is room for one.
              The md+ half is spelled in utilities rather than `md:card-grid`
              on purpose: `.rail` and `.card-grid` are both `@layer
              components`, and between two rules in the same layer source order
              decides, not the breakpoint -- so `md:card-grid` would be a
              coin-flip against `.rail`'s `display:flex`. Utilities always win
              over the components layer, so these do.
            */}
            <div className="rail pb-1 md:grid md:grid-cols-2 md:gap-3 md:overflow-visible xl:grid-cols-3">
              {visibleChildren.map((child) => (
                <ChildQuickCard
                  key={child.studentGuid}
                  child={child}
                />
              ))}
            </div>
          </section>
        )}

        {/* Latest feed */}
        {/* Filtered in step with the rail above: a chip that narrowed the
            children but not the feed below them would be worse than no chip. */}
        <LatestFeed items={visibleFeed} />
      </div>
    </AppShell>
  );
}

/** A connection id resolved to the semel the filter is keyed by. */
function semelOf(
  schoolId: string | null,
  schools: Array<{ id: string; semel: number }> | undefined,
): number | null {
  if (!schoolId) return null;
  return schools?.find((school) => school.id === schoolId)?.semel ?? null;
}

/**
 * `useSearchParams` reads the school filter, and Next refuses to statically
 * prerender a page that calls it without a boundary. The same wrapper /inbox
 * already uses, for the same reason.
 */
export default function HomePage() {
  return (
    <Suspense
      fallback={(
        <AppShell>
          <LoadingState message="טוען נתונים..." />
        </AppShell>
      )}
    >
      <HomePageContent />
    </Suspense>
  );
}
