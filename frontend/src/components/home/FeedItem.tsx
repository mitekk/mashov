'use client';

import React from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Archive, Paperclip } from 'lucide-react';
import type { FeedItem as FeedItemType } from '@/types/api';
import { SourceTypeBadge } from '@/components/ui/Badge';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useMarkNew } from '@/hooks/useMarkNew';
import { useArchive } from '@/hooks/useArchive';
import { useArchive as useMailArchive, useUnarchive as useMailUnarchive } from '@/hooks/useMail';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import { buildBehaviorDetailHref, buildChildSectionHref, buildHomeworkDetailHref } from '@/lib/child-routes';

interface FeedItemProps {
  item: FeedItemType;
  forceRestoreOnly?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string, checked: boolean) => void;
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

export function FeedItem({
  item,
  forceRestoreOnly = false,
  selected = false,
  onToggleSelect,
}: FeedItemProps) {
  const isMailItem = item.sourceType === 'mail';
  const isArchivable = item.sourceType === 'homework' || item.sourceType === 'behavior' || item.sourceType === 'positive';
  const canToggleReadState = !item.isArchived && !forceRestoreOnly;

  const markNewKeys = isMailItem
    ? [['dashboard'], ['conversations'], ['conversation', item.sourceId]]
    : [
        ['dashboard'],
        ...(item.studentGuid ? [['child-behavior', item.studentGuid]] : []),
        ...(item.studentGuid ? [['child-homework', item.studentGuid]] : []),
      ];

  const { mutate: mutateMarkNew, isPending: isMarkNewPending } = useMarkNew({
    type: isMailItem ? 'conversation' : (item.sourceType === 'homework' ? 'homework' : 'behavior'),
    id: isMailItem ? item.sourceId : item.id,
    studentGuid: item.studentGuid ?? undefined,
    invalidateKeys: markNewKeys,
  });

  const archiveInvalidateKeys = [
    ['dashboard'],
    ...(item.studentGuid ? [['child-behavior', item.studentGuid]] : []),
    ...(item.studentGuid ? [['child-homework', item.studentGuid]] : []),
  ];
  const { mutate: mutateArchive, isPending: isArchivePending } = useArchive({
    type: item.sourceType === 'homework' ? 'homework' : 'behavior',
    id: item.id,
    studentGuid: item.studentGuid ?? '',
    invalidateKeys: archiveInvalidateKeys,
  });

  const { mutate: mutateMailArchive, isPending: isMailArchivePending } = useMailArchive();
  const { mutate: mutateMailUnarchive, isPending: isMailUnarchivePending } = useMailUnarchive();

  const safeHref = getPhase1HrefOrNull(getSafeFeedHref(item));

  return (
    <div
      data-testid={`feed-item-${item.id}`}
      className={cn(
        'card-base p-4 flex gap-3 items-start',
        selected && 'border-primary/50 bg-primary/5',
      )}
    >
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onToggleSelect(item.id, event.target.checked)}
          data-testid={`feed-select-${item.id}`}
          className="mt-1 h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
          aria-label="בחר עדכון"
        />
      )}
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
            {item.hasAttachments && (
              <p className="mt-1 inline-flex items-center gap-1 text-2xs text-muted-foreground">
                <Paperclip className="h-3 w-3" />
                <span>קבצים מצורפים</span>
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
            {item.hasAttachments && (
              <p className="mt-1 inline-flex items-center gap-1 text-2xs text-muted-foreground">
                <Paperclip className="h-3 w-3" />
                <span>קבצים מצורפים</span>
              </p>
            )}
            <p className="text-2xs text-muted-foreground mt-1">
              קישור זה אינו זמין בשלב 1
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0 mt-0.5">
        {canToggleReadState && (
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
        )}
        {isArchivable && (
          <button
            data-testid={`feed-item-archive-${item.id}`}
            onClick={() => mutateArchive(forceRestoreOnly ? false : !item.isArchived)}
            disabled={isArchivePending}
            aria-label={item.isArchived || forceRestoreOnly ? 'שחזר מארכיון' : 'העבר לארכיון'}
            className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
          >
            <Archive className={cn('w-4 h-4', (item.isArchived || forceRestoreOnly) && 'text-primary')} />
          </button>
        )}
        {isMailItem && (
          <button
            data-testid={`feed-item-archive-${item.id}`}
            onClick={() => {
              if (item.isArchived || forceRestoreOnly) {
                mutateMailUnarchive([item.sourceId]);
                return;
              }
              mutateMailArchive([item.sourceId]);
            }}
            disabled={isMailArchivePending || isMailUnarchivePending}
            aria-label={item.isArchived || forceRestoreOnly ? 'שחזר מארכיון' : 'העבר לארכיון'}
            className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
          >
            <Archive className={cn('w-4 h-4', (item.isArchived || forceRestoreOnly) && 'text-primary')} />
          </button>
        )}
      </div>
    </div>
  );
}
