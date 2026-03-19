'use client';

import React from 'react';
import Link from 'next/link';
import { BookOpen, AlertTriangle, ThumbsUp, ChevronLeft } from 'lucide-react';
import type { ChildListItem } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import { buildChildSectionHref } from '@/lib/child-routes';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import { cn } from '@/lib/utils';

interface ChildCardProps {
  child: ChildListItem;
}

export function ChildCard({ child }: ChildCardProps) {
  const { setSelectedChildGuid } = useSelectedChild();
  const safeHref = getPhase1HrefOrNull(
    buildChildSectionHref(child.studentGuid, 'homework'),
  );

  const positiveBehaviorCount = child.positiveBehaviorCount ?? 0;

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
        </div>
        <p className="text-sm text-muted-foreground mb-2">
          כיתה {child.classCode}{child.classNum}
        </p>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span
            data-testid={`child-list-homework-count-${child.studentGuid}`}
            className="flex items-center gap-1"
          >
            <BookOpen className="w-3.5 h-3.5" />
            {child.recentHomeworkCount} שיעורי בית
          </span>
          <span
            data-testid={`child-list-negative-count-${child.studentGuid}`}
            className={cn(
              'flex items-center gap-1',
              child.recentBehaviorCount > 0 ? 'text-attention' : 'text-muted-foreground',
            )}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            {child.recentBehaviorCount} אירועים
          </span>
          <span
            data-testid={`child-list-positive-count-${child.studentGuid}`}
            className={cn(
              'flex items-center gap-1',
              positiveBehaviorCount > 0 ? 'text-positive' : 'text-muted-foreground',
            )}
          >
            <ThumbsUp className="w-3.5 h-3.5" />
            {positiveBehaviorCount} חיוביים
          </span>
        </div>
        {child.latestUpdateAt && (
          <p className="text-xs text-muted-foreground mt-1 opacity-60">
            עודכן {formatRelativeHe(child.latestUpdateAt)}
          </p>
        )}
        {!safeHref && (
          <p className="text-[11px] text-muted-foreground mt-1">
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
