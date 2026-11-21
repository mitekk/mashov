'use client';

import React, { Suspense, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { ChildCard } from '@/components/children/ChildCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { SchoolFilterChips } from '@/components/school/SchoolFilterChips';
import { useChildren } from '@/hooks/useChildren';
import { useMe } from '@/hooks/useAuth';
import {
  ALL_SCHOOLS,
  matchesSchoolFilter,
  parseSchoolFilter,
  serializeSchoolFilter,
  type SchoolFilter,
} from '@/lib/school-filter';
import { Users } from 'lucide-react';

function ChildrenPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, isLoading, isError, refetch } = useChildren();
  const { data: me } = useMe();

  // In the URL, not in state: a filter that silently hides one of a parent's
  // children is this feature's worst failure, and a URL resets on a fresh
  // visit, survives the back button, and is visible in a support screenshot.
  // `?filter=` on /inbox is the in-repo precedent.
  const schoolFilter = parseSchoolFilter(searchParams.get('school'), me?.schools ?? []);

  function setSchoolFilter(next: SchoolFilter) {
    const params = new URLSearchParams(searchParams.toString());
    const value = serializeSchoolFilter(next);
    if (value === null) params.delete('school');
    else params.set('school', value);
    const query = params.toString();
    // `replace`, so filtering does not bury the previous screen under a stack
    // of back-button steps through each chip the parent tried.
    router.replace(query ? `/children?${query}` : '/children');
  }

  // Client-side over the already-fetched list: instant, network-free, and
  // correct before the backend accepts ?school= at all.
  const visibleChildren = useMemo(() => {
    const all = data?.data ?? [];
    return all.filter((child) => matchesSchoolFilter(schoolFilter, child.semel));
  }, [data?.data, schoolFilter]);

  return (
    <AppShell>
      <div className="page-shell space-y-5">
        <header className="page-header">
          <h1 className="page-title">ילדים</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <RefreshButton />
          </div>
        </header>

        <SchoolFilterChips value={schoolFilter} onChange={setSchoolFilter} />

        {isLoading && <LoadingState message="טוען ילדים..." />}
        {isError && <ErrorState onRetry={() => void refetch()} />}
        {!isLoading && !isError && data && (
          data.data.length === 0 ? (
            <EmptyState
              icon={<Users className="w-10 h-10" />}
              title="אין ילדים"
              subtitle="לא נמצאו ילדים מחוברים לחשבון"
            />
          ) : visibleChildren.length === 0 ? (
            // A distinct state from "no children at all". Told the generic
            // message, a parent concludes the school is broken rather than
            // that they are looking through a filter.
            <div data-testid="children-page" className="space-y-3">
              <EmptyState
                icon={<Users className="w-10 h-10" />}
                title="אין ילדים בבית הספר הזה"
                subtitle="אפשר להציג את כל הילדים מכל בתי הספר"
              />
              <button
                type="button"
                data-testid="school-filter-reset-btn"
                onClick={() => setSchoolFilter(ALL_SCHOOLS)}
                className="mx-auto block text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
              >
                הצג הכל
              </button>
            </div>
          ) : (
            <div data-testid="children-page" className="grid gap-3 md:grid-cols-2">
              {visibleChildren.map((child) => (
                <ChildCard key={child.studentGuid} child={child} />
              ))}
            </div>
          )
        )}
      </div>
    </AppShell>
  );
}

/**
 * `useSearchParams` reads the school filter, and Next refuses to statically
 * prerender a page that calls it without a boundary. The same wrapper /inbox
 * already uses, for the same reason.
 */
export default function ChildrenPage() {
  return (
    <Suspense
      fallback={(
        <AppShell>
          <div className="page-shell space-y-5">
            <LoadingState message="טוען ילדים..." />
          </div>
        </AppShell>
      )}
    >
      <ChildrenPageContent />
    </Suspense>
  );
}
