'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BookmarkCheck,
  BookmarkX,
  Paperclip,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useChildHomeworkDetail } from '@/hooks/useChild';
import { useChildren } from '@/hooks/useChildren';
import { useMarkHandled } from '@/hooks/useReadState';
import { buildChildSectionHref } from '@/lib/child-routes';
import { cn } from '@/lib/utils';
import { formatShortDate } from '@/lib/dates';

interface HomeworkDetailPageProps {
  studentGuid: string;
  homeworkId: string;
}

export function HomeworkDetailPage({ studentGuid, homeworkId }: HomeworkDetailPageProps) {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useChildHomeworkDetail(studentGuid, homeworkId);
  const { data: childrenData } = useChildren();
  const listHref = buildChildSectionHref(studentGuid, 'homework');
  const { markHandled, isPending } = useMarkHandled(
    'homework',
    homeworkId,
    [
      ['dashboard'],
      ['child-homework', studentGuid],
      ['child-homework-detail', studentGuid, homeworkId],
    ],
  );
  const childFullName = childrenData?.data.find(
    (child) => child.studentGuid === studentGuid,
  )?.fullName;

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    if (listHref) router.replace(listHref);
  };

  const handleToggleHandled = () => {
    if (!data) return;
    markHandled(!data.isHandled);
  };

  return (
    <AppShell>
      <div data-testid="homework-detail-page" className="page-shell space-y-4">
        <div className="flex items-center justify-between gap-2 pt-5">
          <button
            type="button"
            data-testid="homework-detail-back"
            onClick={handleBack}
            aria-label="חזור"
            className="icon-button"
          >
            <ArrowRight className="h-5 w-5" />
          </button>
          {data && (
            <button
              type="button"
              data-testid={`homework-detail-toggle-${homeworkId}`}
              onClick={handleToggleHandled}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {data.isHandled ? (
                <>
                  <BookmarkX className="h-4 w-4" />
                  <span>בטל טיפול</span>
                </>
              ) : (
                <>
                  <BookmarkCheck className="h-4 w-4" />
                  <span>סמן כטופל</span>
                </>
              )}
            </button>
          )}
        </div>

        {isLoading && <LoadingState message="טוען שיעורי בית..." />}
        {isError && (
          <ErrorState
            message="לא ניתן לטעון את פרטי שיעורי הבית"
            onRetry={() => void refetch()}
          />
        )}

        {data && (
          <article
            data-testid={`homework-detail-${data.id}`}
            className={cn(
              'card-base space-y-3 p-4',
              data.isHandled && 'opacity-70',
            )}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="rounded-full border border-info/35 bg-info-subtle px-2 py-0.5 text-xs font-medium text-info">
                {data.subjectName}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatShortDate(data.lessonDate)}
              </span>
              {childFullName && (
                <span className="text-xs text-muted-foreground">
                  תלמיד/ה: {childFullName}
                </span>
              )}
              {data.lesson > 0 && (
                <span className="text-xs text-muted-foreground">שיעור {data.lesson}</span>
              )}
            </div>
            <p
              className={cn(
                'text-sm text-foreground whitespace-pre-wrap',
                data.isHandled && 'line-through',
              )}
            >
              {data.homeworkText}
            </p>
            {data.remark && (
              <p className="text-xs text-muted-foreground italic whitespace-pre-wrap">
                {data.remark}
              </p>
            )}
            {data.files.length > 0 && (
              <div className="rounded-xl border border-border/80 bg-muted/35 p-3">
                <p className="mb-2 text-xs font-medium text-foreground">קבצים מצורפים</p>
                <div className="space-y-1.5">
                  {data.files.map((file) => (
                    <div key={file.fileId} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Paperclip className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="truncate">{file.fileName}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </article>
        )}
      </div>
    </AppShell>
  );
}
