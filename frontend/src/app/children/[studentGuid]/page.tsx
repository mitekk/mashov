'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { ChildHeader } from '@/components/child/ChildHeader';
import { HomeworkSection } from '@/components/child/HomeworkSection';
import { BehaviorSection } from '@/components/child/BehaviorSection';
import { SubjectsSection } from '@/components/child/SubjectsSection';
import { NoticesSection } from '@/components/child/NoticesSection';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useChild } from '@/hooks/useChild';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { id: 'homework', label: 'שיעורי בית' },
  { id: 'behavior', label: 'התנהגות' },
  { id: 'subjects', label: 'מקצועות' },
  { id: 'notices', label: 'הודעות' },
] as const;

type SectionId = typeof SECTIONS[number]['id'];

export default function ChildWorkspacePage() {
  const params = useParams();
  const studentGuid = params.studentGuid as string;
  const [activeSection, setActiveSection] = useState<SectionId>('homework');

  const { data, isLoading, isError, refetch } = useChild(studentGuid);
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
      <div data-testid="child-workspace" className="pb-4">
        <ChildHeader student={data.student} summary={summary} lastSyncAt={data.lastSyncAt} />

        {/* Section tabs */}
        <div className="sticky top-0 bg-background z-10 border-b border-border">
          <div className="flex overflow-x-auto px-4 gap-1 py-2 scrollbar-hide">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                data-testid={`section-tab-${section.id}`}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  'flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                  activeSection === section.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                )}
              >
                {section.label}
              </button>
            ))}
          </div>
        </div>

        {/* Active section content */}
        <div className="px-4 pt-4">
          {activeSection === 'homework' && <HomeworkSection studentGuid={studentGuid} />}
          {activeSection === 'behavior' && <BehaviorSection studentGuid={studentGuid} />}
          {activeSection === 'subjects' && <SubjectsSection studentGuid={studentGuid} />}
          {activeSection === 'notices' && <NoticesSection studentGuid={studentGuid} />}
        </div>
      </div>
    </AppShell>
  );
}
