'use client';

import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { BehaviorBucket } from '@/types/api';
import { useChildBehavior } from '@/hooks/useChild';
import { BehaviorItem } from './BehaviorItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { cn } from '@/lib/utils';
import { getBucketLabel } from '@/lib/behavior';

interface BehaviorSectionProps {
  studentGuid: string;
}

type FilterTab = BehaviorBucket | 'all';

const FILTER_TABS: FilterTab[] = ['all', 'attention', 'positive', 'neutral'];

export function BehaviorSection({ studentGuid }: BehaviorSectionProps) {
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const { data, isLoading, isError, refetch } = useChildBehavior(
    studentGuid,
    1,
    activeFilter,
  );

  return (
    <section data-testid="behavior-section" className="px-4 py-4">
      <h2 className="text-base font-semibold text-foreground mb-3">
        אירועי התנהגות
      </h2>
      <div className="flex gap-2 mb-3 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {FILTER_TABS.map((tab) => (
          <button
            key={tab}
            data-testid={`behavior-filter-${tab}`}
            onClick={() => setActiveFilter(tab)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium flex-shrink-0 border transition-colors tap-target',
              activeFilter === tab
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-secondary text-secondary-foreground border-border hover:bg-accent',
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
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<AlertTriangle className="w-8 h-8" />}
          title="אין אירועי התנהגות"
          subtitle={activeFilter !== 'all' ? 'נסה לשנות את הסינון' : undefined}
        />
      )}
      {data && data.data.length > 0 && (
        <div className="space-y-2">
          {data.data.map((item) => (
            <BehaviorItem key={item.id} item={item} studentGuid={studentGuid} />
          ))}
        </div>
      )}
    </section>
  );
}
