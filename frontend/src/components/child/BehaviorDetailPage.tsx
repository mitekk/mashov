'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BookmarkCheck,
  BookmarkX,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { BucketBadge, Badge } from '@/components/ui/Badge';
import { useChildBehaviorDetail } from '@/hooks/useChild';
import { useMarkHandled } from '@/hooks/useReadState';
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
  const listHref = buildChildSectionHref(studentGuid, 'behavior');
  const { markHandled, isPending } = useMarkHandled(
    'behavior',
    behaviorId,
    [
      ['dashboard'],
      ['child-behavior', studentGuid],
      ['child-behavior-detail', studentGuid, behaviorId],
    ],
  );
  const colors = data ? getBucketColor(data.bucket) : null;

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
            <button
              type="button"
              data-testid={`behavior-detail-toggle-${behaviorId}`}
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
              data.isHandled && 'opacity-70',
            )}
          >
            <div className="flex items-start gap-2 flex-wrap">
              <BucketBadge bucket={data.bucket} />
              {data.justifiable && <Badge variant="secondary">מוצדק</Badge>}
              <span className="text-xs text-muted-foreground ms-auto whitespace-nowrap">
                {formatShortDate(data.lessonDate)}
              </span>
            </div>
            <p className={cn('text-sm font-semibold text-foreground', data.isHandled && 'line-through')}>
              {data.achvaName}
            </p>
            <div className="flex gap-3 flex-wrap text-xs text-muted-foreground">
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
          </article>
        )}
      </div>
    </AppShell>
  );
}
