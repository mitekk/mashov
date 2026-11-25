'use client';

import React from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { ChildListItem } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import { buildChildSectionHref } from '@/lib/child-routes';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import { cn } from '@/lib/utils';
import { SchoolBadge } from '@/components/school/SchoolBadge';
import { ChildStatChips } from '@/components/children/ChildStatChips';

interface ChildCardProps {
  child: ChildListItem;
}

export function ChildCard({ child }: ChildCardProps) {
  const { setSelectedChildGuid } = useSelectedChild();
  const safeHref = getPhase1HrefOrNull(
    buildChildSectionHref(child.studentGuid, 'homework'),
  );

  const positiveBehaviorCount = child.positiveBehaviorCount ?? 0;
  const neutralBehaviorCount = child.neutralBehaviorCount ?? 0;

  const content = (
    <>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-base font-semibold text-foreground truncate">
            {child.fullName}
          </p>
          {!child.isActive && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full flex-shrink-0">
              לא פעיל
            </span>
          )}
          {/* Self-hiding below two schools, so a one-school card is unchanged. */}
          <SchoolBadge
            schoolShortLabel={child.schoolShortLabel}
            schoolName={child.schoolName}
            testId={`child-list-school-${child.studentGuid}`}
            className="flex-shrink-0"
          />
        </div>
        <p
          data-testid={`child-list-class-${child.studentGuid}`}
          className="text-sm text-muted-foreground mb-2"
        >
          כיתה {child.classCode}{child.classNum}
        </p>
        {/* Wraps between pills, never inside a label -- see ChildStatChips. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ChildStatChips
            testIdPrefix="child-list"
            studentGuid={child.studentGuid}
            homeworkCount={child.recentHomeworkCount}
            attentionCount={child.recentBehaviorCount}
            positiveCount={positiveBehaviorCount}
            neutralCount={neutralBehaviorCount}
          />
        </div>
        {child.latestUpdateAt && (
          <p className="text-xs text-muted-foreground mt-2 opacity-70">
            עודכן {formatRelativeHe(child.latestUpdateAt)}
          </p>
        )}
        {!safeHref && (
          <p className="text-2xs text-muted-foreground mt-1">
            קישור זה אינו זמין בשלב 1
          </p>
        )}
      </div>
      <ChevronLeft className="w-4 h-4 text-muted-foreground flex-shrink-0" />
    </>
  );

  const className = 'card-base tap-target flex items-center gap-3 border-border p-4 transition-colors';

  if (!safeHref) {
    return (
      <div
        data-testid={`child-list-card-disabled-${child.studentGuid}`}
        aria-disabled
        className={cn(className, 'opacity-70 cursor-not-allowed')}
      >
        {content}
      </div>
    );
  }

  return (
    <Link
      href={safeHref}
      onClick={() => setSelectedChildGuid(child.studentGuid)}
      data-testid={`child-list-card-${child.studentGuid}`}
      className={cn(className, 'hover:bg-accent/40')}
    >
      {content}
    </Link>
  );
}
