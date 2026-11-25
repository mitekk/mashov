'use client';

import React, { useMemo, useState } from 'react';
import { BookOpen, AlertTriangle, ThumbsUp, Info, Clock, DoorOpen, ClipboardList } from 'lucide-react';
import type { ChildStudent, ChildSummary } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { getBucketLabel } from '@/lib/behavior';
import { useSchoolActivities } from '@/hooks/useChild';
import { useChildren } from '@/hooks/useChildren';
import { groupOptionsBySchool } from './ChildSelect';
import { ReleasesDialog } from './ReleasesDialog';
import { SchoolActivitiesDialog } from './SchoolActivitiesDialog';

export type { ChildHeaderOption } from './ChildSelect';

interface ChildHeaderProps {
  student: ChildStudent;
  summary: ChildSummary;
  lastSyncAt: string | null;
  studentGuid: string;
}

/**
 * The child workspace's hero card: class, school, the six summary chips, the
 * two dialog buttons and the sync line.
 *
 * The name and the child switcher used to lead this card. They are the app
 * header's now -- the header already reads ילדים on this route, and the card
 * repeating the identity directly under it was two header bands stacked. The
 * identity block therefore leads with the class.
 */
export function ChildHeader({
  student,
  summary,
  lastSyncAt,
  studentGuid,
}: ChildHeaderProps) {
  const [isReleasesDialogOpen, setIsReleasesDialogOpen] = useState(false);

  // Read here rather than threaded in: the only thing this card still needs
  // from the household list is whether there is more than one school, and
  // which one this child attends.
  const { data: childrenData } = useChildren();
  const schoolGroups = useMemo(
    () => groupOptionsBySchool(childrenData?.data ?? []),
    [childrenData?.data],
  );
  const selectedSchoolLabel =
    (childrenData?.data ?? []).find((child) => child.studentGuid === studentGuid)
      ?.schoolShortLabel ?? null;

  const [isActivitiesDialogOpen, setIsActivitiesDialogOpen] = useState(false);
  const { data: activitiesData } = useSchoolActivities(studentGuid);
  const pendingCount = activitiesData?.filter((activity) => !activity.isAnswered).length ?? 0;

  return (
    <header className="card-base px-4 py-5">
      {/*
        Defect 12, the 360px overflow: this row held a 20rem child select next
        to four 40px icon buttons inside `card-base px-4` -- about 296px of
        usable width for roughly 480px of content, on a single non-wrapping
        line. The select is the app header's now, and the row still wraps and
        still lets the identity block shrink, which is what keeps the two
        dialog buttons on the line at 360.
      */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div data-testid="child-header-identity" className="min-w-0 flex-1">
          {/* The visible name, and the switcher that changes it, are the
              app header's. This stays as the document's h1 -- the page needs
              one heading, and the header's title is `aria-hidden` because it
              goes `inert` at the end of the scroll fade. */}
          <h1 className="sr-only">{student.fullName}</h1>
          <p className="m-0 text-lg font-semibold tracking-tight text-foreground leading-tight">
            כיתה {student.classCode}{student.classNum}
          </p>
          {/* The school, so a parent moving between children always knows
              whose school they are looking at. Only rendered when there is
              more than one. */}
          {schoolGroups.length > 1 && selectedSchoolLabel && (
            <p
              data-testid="child-header-school-label"
              className="mt-0.5 text-sm text-muted-foreground"
            >
              {selectedSchoolLabel}
            </p>
          )}
        </div>
        <div
          data-testid="child-header-actions"
          className="flex flex-wrap items-start justify-end gap-2"
        >
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
