'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, BookOpen, Bell, GraduationCap, CalendarDays } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ChildHeader } from '@/components/child/ChildHeader';
import { HomeworkSection } from '@/components/child/HomeworkSection';
import { BehaviorSection } from '@/components/child/BehaviorSection';
import { SubjectsSection } from '@/components/child/SubjectsSection';
import { NoticesSection } from '@/components/child/NoticesSection';
import { TimetableSection } from '@/components/child/TimetableSection';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useChild } from '@/hooks/useChild';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import {
  buildChildSectionHref,
  parseChildBehaviorFilter,
  parseChildSection,
  type ChildSectionId,
  type ChildBehaviorFilter,
} from '@/lib/child-routes';
import { cn } from '@/lib/utils';
import Link from 'next/link';

interface ChildWorkspacePageProps {
  studentGuid: string;
}

const SECTIONS: Array<{ id: ChildSectionId; label: string; icon: React.ReactNode }> = [
  { id: 'homework', label: 'שיעורי בית', icon: <BookOpen className="w-3.5 h-3.5" /> },
  { id: 'behavior', label: 'התנהגות', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  { id: 'subjects', label: 'מקצועות', icon: <GraduationCap className="w-3.5 h-3.5" /> },
  { id: 'notices', label: 'הודעות', icon: <Bell className="w-3.5 h-3.5" /> },
  { id: 'timetable', label: 'לוח שיעורים', icon: <CalendarDays className="w-3.5 h-3.5" /> },
];

export function ChildWorkspacePage({
  studentGuid,
}: ChildWorkspacePageProps) {
  const searchParams = useSearchParams();
  const { setSelectedChildGuid } = useSelectedChild();
  const { data, isLoading, isError, refetch } = useChild(studentGuid);
  const activeSection = parseChildSection(searchParams.get('section'));
  const activeBehaviorFilter = parseChildBehaviorFilter(searchParams.get('behavior'));
  const [behaviorStatusFilter, setBehaviorStatusFilter] = useState<'new' | 'archived' | 'all'>('new');

  useEffect(() => {
    setSelectedChildGuid(studentGuid);
  }, [studentGuid, setSelectedChildGuid]);

  const updateWorkspaceQuery = useCallback((
    section: ChildSectionId,
    behavior: ChildBehaviorFilter,
    mode: 'push' | 'replace',
  ) => {
    if (typeof window === 'undefined') return;
    const href = buildChildSectionHref(studentGuid, section, { behavior });
    if (!href) return;

    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (currentHref === href) return;

    if (mode === 'replace') {
      window.history.replaceState(null, '', href);
      return;
    }

    window.history.pushState(null, '', href);
  }, [studentGuid]);

  const handleBehaviorFilterChange = (nextFilter: ChildBehaviorFilter) => {
    updateWorkspaceQuery('behavior', nextFilter, 'replace');
  };

  const handleSectionChange = (nextSection: ChildSectionId) => {
    updateWorkspaceQuery(nextSection, activeBehaviorFilter, 'push');
  };

  const summary = data?.summary ?? {
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    positiveBehaviorCount: 0,
    neutralBehaviorCount: 0,
    subjectCount: 0,
    totalWeeklyHours: 0,
  };

  if (isLoading) return <AppShell><LoadingState message="טוען נתוני ילד..." /></AppShell>;
  // A route out, not just a retry. The common way to land here is a child
  // whose school was just unlinked: the guid in the URL now 404s, and retrying
  // will never succeed, so a retry button alone is a dead end.
  if (isError || !data) {
    return (
      <AppShell>
        <div className="space-y-3">
          <ErrorState onRetry={() => void refetch()} />
          <Link
            href="/children"
            data-testid="child-workspace-back-to-children"
            className="mx-auto block text-center text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
          >
            חזרה לילדים
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      {/*
        One shell, three shapes, all by CSS: a stacked column on a phone, the
        same column with a wrapping tab row at md, and a two-column grid at lg
        where the tabs are a vertical sidebar and the header spans both.

        There is no second set of tab buttons for the sidebar: a `section-tab-*`
        testid rendered twice resolves twice under Playwright's strict mode even
        when one copy is display:none, and a `useMediaQuery` switch would let SSR
        pick one arm and the client flip it.
      */}
      <div
        data-testid="child-workspace"
        className={cn(
          // `.page-shell` has no top padding by design -- every other
          // page takes its own from `.page-header`'s `pt-5`, which this one
          // does not use, so without this the hero card butts into the
          // sticky header.
          'page-shell space-y-4 pb-6 pt-5 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0',
          // The week grid is the one surface here that reads better wider: at
          // 1280 the extra 8rem takes its columns from ~150px to ~190px. Driven
          // by the section in the URL, not by a media query, so SSR and the
          // client agree.
          activeSection === 'timetable' && 'page-shell-wide',
        )}
      >
        <div className="lg:col-span-2">
          <ChildHeader
            student={data.student}
            summary={summary}
            lastSyncAt={data.lastSyncAt}
            studentGuid={data.student.studentGuid}
          />
        </div>

        {/* `.sticky-under-header` instead of a `top-*` utility: it tracks the
            app header, sitting below it while it is on screen and riding up
            into its place as it fades, ending where `top-2` used to put it.
            Tailwind's `top-*` lives in @layer utilities and would win over it,
            so the two cannot be combined. */}
        <div className="sticky-under-header sticky z-10 rounded-2xl border border-border/80 bg-background/85 backdrop-blur lg:self-start">
          <div className="rail px-3 py-2.5 md:flex-wrap md:overflow-visible lg:flex-col lg:items-stretch">
            {SECTIONS.map((section) => {
              return (
                <button
                  key={section.id}
                  type="button"
                  data-testid={`section-tab-${section.id}`}
                  onClick={() => handleSectionChange(section.id)}
                  aria-current={activeSection === section.id ? 'page' : undefined}
                  aria-pressed={activeSection === section.id}
                  className={cn(
                    'tap-target inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
                    // Centred as a chip in a row, start-aligned as a row in a
                    // sidebar. On the button, not the container: it is a
                    // utility either way, so there is no layer fight.
                    'justify-center lg:w-full lg:justify-start',
                    activeSection === section.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border/80 bg-card/90 text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {section.icon}
                  {section.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          {activeSection === 'homework' && (
            <HomeworkSection
              studentGuid={studentGuid}
            />
          )}
          {activeSection === 'behavior' && (
            <BehaviorSection
              studentGuid={studentGuid}
              activeFilter={activeBehaviorFilter}
              onFilterChange={handleBehaviorFilterChange}
              statusFilter={behaviorStatusFilter}
              onStatusFilterChange={setBehaviorStatusFilter}
            />
          )}
          {activeSection === 'subjects' && <SubjectsSection studentGuid={studentGuid} />}
          {activeSection === 'notices' && <NoticesSection studentGuid={studentGuid} />}
          {activeSection === 'timetable' && <TimetableSection studentGuid={studentGuid} />}
        </div>
      </div>
    </AppShell>
  );
}
