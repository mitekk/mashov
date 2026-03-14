import React from 'react';
import { BookOpen, AlertTriangle, Clock } from 'lucide-react';
import type { ChildStudent, ChildSummary } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

export interface ChildHeaderOption {
  studentGuid: string;
  fullName: string;
  isActive: boolean;
}

interface ChildHeaderProps {
  student: ChildStudent;
  summary: ChildSummary;
  lastSyncAt: string | null;
  childOptions: ChildHeaderOption[];
  selectedChildGuid: string;
  onChildChange: (studentGuid: string) => void;
}

export function ChildHeader({
  student,
  summary,
  lastSyncAt,
  childOptions,
  selectedChildGuid,
  onChildChange,
}: ChildHeaderProps) {

  return (
    <header className="card-base px-4 py-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {student.fullName}
          </h1>
          <Select
            value={selectedChildGuid}
            onValueChange={onChildChange}
            disabled={childOptions.length === 0}
            dir="rtl"
          >
            <SelectTrigger
              id="child-header-selector"
              aria-label="בחר ילד"
              data-testid="child-header-selector"
              className="tap-target mt-2 h-10 max-w-[16rem] border-border py-1.5 text-sm font-medium"
            >
              <SelectValue placeholder="בחר ילד" className="truncate" />
            </SelectTrigger>
            <SelectContent align="start" className="max-h-72">
              {childOptions.map((child) => (
                <SelectItem
                  key={child.studentGuid}
                  value={child.studentGuid}
                  className="text-base"
                >
                  {child.fullName}
                  {child.isActive ? '' : ' (לא פעיל)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground mt-0.5">
            כיתה {student.classCode}{student.classNum}
          </p>
        </div>
        <div className="flex items-start gap-2">
          {!student.isActive && (
            <span className="mt-1 flex-shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
              לא פעיל
            </span>
          )}
          <ThemeToggle />
        </div>
      </div>
      <div className="flex flex-wrap gap-2.5">
        <span className="chip border-info/35 bg-info-subtle text-info">
          <BookOpen className="w-3.5 h-3.5" />
          {summary.recentHomeworkCount} שיעורי בית
        </span>
        {summary.attentionBehaviorCount > 0 && (
          <span className="chip border-attention/35 bg-attention-subtle text-attention">
            <AlertTriangle className="w-3.5 h-3.5" />
            {summary.attentionBehaviorCount} אירועי תשומת לב
          </span>
        )}
        <span className="chip">
          {summary.subjectCount} מקצועות
        </span>
        <span className="chip border-border/85 bg-muted/70 text-muted-foreground">
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
