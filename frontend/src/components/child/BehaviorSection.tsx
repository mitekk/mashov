'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useChildBehavior } from '@/hooks/useChild';
import { BehaviorItem } from './BehaviorItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { cn } from '@/lib/utils';
import { getBucketLabel } from '@/lib/behavior';
import { buildBehaviorDetailHref, type ChildBehaviorFilter } from '@/lib/child-routes';

type BehaviorStatusFilter = 'active' | 'archived';

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
  const { data, isLoading, isError, refetch } = useChildBehavior(
    studentGuid,
    1,
    activeFilter,
  );

  const filteredItems = data?.data.filter((item) =>
    statusFilter === 'archived' ? item.isArchived : !item.isArchived,
  ) ?? [];

  return (
    <section data-testid="behavior-section" className="section-stack py-1">
      <h2 className="text-lg font-semibold text-foreground">
        אירועי התנהגות
      </h2>
      {/* Status (Active / Archived) tabs */}
      <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm w-fit">
        <button
          data-testid="behavior-status-active"
          onClick={() => onStatusFilterChange('active')}
          className={cn(
            'px-3 py-1.5 transition-colors',
            statusFilter === 'active'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          פעיל
        </button>
        <button
          data-testid="behavior-status-archived"
          onClick={() => onStatusFilterChange('archived')}
          className={cn(
            'px-3 py-1.5 transition-colors',
            statusFilter === 'archived'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          ארכיון
        </button>
      </div>
      {/* Bucket filter chips */}
      <div className="flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
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
          title={statusFilter === 'archived' ? 'אין אירועי התנהגות בארכיון' : 'אין אירועי התנהגות'}
          subtitle={activeFilter !== 'all' ? 'נסה לשנות את הסינון' : undefined}
        />
      )}
      {filteredItems.length > 0 && (
        <div className="section-stack">
          {filteredItems.map((item) => (
            <BehaviorItem
              key={item.id}
              item={item}
              studentGuid={studentGuid}
              detailHref={buildBehaviorDetailHref(studentGuid, item.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
