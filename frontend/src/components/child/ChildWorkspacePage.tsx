'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, BookOpen, Bell, GraduationCap, CalendarDays } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ChildHeader, type ChildHeaderOption } from '@/components/child/ChildHeader';
import { HomeworkSection } from '@/components/child/HomeworkSection';
import { BehaviorSection } from '@/components/child/BehaviorSection';
import { SubjectsSection } from '@/components/child/SubjectsSection';
import { NoticesSection } from '@/components/child/NoticesSection';
import { TimetableSection } from '@/components/child/TimetableSection';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useChild } from '@/hooks/useChild';
import { useChildren } from '@/hooks/useChildren';
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setSelectedChildGuid } = useSelectedChild();
  const { data: childrenData } = useChildren();
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

  const handleChildChange = (nextStudentGuid: string) => {
    if (!nextStudentGuid || nextStudentGuid === studentGuid) return;
    setSelectedChildGuid(nextStudentGuid);

    const href = buildChildSectionHref(nextStudentGuid, activeSection, {
      behavior: activeBehaviorFilter,
    });
    if (!href) return;
    router.push(href);
  };

  const childOptions = useMemo<ChildHeaderOption[]>(() => {
    const optionsByGuid = new Map<string, ChildHeaderOption>();
    for (const child of childrenData?.data ?? []) {
      optionsByGuid.set(child.studentGuid, {
        studentGuid: child.studentGuid,
        fullName: child.fullName,
        isActive: child.isActive,
        schoolId: child.schoolId,
        schoolShortLabel: child.schoolShortLabel,
      });
    }

    if (data?.student.studentGuid) {
      // The workspace response carries no school, so the list's entry is kept
      // when there is one: overwriting it would drop the label and un-group
      // the selector for the child currently open.
      const existing = optionsByGuid.get(data.student.studentGuid);
      optionsByGuid.set(data.student.studentGuid, {
        studentGuid: data.student.studentGuid,
        fullName: data.student.fullName,
        isActive: data.student.isActive,
        schoolId: existing?.schoolId ?? null,
        schoolShortLabel: existing?.schoolShortLabel ?? null,
      });
    }

    return Array.from(optionsByGuid.values());
  }, [childrenData?.data, data?.student]);

  const summary = data?.summary ?? {
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    positiveBehaviorCount: 0,
    subjectCount: 0,
    totalWeeklyHours: 0,
    attentionBehaviorCount: 0,
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
      <div data-testid="child-workspace" className="page-shell space-y-4 pb-6">
        <ChildHeader
          student={data.student}
          summary={summary}
          lastSyncAt={data.lastSyncAt}
          childOptions={childOptions}
          selectedChildGuid={data.student.studentGuid}
          onChildChange={handleChildChange}
          studentGuid={data.student.studentGuid}
        />

        <div className="sticky top-2 z-10 rounded-2xl border border-border/80 bg-background/85 backdrop-blur">
          <div className="flex gap-2 overflow-x-auto px-3 py-2.5 scrollbar-hide">
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
    </AppShell>
  );
}
