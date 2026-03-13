import React from 'react';
import { BookOpen, AlertTriangle, Clock } from 'lucide-react';
import type { ChildStudent, ChildSummary } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';

interface ChildHeaderProps {
  student: ChildStudent;
  summary: ChildSummary;
  lastSyncAt: string | null;
}

export function ChildHeader({ student, summary, lastSyncAt }: ChildHeaderProps) {

  return (
    <header className="px-4 py-5 border-b border-border bg-gradient-to-b from-card to-background/70">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">{student.fullName}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            כיתה {student.classCode}{student.classNum}
          </p>
        </div>
        {!student.isActive && (
          <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full flex-shrink-0 mt-1">
            לא פעיל
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="chip bg-blue-50 text-blue-700 border border-blue-200 shadow-sm">
          <BookOpen className="w-3.5 h-3.5" />
          {summary.recentHomeworkCount} שיעורי בית
        </span>
        {summary.attentionBehaviorCount > 0 && (
          <span className="chip bg-amber-50 text-amber-700 border border-amber-200 shadow-sm">
            <AlertTriangle className="w-3.5 h-3.5" />
            {summary.attentionBehaviorCount} אירועי תשומת לב
          </span>
        )}
        <span className="chip bg-secondary text-secondary-foreground border border-border shadow-sm">
          {summary.subjectCount} מקצועות
        </span>
        <span className="chip bg-slate-100 text-slate-700 border border-slate-200 shadow-sm">
          {summary.totalWeeklyHours} שעות שבועיות
        </span>
      </div>
      {lastSyncAt && (
        <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          סונכרן {formatRelativeHe(lastSyncAt)}
        </p>
      )}
    </header>
  );
}
