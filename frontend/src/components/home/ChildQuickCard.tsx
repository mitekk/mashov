import React from 'react';
import Link from 'next/link';
import { BookOpen, AlertTriangle } from 'lucide-react';
import type { DashboardChildCard } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';

interface ChildQuickCardProps {
  child: DashboardChildCard;
}

export function ChildQuickCard({ child }: ChildQuickCardProps) {
  return (
    <Link
      href={`/children/${child.studentGuid}`}
      data-testid={`child-card-${child.studentGuid}`}
      className="card-base p-4 flex flex-col gap-2 tap-target hover:bg-accent/30 transition-colors min-w-[160px] flex-shrink-0"
    >
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
    </Link>
  );
}
