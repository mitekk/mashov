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
    <section data-testid="needs-attention-section" className="px-4">
      <h2 className="text-base font-semibold text-foreground mb-3">
        דורש תשומת לב
      </h2>
      {items.length === 0 ? (
        <EmptyState
          icon={<AlertCircle className="w-8 h-8" />}
          title="אין פריטים הדורשים תשומת לב"
          subtitle="הכל מסודר"
        />
      ) : (
        <div className="space-y-2">
          {visibleItems.map((item) => (
            <NeedsAttentionCard key={item.id} item={item} />
          ))}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              data-testid="show-all-attention"
              className="w-full py-2 text-sm text-primary font-medium hover:underline tap-target"
            >
              ראה הכל ({items.length})
            </button>
          )}
        </div>
      )}
    </section>
  );
}
