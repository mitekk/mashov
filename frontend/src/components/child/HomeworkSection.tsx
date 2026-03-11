'use client';

import React from 'react';
import { BookOpen } from 'lucide-react';
import { useChildHomework } from '@/hooks/useChild';
import { HomeworkItem } from './HomeworkItem';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';

interface HomeworkSectionProps {
  studentGuid: string;
}

export function HomeworkSection({ studentGuid }: HomeworkSectionProps) {
  const { data, isLoading, isError, refetch } = useChildHomework(studentGuid);

  return (
    <section data-testid="homework-section" className="px-4 py-4">
      <h2 className="text-base font-semibold text-foreground mb-3">
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
        <div className="space-y-2">
          {data.data.map((item) => (
            <HomeworkItem key={item.id} item={item} studentGuid={studentGuid} />
          ))}
        </div>
      )}
    </section>
  );
}
