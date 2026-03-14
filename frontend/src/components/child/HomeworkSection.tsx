'use client';

import React, { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useChildHomework } from '@/hooks/useChild';
import { HomeworkItem } from './HomeworkItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { buildHomeworkDetailHref } from '@/lib/child-routes';
import { cn } from '@/lib/utils';

type HomeworkStatusFilter = 'active' | 'archived';

interface HomeworkSectionProps {
  studentGuid: string;
}

export function HomeworkSection({ studentGuid }: HomeworkSectionProps) {
  const [statusFilter, setStatusFilter] = useState<HomeworkStatusFilter>('active');
  const { data, isLoading, isError, refetch } = useChildHomework(studentGuid);

  const filteredItems = data?.data.filter((item) =>
    statusFilter === 'archived' ? item.isArchived : !item.isArchived,
  ) ?? [];

  return (
    <section data-testid="homework-section" className="section-stack py-1">
      <h2 className="text-lg font-semibold text-foreground">
        שיעורי בית אחרונים
      </h2>
      <div className="flex overflow-hidden rounded-xl border border-border/80 bg-card text-sm shadow-sm w-fit">
        <button
          data-testid="homework-filter-active"
          onClick={() => setStatusFilter('active')}
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
          data-testid="homework-filter-archived"
          onClick={() => setStatusFilter('archived')}
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
          title={statusFilter === 'archived' ? 'אין שיעורי בית בארכיון' : 'אין שיעורי בית אחרונים'}
        />
      )}
      {filteredItems.length > 0 && (
        <div className="section-stack">
          {filteredItems.map((item) => (
            <HomeworkItem
              key={item.id}
              item={item}
              studentGuid={studentGuid}
              detailHref={buildHomeworkDetailHref(studentGuid, item.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
