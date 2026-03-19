'use client';

import React, { useState } from 'react';
import { BookOpen, AlertTriangle, ThumbsUp, Clock, DoorOpen } from 'lucide-react';
import type { ChildStudent, ChildSummary } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/Select';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { ReleasesDialog } from './ReleasesDialog';

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
  studentGuid: string;
}

export function ChildHeader({
  student,
  summary,
  lastSyncAt,
  childOptions,
  selectedChildGuid,
  onChildChange,
  studentGuid,
}: ChildHeaderProps) {
  const [isReleasesDialogOpen, setIsReleasesDialogOpen] = useState(false);

  return (
    <header className="card-base px-4 py-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight text-foreground leading-tight">
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
                className="tap-target h-auto w-auto max-w-xs border-transparent bg-transparent px-0 text-inherit shadow-none hover:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 gap-2 items-center font-inherit"
              >
                <span>{student.fullName}</span>
              </SelectTrigger>
              <SelectContent align="start" className="max-h-72">
                <div className="space-y-1">
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
                </div>
              </SelectContent>
            </Select>
          </h1>
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
          <button
            type="button"
            data-testid="child-header-releases-button"
            onClick={() => setIsReleasesDialogOpen(true)}
            aria-label="בקשות שחרור"
            className="icon-button"
          >
            <DoorOpen className="h-5 w-5" />
          </button>
          <ThemeToggle />
          <RefreshButton />
        </div>
      </div>
      <div className="flex flex-wrap gap-2.5">
        <span
          data-testid="child-header-homework-count"
          className="chip border-info/35 bg-info-subtle text-info"
        >
          <BookOpen className="w-3.5 h-3.5" />
          {summary.recentHomeworkCount} שיעורי בית
        </span>
        <span
          data-testid="child-header-negative-count"
          className="chip border-attention/35 bg-attention-subtle text-attention"
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          {summary.recentBehaviorCount} אירועים שליליים
        </span>
        <span
          data-testid="child-header-positive-count"
          className="chip border-positive/35 bg-positive-subtle text-positive"
        >
          <ThumbsUp className="w-3.5 h-3.5" />
          {summary.positiveBehaviorCount} אירועים חיוביים
        </span>
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
      <ReleasesDialog
        open={isReleasesDialogOpen}
        onOpenChange={setIsReleasesDialogOpen}
        studentGuid={studentGuid}
      />
    </header>
  );
}
