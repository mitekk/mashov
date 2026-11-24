'use client';

import React, { useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  CalendarDays,
  CalendarX,
  ClipboardList,
  Music,
  Sprout,
  TreePine,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useSchoolActivities } from '@/hooks/useChild';
import type { SchoolActivity } from '@/types/api';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { RichTextContent } from '@/components/ui/RichTextContent';
import { formatShortDate } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface SchoolActivitiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentGuid: string;
}

export interface SchoolActivityCardProps {
  activity: SchoolActivity;
  onAction?: (action: string, activity: SchoolActivity) => void;
}

const ACTIVITY_TYPE_LABEL: Record<number, string> = {
  1: 'טיול שדה',
  2: 'חווה חקלאית',
  4: 'הצגה / מופע',
};

const ACTIVITY_TYPE_ICON: Record<number, LucideIcon> = {
  1: TreePine,
  2: Sprout,
  4: Music,
};

function parseIsoTimestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function formatActivityDateRange(startDate: string, endDate: string): string {
  const start = formatShortDate(startDate);
  const end = formatShortDate(endDate);
  if (!start && !end) return 'תאריך לא זמין';
  if (!start) return end;
  if (!end) return start;
  if (start === end) return start;
  return `${start} - ${end}`;
}

function daysUntil(dateValue: string): number | null {
  const deadlineTimestamp = Date.parse(dateValue);
  if (Number.isNaN(deadlineTimestamp)) return null;
  const oneDayMs = 24 * 60 * 60 * 1000;
  return Math.floor((deadlineTimestamp - Date.now()) / oneDayMs);
}

export function SchoolActivityCard({ activity }: SchoolActivityCardProps) {
  const typeLabel = ACTIVITY_TYPE_LABEL[activity.activityType] ?? 'פעילות בית ספר';
  const TypeIcon = ACTIVITY_TYPE_ICON[activity.activityType] ?? ClipboardList;
  const daysToDeadline = daysUntil(activity.endAnswerDate);
  const isDeadlineNear = !activity.isAnswered && daysToDeadline !== null && daysToDeadline < 7;

  return (
    <article
      data-testid={`school-activity-item-${activity.id}`}
      className={cn(
        'card-base p-4',
        activity.isAnswered
          ? 'border-border/80 bg-card/85'
          : 'border-s-4 border-attention/60 bg-attention-subtle/35',
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="inline-flex items-center gap-1">
          <TypeIcon className="h-3.5 w-3.5" />
          {typeLabel}
        </Badge>
        <Badge variant={activity.isAnswered ? 'positive' : 'attention'}>
          {activity.isAnswered ? 'נענה ✓' : 'ממתין לאישור'}
        </Badge>
      </div>

      <h3 className={cn('text-sm', activity.isAnswered ? 'font-medium text-foreground' : 'font-semibold text-foreground')}>
        {activity.title || 'פעילות ללא כותרת'}
      </h3>

      <div className="mt-2 space-y-1">
        <p className={cn('flex items-center gap-1.5 text-xs', activity.isAnswered ? 'text-muted-foreground' : 'text-foreground')}>
          <CalendarDays className="h-3.5 w-3.5" />
          {formatActivityDateRange(activity.activityStartDate, activity.activityEndDate)}
        </p>

        {!activity.isAnswered && (
          <p className={cn('flex items-center gap-1.5 text-xs', isDeadlineNear ? 'font-semibold text-attention' : 'text-muted-foreground')}>
            <CalendarX className="h-3.5 w-3.5" />
            מועד אחרון למענה: {formatShortDate(activity.endAnswerDate) || 'לא זמין'}
          </p>
        )}
      </div>

      <RichTextContent
        html={activity.description}
        collapsible
        previewLines={2}
        className="mt-3 rounded-xl border border-border/80 bg-background/60 p-2.5"
        previewTestId={`school-activity-preview-${activity.id}`}
        toggleTestId={`school-activity-toggle-${activity.id}`}
        contentTestId={`school-activity-description-${activity.id}`}
      />
    </article>
  );
}

export function SchoolActivitiesDialog({
  open,
  onOpenChange,
  studentGuid,
}: SchoolActivitiesDialogProps) {
  const { data, isLoading, isError, refetch } = useSchoolActivities(open ? studentGuid : '');

  const activities = useMemo(() => {
    const items = data ?? [];
    const pending = items
      .filter((item) => !item.isAnswered)
      .sort((left, right) => {
        const leftDeadline = parseIsoTimestamp(left.endAnswerDate, Number.POSITIVE_INFINITY);
        const rightDeadline = parseIsoTimestamp(right.endAnswerDate, Number.POSITIVE_INFINITY);
        if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
        return left.id - right.id;
      });

    const answered = items
      .filter((item) => item.isAnswered)
      .sort((left, right) => {
        const leftCreated = parseIsoTimestamp(left.createTime, 0);
        const rightCreated = parseIsoTimestamp(right.createTime, 0);
        if (leftCreated !== rightCreated) return rightCreated - leftCreated;
        return right.id - left.id;
      });

    return [...pending, ...answered];
  }, [data]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]" />
        <Dialog.Content
          data-testid="school-activities-dialog"
          lang="he-IL"
          dir="rtl"
          className="dialog-panel fixed inset-x-4 top-12 z-50 mx-auto w-full max-w-2xl rounded-2xl border border-border bg-background p-4 shadow-xl sm:inset-x-0"
        >
          <div className="mb-4 flex items-start justify-between gap-2">
            <Dialog.Title className="text-lg font-semibold text-foreground">
              פעילויות בית ספר
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="סגור"
                className="icon-button h-9 w-9"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          {isLoading && <LoadingState message="טוען פעילויות בית ספר..." className="py-8" />}

          {isError && !isLoading && (
            <ErrorState
              message="לא ניתן לטעון פעילויות בית ספר"
              onRetry={() => void refetch()}
            />
          )}

          {!isLoading && !isError && activities.length === 0 && (
            <EmptyState
              icon={<ClipboardList className="h-8 w-8" />}
              title="אין פעילויות בית ספר"
              subtitle="לא נמצאו פעילויות שממתינות לאישור או שכבר נענו"
            />
          )}

          {!isLoading && !isError && activities.length > 0 && (
            <div className="space-y-3">
              {activities.map((activity) => (
                <SchoolActivityCard key={activity.id} activity={activity} />
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
