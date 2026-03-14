'use client';

import React, { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { NeedsAttentionItem } from '@/types/api';
import { NeedsAttentionCard } from './NeedsAttentionCard';
import { EmptyState } from '@/components/ui/EmptyState';

interface NeedsAttentionSectionProps {
  items: NeedsAttentionItem[];
}

const INITIAL_VISIBLE = 5;

export function NeedsAttentionSection({ items }: NeedsAttentionSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const visibleItems = showAll ? items : items.slice(0, INITIAL_VISIBLE);
  const hasMore = items.length > INITIAL_VISIBLE;

  return (
    <section data-testid="needs-attention-section" className="section-stack">
      <h2 className="text-lg font-semibold text-foreground">
        דורש תשומת לב
      </h2>
      {items.length === 0 ? (
        <EmptyState
          icon={<AlertCircle className="w-8 h-8" />}
          title="אין פריטים הדורשים תשומת לב"
          subtitle="הכל מסודר"
        />
      ) : (
        <div className="section-stack">
          {visibleItems.map((item) => (
            <NeedsAttentionCard key={item.id} item={item} />
          ))}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              data-testid="show-all-attention"
              className="tap-target w-full rounded-2xl border border-primary/25 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
            >
              ראה הכל ({items.length})
            </button>
          )}
        </div>
      )}
    </section>
  );
}
