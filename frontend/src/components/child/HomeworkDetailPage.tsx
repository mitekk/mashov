'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Eye,
  EyeOff,
  Archive,
  Paperclip,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useChildHomeworkDetail } from '@/hooks/useChild';
import { useChildren } from '@/hooks/useChildren';
import { useMarkNew } from '@/hooks/useMarkNew';
import { useArchive } from '@/hooks/useArchive';
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

  const invalidateKeys = [
    ['dashboard'],
    ['child-homework', studentGuid],
    ['child-homework-detail', studentGuid, homeworkId],
  ];

  const { mutate: mutateMarkNew, isPending: isMarkNewPending } = useMarkNew({
    type: 'homework',
    id: homeworkId,
    studentGuid,
    invalidateKeys,
  });

  const { mutate: mutateArchive, isPending: isArchivePending } = useArchive({
    type: 'homework',
    id: homeworkId,
    studentGuid,
    invalidateKeys,
  });

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
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid={`homework-detail-toggle-new-${homeworkId}`}
                onClick={() => mutateMarkNew(!data.isNew)}
                disabled={isMarkNewPending}
                aria-label={data.isNew ? 'סמן כנקרא' : 'סמן כחדש'}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {data.isNew ? (
                  <>
                    <Eye className="h-4 w-4" />
                    <span>סמן כנקרא</span>
                  </>
                ) : (
                  <>
                    <EyeOff className="h-4 w-4" />
                    <span>סמן כחדש</span>
                  </>
                )}
              </button>
              <button
                type="button"
                data-testid={`homework-detail-archive-${homeworkId}`}
                onClick={() => mutateArchive(!data.isArchived)}
                disabled={isArchivePending}
                aria-label={data.isArchived ? 'שחזר מארכיון' : 'העבר לארכיון'}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50',
                  data.isArchived ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <Archive className="h-4 w-4" />
                <span>{data.isArchived ? 'שחזר' : 'ארכיון'}</span>
              </button>
            </div>
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
            className="card-base space-y-3 p-4"
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
              {data.isNew && (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  חדש
                </span>
              )}
              {data.isArchived && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  בארכיון
                </span>
              )}
            </div>
            <p className="text-sm text-foreground whitespace-pre-wrap">
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
