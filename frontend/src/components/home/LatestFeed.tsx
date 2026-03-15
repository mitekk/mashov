'use client';

import React, { useState } from 'react';
import { Inbox } from 'lucide-react';
import type { FeedItem as FeedItemType } from '@/types/api';
import { FeedItem } from './FeedItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';

interface LatestFeedProps {
  items: FeedItemType[];
}

const PAGE_SIZE = 10;
type FeedFilter = 'all' | 'unread';

export function LatestFeed({ items }: LatestFeedProps) {
  const [activeFilter, setActiveFilter] = useState<FeedFilter>('unread');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const filteredItems = activeFilter === 'unread'
    ? items.filter((item) => item.isNew)
    : items;
  const visibleItems = filteredItems.slice(0, visibleCount);
  const hasMore = visibleCount < filteredItems.length;
  const isEmpty = filteredItems.length === 0;

  const handleFilterChange = (nextFilter: FeedFilter) => {
    setActiveFilter(nextFilter);
    setVisibleCount(PAGE_SIZE);
  };

  return (
    <section data-testid="latest-feed" className="section-stack">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          עדכונים אחרונים
        </h2>
        <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm">
          <button
            data-testid="home-feed-filter-unread"
            onClick={() => handleFilterChange('unread')}
            className={cn(
              'px-3 py-1.5 transition-colors',
              activeFilter === 'unread'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            לא נקרא
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
      {isEmpty ? (
        <EmptyState
          icon={<Inbox className="w-8 h-8" />}
          title={activeFilter === 'unread' ? 'אין עדכונים שלא נקראו' : 'אין עדכונים חדשים'}
          subtitle={activeFilter === 'unread' ? 'נסה לעבור לכל הפריטים' : 'כל הפריטים טופלו'}
        />
      ) : (
        <div className="section-stack">
          {visibleItems.map((item) => (
            <FeedItem key={item.id} item={item} />
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
