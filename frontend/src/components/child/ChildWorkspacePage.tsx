'use client';

import React, { useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, BookOpen, Bell, GraduationCap } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ChildHeader, type ChildHeaderOption } from '@/components/child/ChildHeader';
import { HomeworkSection } from '@/components/child/HomeworkSection';
import { BehaviorSection } from '@/components/child/BehaviorSection';
import { SubjectsSection } from '@/components/child/SubjectsSection';
import { NoticesSection } from '@/components/child/NoticesSection';
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

interface ChildWorkspacePageProps {
  studentGuid: string;
}

const SECTIONS: Array<{ id: ChildSectionId; label: string; icon: React.ReactNode }> = [
  { id: 'homework', label: 'שיעורי בית', icon: <BookOpen className="w-3.5 h-3.5" /> },
  { id: 'behavior', label: 'התנהגות', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  { id: 'subjects', label: 'מקצועות', icon: <GraduationCap className="w-3.5 h-3.5" /> },
  { id: 'notices', label: 'הודעות', icon: <Bell className="w-3.5 h-3.5" /> },
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
      });
    }

    if (data?.student.studentGuid) {
      optionsByGuid.set(data.student.studentGuid, {
        studentGuid: data.student.studentGuid,
        fullName: data.student.fullName,
        isActive: data.student.isActive,
      });
    }

    return Array.from(optionsByGuid.values());
  }, [childrenData?.data, data?.student]);

  const summary = data?.summary ?? {
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    subjectCount: 0,
    totalWeeklyHours: 0,
    attentionBehaviorCount: 0,
  };

  if (isLoading) return <AppShell><LoadingState message="טוען נתוני ילד..." /></AppShell>;
  if (isError || !data) return <AppShell><ErrorState onRetry={() => void refetch()} /></AppShell>;

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

        {activeSection === 'homework' && <HomeworkSection studentGuid={studentGuid} />}
        {activeSection === 'behavior' && (
          <BehaviorSection
            studentGuid={studentGuid}
            activeFilter={activeBehaviorFilter}
            onFilterChange={handleBehaviorFilterChange}
          />
        )}
        {activeSection === 'subjects' && <SubjectsSection studentGuid={studentGuid} />}
        {activeSection === 'notices' && <NoticesSection studentGuid={studentGuid} />}
      </div>
    </AppShell>
  );
}
