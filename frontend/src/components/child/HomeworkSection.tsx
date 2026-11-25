'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Archive, BookOpen, Mail, MailOpen } from 'lucide-react';
import { useChildHomework } from '@/hooks/useChild';
import { useBulkHomeworkArchive, useBulkHomeworkIsNew } from '@/hooks/useChildBulkActions';
import { HomeworkItem } from './HomeworkItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { buildHomeworkDetailHref } from '@/lib/child-routes';
import { cn } from '@/lib/utils';

type HomeworkStatusFilter = 'new' | 'archived' | 'all';

interface HomeworkSectionProps {
  studentGuid: string;
}

export function HomeworkSection({ studentGuid }: HomeworkSectionProps) {
  const [statusFilter, setStatusFilter] = useState<HomeworkStatusFilter>('new');
  const [selectedHomeworkIds, setSelectedHomeworkIds] = useState<string[]>([]);
  const { data, isLoading, isError, refetch } = useChildHomework(
    studentGuid,
    1,
    statusFilter,
  );
  const { mutate: mutateBulkIsNew, isPending: isBulkIsNewPending } = useBulkHomeworkIsNew(studentGuid);
  const { mutate: mutateBulkArchive, isPending: isBulkArchivePending } = useBulkHomeworkArchive(studentGuid);
  const filteredItems = useMemo(() => data?.data ?? [], [data?.data]);
  const isBulkActionPending = isBulkIsNewPending || isBulkArchivePending;
  const hasSelection = selectedHomeworkIds.length > 0;

  const selectedItems = useMemo(
    () => filteredItems.filter((item) => selectedHomeworkIds.includes(item.id)),
    [filteredItems, selectedHomeworkIds],
  );
  // Restorable only. A past-year item is archived by derivation, so sending
  // it to the unarchive endpoint would write a flag the API overrules and
  // move nothing (ADR-0036); with only such rows selected the button is gone.
  const selectedArchivedIds = useMemo(
    () =>
      selectedItems
        .filter((item) => item.isArchived && !item.isPastYear)
        .map((item) => item.id),
    [selectedItems],
  );
  const selectedNonArchivedIds = useMemo(
    () => selectedItems.filter((item) => !item.isArchived).map((item) => item.id),
    [selectedItems],
  );
  const selectedNewIds = useMemo(
    () => selectedItems.filter((item) => !item.isArchived && item.isNew).map((item) => item.id),
    [selectedItems],
  );
  const selectedReadIds = useMemo(
    () => selectedItems.filter((item) => !item.isArchived && !item.isNew).map((item) => item.id),
    [selectedItems],
  );

  useEffect(() => {
    setSelectedHomeworkIds([]);
  }, [statusFilter]);

  const handleStatusFilterChange = (nextStatus: HomeworkStatusFilter) => {
    setStatusFilter(nextStatus);
    setSelectedHomeworkIds([]);
  };

  const handleToggleSelect = (homeworkId: string, checked: boolean) => {
    setSelectedHomeworkIds((prev) => {
      if (checked) {
        if (prev.includes(homeworkId)) return prev;
        return [...prev, homeworkId];
      }
      return prev.filter((id) => id !== homeworkId);
    });
  };

  const handleSelectAllVisible = () => {
    setSelectedHomeworkIds(filteredItems.map((item) => item.id));
  };

  const handleClearSelection = () => {
    setSelectedHomeworkIds([]);
  };

  const handleBulkMarkRead = () => {
    if (selectedNewIds.length === 0 || isBulkActionPending) return;
    mutateBulkIsNew(
      { homeworkIds: selectedNewIds, isNew: false },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkMarkUnread = () => {
    if (selectedReadIds.length === 0 || isBulkActionPending) return;
    mutateBulkIsNew(
      { homeworkIds: selectedReadIds, isNew: true },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkArchive = () => {
    if (selectedNonArchivedIds.length === 0 || isBulkActionPending) return;
    mutateBulkArchive(
      { homeworkIds: selectedNonArchivedIds, isArchived: true },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkUnarchive = () => {
    if (selectedArchivedIds.length === 0 || isBulkActionPending) return;
    mutateBulkArchive(
      { homeworkIds: selectedArchivedIds, isArchived: false },
      { onSuccess: handleClearSelection },
    );
  };

  return (
    <section
      data-testid="homework-section"
      // The tab rail above already names this section, so the heading is
      // `sr-only` -- the outline needs it, the eye does not.
      // `aria-labelledby` rather than `aria-label`: the two would otherwise
      // announce the same name twice, once as the region and once as the
      // heading.
      aria-labelledby="homework-section-title"
      className="section-stack py-1"
    >
      <h2 id="homework-section-title" className="sr-only">שיעורי בית אחרונים</h2>
      <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm w-fit">
        <button
          data-testid="homework-filter-new"
          onClick={() => handleStatusFilterChange('new')}
          className={cn(
            'px-3 py-1.5 transition-colors',
            statusFilter === 'new'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          לא נקרא
        </button>
        <button
          data-testid="homework-filter-archived"
          onClick={() => handleStatusFilterChange('archived')}
          className={cn(
            'px-3 py-1.5 transition-colors',
            statusFilter === 'archived'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          ארכיון
        </button>
        <button
          data-testid="homework-filter-all"
          onClick={() => handleStatusFilterChange('all')}
          className={cn(
            'px-3 py-1.5 transition-colors',
            statusFilter === 'all'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          הכל
        </button>
      </div>
      {hasSelection && (
        <section
          data-testid="homework-bulk-actions"
          className="card-base flex flex-wrap items-center gap-2 px-3 py-2.5"
        >
          <span className="text-sm font-medium text-foreground">
            נבחרו {selectedHomeworkIds.length}
          </span>
          <button
            type="button"
            data-testid="homework-bulk-select-all-visible"
            onClick={handleSelectAllVisible}
            disabled={isBulkActionPending}
            className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            בחר הכל
          </button>

          {(statusFilter === 'new' || statusFilter === 'all') && selectedNewIds.length > 0 && (
            <button
              type="button"
              data-testid="homework-bulk-mark-read"
              onClick={handleBulkMarkRead}
              disabled={isBulkActionPending}
              className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Mail className="h-3.5 w-3.5" />
              סמן כנקרא
            </button>
          )}

          {statusFilter === 'all' && selectedReadIds.length > 0 && (
            <button
              type="button"
              data-testid="homework-bulk-mark-unread"
              onClick={handleBulkMarkUnread}
              disabled={isBulkActionPending}
              className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <MailOpen className="h-3.5 w-3.5" />
              סמן כלא נקרא
            </button>
          )}

          {(statusFilter === 'new' || statusFilter === 'all') && selectedNonArchivedIds.length > 0 && (
            <button
              type="button"
              data-testid="homework-bulk-archive"
              onClick={handleBulkArchive}
              disabled={isBulkActionPending}
              className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              ארכיון
            </button>
          )}

          {(statusFilter === 'archived' || statusFilter === 'all') && selectedArchivedIds.length > 0 && (
            <button
              type="button"
              data-testid="homework-bulk-unarchive"
              onClick={handleBulkUnarchive}
              disabled={isBulkActionPending}
              className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              שחזר מארכיון
            </button>
          )}

          <button
            type="button"
            data-testid="homework-bulk-clear-selection"
            onClick={handleClearSelection}
            disabled={isBulkActionPending}
            className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            נקה בחירה
          </button>
        </section>
      )}
      {isLoading && <FeedSkeleton count={3} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון שיעורי בית"
          onRetry={() => void refetch()}
        />
      )}
      {!isLoading && !isError && filteredItems.length === 0 && (
        <EmptyState
          icon={<BookOpen className="w-8 h-8" />}
          title={
            statusFilter === 'archived'
              ? 'אין שיעורי בית בארכיון'
              : statusFilter === 'new'
                ? 'אין שיעורי בית שלא נקראו'
                : 'אין שיעורי בית'
          }
        />
      )}
      {/* One column until xl, two after it. NOT lg: at exactly 1024 the rail
          (80), the shell padding (64), the workspace sidebar (224) and its gap
          (24) leave 632px, so two columns with gap-3 are 310px each -- NARROWER
          than the 328px the same card gets on a 360px phone. At 1280 with
          page-shell-wide there is room.

          A grid, not `.section-stack`: space-y puts margin-top on every child
          but the first, which in a two-column grid offsets the second column's
          first row. */}
      {filteredItems.length > 0 && (
        <div className="grid gap-3 xl:grid-cols-2">
          {filteredItems.map((item) => (
            <HomeworkItem
              key={item.id}
              item={item}
              studentGuid={studentGuid}
              detailHref={buildHomeworkDetailHref(studentGuid, item.id)}
              selected={selectedHomeworkIds.includes(item.id)}
              onToggleSelect={handleToggleSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}
