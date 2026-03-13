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
  isSelected?: boolean;
}

export function ChildQuickCard({ child, isSelected = false }: ChildQuickCardProps) {
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
        {child.recentBehaviorCount > 0 && (
          <span className="flex items-center gap-1 text-amber-600">
            <AlertTriangle className="w-3 h-3" />
            {child.recentBehaviorCount}
          </span>
        )}
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

  const className = cn(
    'card-base p-4 flex flex-col gap-2 tap-target transition-colors min-w-[160px] flex-shrink-0',
    isSelected
      ? 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]'
      : 'border-border',
  );

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
      className={cn(className, 'hover:bg-accent/30')}
    >
      {content}
    </Link>
  );
}
