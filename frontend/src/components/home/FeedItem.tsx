'use client';

import React from 'react';
import Link from 'next/link';
import { CheckCircle, Circle } from 'lucide-react';
import type { FeedItem as FeedItemType } from '@/types/api';
import { SourceTypeBadge } from '@/components/ui/Badge';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useMarkHandled } from '@/hooks/useReadState';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import { buildChildSectionHref } from '@/lib/child-routes';

interface FeedItemProps {
  item: FeedItemType;
}

function getSafeFeedHref(item: FeedItemType): string | null {
  if (item.studentGuid) {
    if (item.sourceType === 'homework') {
      return buildChildSectionHref(item.studentGuid, 'homework');
    }
    if (item.sourceType === 'behavior' || item.sourceType === 'positive') {
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
  const { markHandled, isPending } = useMarkHandled(
    isMailItem ? 'mail_conversation' : 'feed_item',
    isMailItem ? item.sourceId : item.id,
    isMailItem
      ? [['dashboard'], ['conversations'], ['conversation', item.sourceId]]
      : [['dashboard']],
  );

  const isHandled = item.isHandled;
  const safeHref = getPhase1HrefOrNull(getSafeFeedHref(item));

  return (
    <div
      data-testid={`feed-item-${item.id}`}
      className={cn(
        'card-base p-4 flex gap-3 items-start transition-opacity',
        isHandled ? 'opacity-50' : 'opacity-100',
      )}
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
                'text-sm font-medium text-foreground truncate group-hover:underline',
                !item.isUnread && 'font-normal',
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
      <button
        data-testid={`mark-handled-${item.id}`}
        onClick={() => markHandled(!isHandled)}
        disabled={isPending}
        aria-label={isHandled ? 'בטל טיפול' : 'סמן כטופל'}
        className="flex-shrink-0 mt-0.5 text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
      >
        {isHandled ? (
          <CheckCircle className="w-5 h-5 text-primary" />
        ) : (
          <Circle className="w-5 h-5" />
        )}
      </button>
    </div>
  );
}
