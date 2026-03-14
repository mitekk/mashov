'use client';

import React from 'react';
import { Bell } from 'lucide-react';
import { useChildNotices } from '@/hooks/useChild';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { formatShortDate } from '@/lib/dates';
import DOMPurify from 'dompurify';

interface NoticesSectionProps {
  studentGuid: string;
}

export function NoticesSection({ studentGuid }: NoticesSectionProps) {
  const { data, isLoading, isError, refetch } = useChildNotices(studentGuid);

  return (
    <section data-testid="notices-section" className="section-stack py-1">
      <h2 className="text-lg font-semibold text-foreground">
        הודעות בית הספר
      </h2>
      {isLoading && <FeedSkeleton count={2} />}
      {isError && (
        <ErrorState
          message="לא ניתן לטעון הודעות"
          onRetry={() => void refetch()}
        />
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<Bell className="w-8 h-8" />}
          title="אין הודעות"
        />
      )}
      {data && data.data.length > 0 && (
        <div className="space-y-3">
          {data.data.map((notice) => (
            <div key={notice.id} className="card-base p-4">
              <p className="text-xs text-muted-foreground mb-2">
                בתוקף עד {formatShortDate(notice.expirationDate)}
              </p>
              <div
                className="prose-rtl text-sm text-foreground"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(notice.eventText),
                }}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
