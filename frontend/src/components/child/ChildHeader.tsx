'use client';

import React, { useMemo, useState } from 'react';
import { BookOpen, AlertTriangle, ThumbsUp, Info, Clock, DoorOpen, ClipboardList } from 'lucide-react';
import type { ChildStudent, ChildSummary } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { getBucketLabel } from '@/lib/behavior';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/Select';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { useSchoolActivities } from '@/hooks/useChild';
import { ReleasesDialog } from './ReleasesDialog';
import { SchoolActivitiesDialog } from './SchoolActivitiesDialog';

export interface ChildHeaderOption {
  studentGuid: string;
  fullName: string;
  isActive: boolean;
  /** Used to group the list once a household has more than one school. */
  schoolId?: string | null;
  schoolShortLabel?: string | null;
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
  // One group per distinct school, in the order the options arrive, so the
  // grouping is stable between renders.
  const schoolGroups = useMemo(() => {
    const groups: Array<{ key: string; label: string; children: ChildHeaderOption[] }> = [];
    for (const child of childOptions) {
      const key = child.schoolId ?? '__unowned__';
      const existing = groups.find((group) => group.key === key);
      if (existing) existing.children.push(child);
      else
        groups.push({
          key,
          label: child.schoolShortLabel ?? 'בית ספר',
          children: [child],
        });
    }
    return groups;
  }, [childOptions]);

  const selectedSchoolLabel =
    childOptions.find((child) => child.studentGuid === selectedChildGuid)?.schoolShortLabel ??
    null;

  const [isActivitiesDialogOpen, setIsActivitiesDialogOpen] = useState(false);
  const { data: activitiesData } = useSchoolActivities(studentGuid);
  const pendingCount = activitiesData?.filter((activity) => !activity.isAnswered).length ?? 0;

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
                  {/* Grouped only above one distinct school. With one, this is
                      byte-for-byte the flat list it has always been, which is
                      why children.spec.ts needs no change. */}
                  {schoolGroups.length > 1
                    ? schoolGroups.map((group) => (
                        <SelectGroup key={group.key}>
                          <SelectLabel>{group.label}</SelectLabel>
                          {group.children.map((child) => (
                            <SelectItem
                              key={child.studentGuid}
                              value={child.studentGuid}
                              className="text-base"
                            >
                              {child.fullName}
                              {child.isActive ? '' : ' (לא פעיל)'}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))
                    : childOptions.map((child) => (
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
            {/* The school in the subtitle, so a parent moving between children
                always knows whose school they are looking at. Only rendered
                when there is more than one. */}
            {schoolGroups.length > 1 && selectedSchoolLabel && (
              <>
                {' · '}
                <span data-testid="child-header-school-label">{selectedSchoolLabel}</span>
              </>
            )}
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
          <div className="relative">
            <button
              type="button"
              data-testid="child-header-activities-button"
              onClick={() => setIsActivitiesDialogOpen(true)}
              aria-label={`פעילויות בית ספר${pendingCount > 0 ? ` (${pendingCount} ממתינות)` : ''}`}
              className="icon-button"
            >
              <ClipboardList className="h-5 w-5" />
            </button>
            {pendingCount > 0 && (
              <span
                data-testid="child-header-activities-badge"
                aria-hidden="true"
                className="absolute -start-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-attention text-3xs font-bold text-attention-foreground"
              >
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            )}
          </div>
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
        {/* Same wording as the behaviour filter tabs, so a chip and the tab
            it summarises name the same bucket. */}
        <span
          data-testid="child-header-negative-count"
          className="chip border-attention/35 bg-attention-subtle text-attention"
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          {summary.recentBehaviorCount} {getBucketLabel('attention')}
        </span>
        <span
          data-testid="child-header-positive-count"
          className="chip border-positive/35 bg-positive-subtle text-positive"
        >
          <ThumbsUp className="w-3.5 h-3.5" />
          {summary.positiveBehaviorCount} אירועים חיוביים
        </span>
        {/* Attendance logged by the school. Muted, and counted on its own:
            folded into the amber chip it read as a negative event. */}
        <span
          data-testid="child-header-neutral-count"
          className="chip border-border/85 bg-muted/70 text-muted-foreground"
        >
          <Info className="w-3.5 h-3.5" />
          {summary.neutralBehaviorCount} {getBucketLabel('neutral')}
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
      <SchoolActivitiesDialog
        open={isActivitiesDialogOpen}
        onOpenChange={setIsActivitiesDialogOpen}
        studentGuid={studentGuid}
      />
    </header>
  );
}
