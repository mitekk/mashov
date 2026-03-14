'use client';

import React from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Archive } from 'lucide-react';
import type { FeedItem as FeedItemType } from '@/types/api';
import { SourceTypeBadge } from '@/components/ui/Badge';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useMarkNew } from '@/hooks/useMarkNew';
import { useArchive } from '@/hooks/useArchive';
import { useArchive as useMailArchive } from '@/hooks/useMail';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import { buildBehaviorDetailHref, buildChildSectionHref, buildHomeworkDetailHref } from '@/lib/child-routes';

interface FeedItemProps {
  item: FeedItemType;
}

function getSafeFeedHref(item: FeedItemType): string | null {
  if (item.studentGuid) {
    if (item.sourceType === 'homework') {
      const detailHref = buildHomeworkDetailHref(item.studentGuid, item.sourceId);
      if (detailHref) return detailHref;
      return buildChildSectionHref(item.studentGuid, 'homework');
    }
    if (item.sourceType === 'behavior' || item.sourceType === 'positive') {
      const detailHref = buildBehaviorDetailHref(item.studentGuid, item.sourceId);
      if (detailHref) return detailHref;
      return buildChildSectionHref(item.studentGuid, 'behavior');
    }
  }

  if (typeof item.linkPath === 'string' && item.linkPath.trim().length > 0) {
    return getPhase1HrefOrNull(item.linkPath);
  }

  if (item.sourceType === 'mail') return '/inbox';

  if (item.studentGuid) return buildChildSectionHref(item.studentGuid, 'homework');

  return '/home';
}

export function FeedItem({ item }: FeedItemProps) {
  const isMailItem = item.sourceType === 'mail';
  const isArchivable = item.sourceType === 'homework' || item.sourceType === 'behavior' || item.sourceType === 'positive';

  const markNewKeys = isMailItem
    ? [['dashboard'], ['conversations'], ['conversation', item.sourceId]]
    : [['dashboard']];

  const { mutate: mutateMarkNew, isPending: isMarkNewPending } = useMarkNew({
    type: isMailItem ? 'conversation' : (item.sourceType === 'homework' ? 'homework' : 'behavior'),
    id: isMailItem ? item.sourceId : item.id,
    studentGuid: item.studentGuid ?? undefined,
    invalidateKeys: markNewKeys,
  });

  const archiveInvalidateKeys = [['dashboard']];
  const { mutate: mutateArchive, isPending: isArchivePending } = useArchive({
    type: item.sourceType === 'homework' ? 'homework' : 'behavior',
    id: item.id,
    studentGuid: item.studentGuid ?? '',
    invalidateKeys: archiveInvalidateKeys,
  });

  const { mutate: mutateMailArchive, isPending: isMailArchivePending } = useMailArchive();

  const safeHref = getPhase1HrefOrNull(getSafeFeedHref(item));

  return (
    <div
      data-testid={`feed-item-${item.id}`}
      className="card-base p-4 flex gap-3 items-start"
    >
      <div className="flex-1 min-w-0">
        {safeHref ? (
          <Link href={safeHref} className="block group">
            <div className="flex items-start gap-2 mb-1">
              <SourceTypeBadge type={item.sourceType} />
              <span className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap me-auto">
                {formatRelativeHe(item.eventAt)}
              </span>
            </div>
            <p
              className={cn(
                'text-sm text-foreground truncate group-hover:underline',
                item.isNew ? 'font-semibold' : 'font-normal',
              )}
            >
              {item.title}
            </p>
            {item.summary && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                {item.summary}
              </p>
            )}
            {item.studentName && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {item.studentName}
              </p>
            )}
          </Link>
        ) : (
          <div
            data-testid={`feed-item-disabled-${item.id}`}
            aria-disabled
            className="block opacity-70 cursor-not-allowed"
          >
            <div className="flex items-start gap-2 mb-1">
              <SourceTypeBadge type={item.sourceType} />
              <span className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap me-auto">
                {formatRelativeHe(item.eventAt)}
              </span>
            </div>
            <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
            {item.summary && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                {item.summary}
              </p>
            )}
            {item.studentName && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {item.studentName}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">
              קישור זה אינו זמין בשלב 1
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0 mt-0.5">
        <button
          data-testid={`feed-item-mark-new-${item.id}`}
          onClick={() => mutateMarkNew(!item.isNew)}
          disabled={isMarkNewPending}
          aria-label={item.isNew ? 'סמן כנקרא' : 'סמן כחדש'}
          className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
        >
          {item.isNew ? (
            <Eye className="w-5 h-5 text-primary" />
          ) : (
            <EyeOff className="w-5 h-5" />
          )}
        </button>
        {isArchivable && (
          <button
            data-testid={`feed-item-archive-${item.id}`}
            onClick={() => mutateArchive(!item.isArchived)}
            disabled={isArchivePending}
            aria-label={item.isArchived ? 'שחזר מארכיון' : 'העבר לארכיון'}
            className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
          >
            <Archive className={cn('w-4 h-4', item.isArchived && 'text-primary')} />
          </button>
        )}
        {isMailItem && (
          <button
            data-testid={`feed-item-archive-${item.id}`}
            onClick={() => mutateMailArchive([item.sourceId])}
            disabled={isMailArchivePending}
            aria-label="העבר לארכיון"
            className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
          >
            <Archive className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
