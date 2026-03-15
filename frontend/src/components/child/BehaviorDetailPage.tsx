'use client';

import React, { useEffect, useRef } from 'react';
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
import { BucketBadge, Badge } from '@/components/ui/Badge';
import { useChildBehaviorDetail } from '@/hooks/useChild';
import { useChildren } from '@/hooks/useChildren';
import { useMarkNew } from '@/hooks/useMarkNew';
import { useArchive } from '@/hooks/useArchive';
import { buildChildSectionHref } from '@/lib/child-routes';
import { getBucketColor } from '@/lib/behavior';
import { cn } from '@/lib/utils';
import { formatShortDate } from '@/lib/dates';

interface BehaviorDetailPageProps {
  studentGuid: string;
  behaviorId: string;
}

export function BehaviorDetailPage({ studentGuid, behaviorId }: BehaviorDetailPageProps) {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useChildBehaviorDetail(studentGuid, behaviorId);
  const { data: childrenData } = useChildren();
  const listHref = buildChildSectionHref(studentGuid, 'behavior');

  const invalidateKeys = [
    ['dashboard'],
    ['child-behavior', studentGuid],
    ['child-behavior-detail', studentGuid, behaviorId],
  ];

  const { mutate: mutateMarkNew, isPending: isMarkNewPending } = useMarkNew({
    type: 'behavior',
    id: behaviorId,
    studentGuid,
    invalidateKeys,
  });
  const autoMarkedReadBehaviorId = useRef<string | null>(null);

  const { mutate: mutateArchive, isPending: isArchivePending } = useArchive({
    type: 'behavior',
    id: behaviorId,
    studentGuid,
    invalidateKeys,
  });

  const colors = data ? getBucketColor(data.bucket) : null;
  const childFullName = childrenData?.data.find(
    (child) => child.studentGuid === studentGuid,
  )?.fullName;

  useEffect(() => {
    if (!data?.isNew) return;
    if (autoMarkedReadBehaviorId.current === behaviorId) return;
    autoMarkedReadBehaviorId.current = behaviorId;
    mutateMarkNew(false);
  }, [behaviorId, data?.isNew, mutateMarkNew]);

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    if (listHref) router.replace(listHref);
  };

  return (
    <AppShell>
      <div data-testid="behavior-detail-page" className="page-shell space-y-4">
        <div className="flex items-center justify-between gap-2 pt-5">
          <button
            type="button"
            data-testid="behavior-detail-back"
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
                data-testid={`behavior-detail-toggle-new-${behaviorId}`}
                onClick={() => mutateMarkNew(!data.isNew)}
                disabled={isMarkNewPending}
                aria-label={data.isNew ? 'סמן כנקרא' : 'סמן כלא נקרא'}
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
                    <span>סמן כלא נקרא</span>
                  </>
                )}
              </button>
              <button
                type="button"
                data-testid={`behavior-detail-archive-${behaviorId}`}
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

        {isLoading && <LoadingState message="טוען אירוע התנהגות..." />}
        {isError && (
          <ErrorState
            message="לא ניתן לטעון את פרטי אירוע ההתנהגות"
            onRetry={() => void refetch()}
          />
        )}

        {data && (
          <article
            data-testid={`behavior-detail-${data.id}`}
            className={cn(
              'card-base space-y-3 border-s-4 p-4',
              colors?.border,
            )}
          >
            <div className="flex items-start gap-2 flex-wrap">
              <BucketBadge bucket={data.bucket} />
              {data.justifiable && <Badge variant="secondary">מוצדק</Badge>}
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
              <span className="text-xs text-muted-foreground ms-auto whitespace-nowrap">
                {formatShortDate(data.lessonDate)}
              </span>
            </div>
            <p className="text-sm font-semibold text-foreground">
              {data.achvaName}
            </p>
            <div className="flex gap-3 flex-wrap text-xs text-muted-foreground">
              {childFullName && <span>תלמיד/ה: {childFullName}</span>}
              {data.subject && <span>{data.subject}</span>}
              {data.reporter && <span>{data.reporter}</span>}
              {data.lesson !== null && <span>שיעור {data.lesson}</span>}
            </div>
            {data.remark && (
              <p className="text-xs text-muted-foreground italic whitespace-pre-wrap">
                {data.remark}
              </p>
            )}
            {data.justification && (
              <div className="rounded-xl border border-border/80 bg-muted/35 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">נימוק</p>
                <p className="whitespace-pre-wrap">{data.justification}</p>
              </div>
            )}
            {data.files.length > 0 && (
              <div className="rounded-xl border border-border/80 bg-muted/35 p-3">
                <p className="mb-2 text-xs font-medium text-foreground">קבצים מצורפים</p>
                <div className="space-y-1.5">
                  {data.files.map((file) => (
                    <a
                      key={file.fileId}
                      href={`/api/v1/children/${studentGuid}/behavior/${behaviorId}/files/${encodeURIComponent(file.fileId)}`}
                      download={file.fileName}
                      className="flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Paperclip className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="truncate underline-offset-2 hover:underline">{file.fileName}</span>
                    </a>
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
