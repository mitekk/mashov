'use client';

import React from 'react';
import Link from 'next/link';
import { BookOpen, AlertTriangle } from 'lucide-react';
import type { DashboardChildCard } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import { buildChildSectionHref } from '@/lib/child-routes';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import { cn } from '@/lib/utils';

interface ChildQuickCardProps {
  child: DashboardChildCard;
}

export function ChildQuickCard({ child }: ChildQuickCardProps) {
  const { setSelectedChildGuid } = useSelectedChild();
  const safeHref = getPhase1HrefOrNull(
    buildChildSectionHref(child.studentGuid, 'homework'),
  );

  const content = (
    <>
      <div>
        <p className="text-sm font-semibold text-foreground truncate">
          {child.fullName}
        </p>
        <p className="text-xs text-muted-foreground">
          כיתה {child.classCode}{child.classNum}
        </p>
      </div>
      <div className="flex gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <BookOpen className="w-3 h-3" />
          {child.recentHomeworkCount}
        </span>
        <span
          className={cn(
            'flex items-center gap-1',
            child.recentBehaviorCount > 0 ? 'text-attention' : 'text-muted-foreground',
          )}
        >
          <AlertTriangle className="w-3 h-3" />
          {child.recentBehaviorCount}
        </span>
      </div>
      {child.oneLineStatus && (
        <p className="text-xs text-muted-foreground line-clamp-1">
          {child.oneLineStatus}
        </p>
      )}
      {child.latestUpdateAt && (
        <p className="text-[10px] text-muted-foreground opacity-60">
          {formatRelativeHe(child.latestUpdateAt)}
        </p>
      )}
      {!safeHref && (
        <p className="text-[11px] text-muted-foreground mt-1">
          קישור זה אינו זמין בשלב 1
        </p>
      )}
    </>
  );

  const className = 'card-base tap-target flex min-w-[176px] flex-shrink-0 flex-col gap-2.5 border-border p-4 transition-colors';

  if (!safeHref) {
    return (
      <div
        data-testid={`child-card-disabled-${child.studentGuid}`}
        aria-disabled
        className={`${className} opacity-70 cursor-not-allowed`}
      >
        {content}
      </div>
    );
  }

  return (
    <Link
      href={safeHref}
      onClick={() => setSelectedChildGuid(child.studentGuid)}
      data-testid={`child-card-${child.studentGuid}`}
      className={cn(className, 'hover:bg-accent/40')}
    >
      {content}
    </Link>
  );
}
