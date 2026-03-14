'use client';

import React from 'react';
import { BookOpen } from 'lucide-react';
import { useChildHomework } from '@/hooks/useChild';
import { HomeworkItem } from './HomeworkItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { buildHomeworkDetailHref } from '@/lib/child-routes';

interface HomeworkSectionProps {
  studentGuid: string;
}

export function HomeworkSection({ studentGuid }: HomeworkSectionProps) {
  const { data, isLoading, isError, refetch } = useChildHomework(studentGuid);

  return (
    <section data-testid="homework-section" className="section-stack py-1">
      <h2 className="text-lg font-semibold text-foreground">
        שיעורי בית אחרונים
      </h2>
      {isLoading && <FeedSkeleton count={3} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון שיעורי בית"
          onRetry={() => void refetch()}
        />
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<BookOpen className="w-8 h-8" />}
          title="אין שיעורי בית אחרונים"
        />
      )}
      {data && data.data.length > 0 && (
        <div className="section-stack">
          {data.data.map((item) => (
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
