'use client';

import React, { useEffect, useMemo } from 'react';
import Link from 'next/link';
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

  const handleBehaviorFilterChange = (nextFilter: ChildBehaviorFilter) => {
    const href = buildChildSectionHref(studentGuid, 'behavior', { behavior: nextFilter });
    if (!href) return;
    router.replace(href);
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
      <div data-testid="child-workspace" className="pb-6">
        <ChildHeader
          student={data.student}
          summary={summary}
          lastSyncAt={data.lastSyncAt}
          childOptions={childOptions}
          selectedChildGuid={data.student.studentGuid}
          onChildChange={handleChildChange}
        />

        <div className="sticky top-0 z-10 mt-4 border-y border-border bg-background/95 backdrop-blur">
          <div className="flex overflow-x-auto px-4 gap-2 py-2.5 scrollbar-hide">
            {SECTIONS.map((section) => {
              const href = buildChildSectionHref(studentGuid, section.id, {
                behavior: activeBehaviorFilter,
              });
              if (!href) return null;

              return (
                <Link
                  key={section.id}
                  href={href}
                  data-testid={`section-tab-${section.id}`}
                  aria-current={activeSection === section.id ? 'page' : undefined}
                  className={cn(
                    'tap-target flex-shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                    'inline-flex items-center gap-1.5',
                    activeSection === section.id
                      ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                      : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {section.icon}
                  {section.label}
                </Link>
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
