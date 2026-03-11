import React from 'react';
import Link from 'next/link';
import { BookOpen, AlertTriangle, ChevronLeft } from 'lucide-react';
import type { ChildListItem } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';

interface ChildCardProps {
  child: ChildListItem;
}

export function ChildCard({ child }: ChildCardProps) {
  return (
    <Link
      href={`/children/${child.studentGuid}`}
      data-testid={`child-list-card-${child.studentGuid}`}
      className="card-base p-4 flex items-center gap-3 tap-target hover:bg-accent/30 transition-colors"
    >
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
          <span className="flex items-center gap-1">
            <BookOpen className="w-3.5 h-3.5" />
            {child.recentHomeworkCount} שיעורי בית
          </span>
          {child.recentBehaviorCount > 0 && (
            <span className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="w-3.5 h-3.5" />
              {child.recentBehaviorCount} אירועים
            </span>
          )}
        </div>
        {child.latestUpdateAt && (
          <p className="text-xs text-muted-foreground mt-1 opacity-60">
            עודכן {formatRelativeHe(child.latestUpdateAt)}
          </p>
        )}
      </div>
      <ChevronLeft className="w-4 h-4 text-muted-foreground flex-shrink-0" />
    </Link>
  );
}
