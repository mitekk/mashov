'use client';

import React, { useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import type { FeedItem as FeedItemType } from '@/types/api';
import { FeedItem } from './FeedItem';
import { BulkActionBar } from './BulkActionBar';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { useFeedBulkActions } from '@/hooks/useFeedBulkActions';

interface LatestFeedProps {
  items: FeedItemType[];
}

const PAGE_SIZE = 10;
type FeedFilter = 'new' | 'archived' | 'all';

export function LatestFeed({ items }: LatestFeedProps) {
  const [activeFilter, setActiveFilter] = useState<FeedFilter>('new');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { markIsNew, archive } = useFeedBulkActions();

  const filteredItems = items.filter((item) => {
    if (activeFilter === 'new') return item.isNew && !item.isArchived;
    if (activeFilter === 'archived') return item.isArchived;
    return !item.isArchived;
  });
  const visibleItems = filteredItems.slice(0, visibleCount);
  const selectedItems = useMemo(
    () => filteredItems.filter((item) => selectedIds.includes(item.id)),
    [filteredItems, selectedIds],
  );
  const selectedNewItems = useMemo(
    () => selectedItems.filter((item) => !item.isArchived && item.isNew),
    [selectedItems],
  );
  const selectedReadItems = useMemo(
    () => selectedItems.filter((item) => !item.isArchived && !item.isNew),
    [selectedItems],
  );
  const selectedArchivedItems = useMemo(
    () => selectedItems.filter((item) => item.isArchived),
    [selectedItems],
  );
  const selectedNonArchivedItems = useMemo(
    () => selectedItems.filter((item) => !item.isArchived),
    [selectedItems],
  );

  const hasMore = visibleCount < filteredItems.length;
  const isEmpty = filteredItems.length === 0;
  const isBulkActionPending = markIsNew.isPending || archive.isPending;
  const hasSelection = selectedItems.length > 0;

  const handleFilterChange = (nextFilter: FeedFilter) => {
    setActiveFilter(nextFilter);
    setVisibleCount(PAGE_SIZE);
    setSelectedIds([]);
  };

  const handleToggleSelect = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) {
        if (prev.includes(id)) return prev;
        return [...prev, id];
      }
      return prev.filter((itemId) => itemId !== id);
    });
  };

  const handleSelectAllVisible = () => {
    setSelectedIds(visibleItems.map((item) => item.id));
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
  };

  const handleBulkMarkRead = () => {
    if (selectedNewItems.length === 0 || isBulkActionPending) return;
    markIsNew.mutate(
      { items: selectedNewItems, isNew: false },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkMarkUnread = () => {
    if (selectedReadItems.length === 0 || isBulkActionPending) return;
    markIsNew.mutate(
      { items: selectedReadItems, isNew: true },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkArchive = () => {
    if (selectedNonArchivedItems.length === 0 || isBulkActionPending) return;
    archive.mutate(
      { items: selectedNonArchivedItems, isArchived: true },
      { onSuccess: handleClearSelection },
    );
  };

  const handleBulkUnarchive = () => {
    if (selectedArchivedItems.length === 0 || isBulkActionPending) return;
    archive.mutate(
      { items: selectedArchivedItems, isArchived: false },
      { onSuccess: handleClearSelection },
    );
  };

  return (
    // `.measure` caps the column at reading width: past ~3xl the eye has to
    // track a feed headline across the whole desktop and loses the line.
    <section data-testid="latest-feed" className="section-stack measure">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          עדכונים אחרונים
        </h2>
        <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm">
          <button
            data-testid="home-feed-filter-unread"
            onClick={() => handleFilterChange('new')}
            className={cn(
              'px-3 py-1.5 transition-colors',
              activeFilter === 'new'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            לא נקרא
          </button>
          <button
            data-testid="home-feed-filter-archived"
            onClick={() => handleFilterChange('archived')}
            className={cn(
              'px-3 py-1.5 transition-colors',
              activeFilter === 'archived'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            ארכיון
          </button>
          <button
            data-testid="home-feed-filter-all"
            onClick={() => handleFilterChange('all')}
            className={cn(
              'px-3 py-1.5 transition-colors',
              activeFilter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            הכל
          </button>
        </div>
      </div>
      {hasSelection && (
        <BulkActionBar
          count={selectedItems.length}
          isPending={isBulkActionPending}
          onClear={handleClearSelection}
          onSelectAllVisible={handleSelectAllVisible}
          showMarkRead={selectedNewItems.length > 0}
          showMarkUnread={selectedReadItems.length > 0}
          showArchive={selectedNonArchivedItems.length > 0}
          showUnarchive={selectedArchivedItems.length > 0}
          onMarkRead={handleBulkMarkRead}
          onMarkUnread={handleBulkMarkUnread}
          onArchive={handleBulkArchive}
          onUnarchive={handleBulkUnarchive}
        />
      )}
      {isEmpty ? (
        <EmptyState
          icon={<Inbox className="w-8 h-8" />}
          title={
            activeFilter === 'new'
              ? 'אין עדכונים שלא נקראו'
              : activeFilter === 'archived'
                ? 'אין פריטים בארכיון'
                : 'אין עדכונים פעילים'
          }
          subtitle={
            activeFilter === 'new'
              ? 'נסה לעבור לכל הפריטים'
              : activeFilter === 'archived'
                ? 'לא נמצאו פריטים בארכיון'
                : 'כל הפריטים טופלו'
          }
        />
      ) : (
        <div className="section-stack">
          {visibleItems.map((item) => (
            <FeedItem
              key={item.id}
              item={item}
              selected={selectedIds.includes(item.id)}
              onToggleSelect={handleToggleSelect}
              forceRestoreOnly={activeFilter === 'archived'}
            />
          ))}
          {hasMore && (
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              data-testid="load-more-feed"
              className="tap-target w-full rounded-2xl border border-primary/30 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
            >
              טען עוד
            </button>
          )}
        </div>
      )}
    </section>
  );
}
