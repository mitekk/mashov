'use client';

import React, { useState } from 'react';
import { Inbox } from 'lucide-react';
import type { FeedItem as FeedItemType } from '@/types/api';
import { FeedItem } from './FeedItem';
import { EmptyState } from '@/components/ui/EmptyState';

interface LatestFeedProps {
  items: FeedItemType[];
}

const PAGE_SIZE = 10;

export function LatestFeed({ items }: LatestFeedProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visibleItems = items.slice(0, visibleCount);
  const hasMore = visibleCount < items.length;

  return (
    <section data-testid="latest-feed" className="section-stack">
      <h2 className="text-lg font-semibold text-foreground">
        עדכונים אחרונים
      </h2>
      {items.length === 0 ? (
        <EmptyState
          icon={<Inbox className="w-8 h-8" />}
          title="אין עדכונים חדשים"
          subtitle="כל הפריטים טופלו"
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
