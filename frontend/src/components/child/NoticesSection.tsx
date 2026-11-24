'use client';

import React from 'react';
import { Bell } from 'lucide-react';
import { useChildNotices } from '@/hooks/useChild';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { FeedSkeleton } from '@/components/ui/LoadingState';
import { RichTextContent } from '@/components/ui/RichTextContent';
import { formatShortDate } from '@/lib/dates';

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
      {/* One column until xl, two after it. NOT lg: at exactly 1024 the rail
          (80), the shell padding (64), the workspace sidebar (224) and its gap
          (24) leave 632px, so two columns with gap-3 are 310px each -- NARROWER
          than the 328px the same card gets on a 360px phone. At 1280 with
          page-shell-wide there is room.

          A grid, not `.section-stack`: space-y puts margin-top on every child
          but the first, which in a two-column grid offsets the second column's
          first row. */}
      {data && data.data.length > 0 && (
        <div className="grid gap-3 xl:grid-cols-2">
          {data.data.map((notice) => (
            <div key={notice.id} className="card-base p-4">
              <p className="text-xs text-muted-foreground mb-2">
                בתוקף עד {formatShortDate(notice.expirationDate)}
              </p>
              <RichTextContent
                html={notice.eventText}
                className="text-sm text-foreground"
                contentTestId={`notice-content-${notice.id}`}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
