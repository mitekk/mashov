import React from 'react';
import Link from 'next/link';
import { BookOpen, AlertTriangle } from 'lucide-react';
import type { DashboardChildCard } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';

interface ChildQuickCardProps {
  child: DashboardChildCard;
}

export function ChildQuickCard({ child }: ChildQuickCardProps) {
  const safeHref = getPhase1HrefOrNull(
    child.studentGuid ? `/children/${child.studentGuid}` : null,
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

  const className =
    'card-base p-4 flex flex-col gap-2 tap-target transition-colors min-w-[160px] flex-shrink-0';

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
      data-testid={`child-card-${child.studentGuid}`}
      className={`${className} hover:bg-accent/30`}
    >
      {content}
    </Link>
  );
}
