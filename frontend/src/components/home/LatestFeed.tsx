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
    <section data-testid="latest-feed" className="px-4">
      <h2 className="text-base font-semibold text-foreground mb-3">
        עדכונים אחרונים
      </h2>
      {items.length === 0 ? (
        <EmptyState
          icon={<Inbox className="w-8 h-8" />}
          title="אין עדכונים חדשים"
          subtitle="כל הפריטים טופלו"
        />
      ) : (
        <div className="space-y-2">
          {visibleItems.map((item) => (
            <FeedItem key={item.id} item={item} />
          ))}
          {hasMore && (
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              data-testid="load-more-feed"
              className="w-full py-2.5 text-sm text-primary font-medium border border-primary/30 rounded-xl hover:bg-primary/5 transition-colors tap-target"
            >
              טען עוד
            </button>
          )}
        </div>
      )}
    </section>
  );
}
