'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, Mail, MailOpen } from 'lucide-react';
import { useChildBehavior } from '@/hooks/useChild';
import { useBulkBehaviorArchive, useBulkBehaviorIsNew } from '@/hooks/useChildBulkActions';
import { BehaviorItem } from './BehaviorItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { cn } from '@/lib/utils';
import { getBucketLabel } from '@/lib/behavior';
import { buildBehaviorDetailHref, type ChildBehaviorFilter } from '@/lib/child-routes';

type BehaviorStatusFilter = 'new' | 'archived' | 'all';

interface BehaviorSectionProps {
  studentGuid: string;
  activeFilter: ChildBehaviorFilter;
  onFilterChange: (filter: ChildBehaviorFilter) => void;
  statusFilter: BehaviorStatusFilter;
  onStatusFilterChange: (status: BehaviorStatusFilter) => void;
}

const FILTER_TABS: ChildBehaviorFilter[] = ['all', 'attention', 'positive', 'neutral'];

export function BehaviorSection({
  studentGuid,
  activeFilter,
  onFilterChange,
  statusFilter,
  onStatusFilterChange,
}: BehaviorSectionProps) {
  const [selectedBehaviorIds, setSelectedBehaviorIds] = useState<string[]>([]);
  const { data, isLoading, isError, refetch } = useChildBehavior(
    studentGuid,
    1,
    activeFilter,
    statusFilter,
  );
  const { mutate: mutateBulkIsNew, isPending: isBulkIsNewPending } = useBulkBehaviorIsNew(studentGuid);
  const { mutate: mutateBulkArchive, isPending: isBulkArchivePending } = useBulkBehaviorArchive(studentGuid);
  const filteredItems = useMemo(() => data?.data ?? [], [data?.data]);
  const isBulkActionPending = isBulkIsNewPending || isBulkArchivePending;
  const hasSelection = selectedBehaviorIds.length > 0;

  const selectedItems = useMemo(
    () => filteredItems.filter((item) => selectedBehaviorIds.includes(item.id)),
    [filteredItems, selectedBehaviorIds],
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
    setSelectedBehaviorIds([]);
  }, [statusFilter, activeFilter]);

  const handleToggleSelect = (behaviorId: string, checked: boolean) => {
    setSelectedBehaviorIds((prev) => {
      if (checked) {
        if (prev.includes(behaviorId)) return prev;
        return [...prev, behaviorId];
      }
      return prev.filter((id) => id !== behaviorId);
    });
  };

  const handleSelectAllVisible = () => {
    setSelectedBehaviorIds(filteredItems.map((item) => item.id));
  };

  const handleClearSelection = () => {
    setSelectedBehaviorIds([]);
  };

  const handleStatusFilterChange = (nextStatus: BehaviorStatusFilter) => {
    onStatusFilterChange(nextStatus);
    setSelectedBehaviorIds([]);
  };

  const handleBulkMarkRead = () => {
    if (selectedNewIds.length === 0 || isBulkActionPending) return;
    mutateBulkIsNew(
      { behaviorIds: selectedNewIds, isNew: false },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkMarkUnread = () => {
    if (selectedReadIds.length === 0 || isBulkActionPending) return;
    mutateBulkIsNew(
      { behaviorIds: selectedReadIds, isNew: true },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkArchive = () => {
    if (selectedNonArchivedIds.length === 0 || isBulkActionPending) return;
    mutateBulkArchive(
      { behaviorIds: selectedNonArchivedIds, isArchived: true },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkUnarchive = () => {
    if (selectedArchivedIds.length === 0 || isBulkActionPending) return;
    mutateBulkArchive(
      { behaviorIds: selectedArchivedIds, isArchived: false },
      { onSuccess: handleClearSelection },
    );
  };

  return (
    <section data-testid="behavior-section" className="section-stack py-1">
      <h2 className="text-lg font-semibold text-foreground">
        אירועי התנהגות
      </h2>
      {/* Status tabs */}
      <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm w-fit">
        <button
          data-testid="behavior-status-new"
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
          data-testid="behavior-status-archived"
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
          data-testid="behavior-status-all"
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
          data-testid="behavior-bulk-actions"
          className="card-base flex flex-wrap items-center gap-2 px-3 py-2.5"
        >
          <span className="text-sm font-medium text-foreground">
            נבחרו {selectedBehaviorIds.length}
          </span>
          <button
            type="button"
            data-testid="behavior-bulk-select-all-visible"
            onClick={handleSelectAllVisible}
            disabled={isBulkActionPending}
            className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            בחר הכל
          </button>

          {(statusFilter === 'new' || statusFilter === 'all') && selectedNewIds.length > 0 && (
            <button
              type="button"
              data-testid="behavior-bulk-mark-read"
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
              data-testid="behavior-bulk-mark-unread"
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
              data-testid="behavior-bulk-archive"
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
              data-testid="behavior-bulk-unarchive"
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
            data-testid="behavior-bulk-clear-selection"
            onClick={handleClearSelection}
            disabled={isBulkActionPending}
            className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            נקה בחירה
          </button>
        </section>
      )}
      {/* Bucket filter chips */}
      <div className="rail">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab}
            data-testid={`behavior-filter-${tab}`}
            onClick={() => onFilterChange(tab)}
            className={cn(
              'tap-target flex-shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors',
              activeFilter === tab
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border/80 bg-secondary/75 text-secondary-foreground hover:bg-accent',
            )}
          >
            {getBucketLabel(tab)}
          </button>
        ))}
      </div>
      {isLoading && <FeedSkeleton count={3} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון אירועי התנהגות"
          onRetry={() => void refetch()}
        />
      )}
      {!isLoading && !isError && filteredItems.length === 0 && (
        <EmptyState
          icon={<AlertTriangle className="w-8 h-8" />}
          title={
            statusFilter === 'archived'
              ? 'אין אירועי התנהגות בארכיון'
              : statusFilter === 'new'
                ? 'אין אירועי התנהגות שלא נקראו'
                : 'אין אירועי התנהגות'
          }
          subtitle={activeFilter !== 'all' ? 'נסה לשנות את הסינון' : undefined}
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
            <BehaviorItem
              key={item.id}
              item={item}
              studentGuid={studentGuid}
              detailHref={buildBehaviorDetailHref(studentGuid, item.id)}
              selected={selectedBehaviorIds.includes(item.id)}
              onToggleSelect={handleToggleSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}
