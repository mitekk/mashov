'use client';

import React from 'react';
import Link from 'next/link';
import { CheckCircle, Circle } from 'lucide-react';
import type { FeedItem as FeedItemType } from '@/types/api';
import { SourceTypeBadge } from '@/components/ui/Badge';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useMarkHandled } from '@/hooks/useReadState';

interface FeedItemProps {
  item: FeedItemType;
}

export function FeedItem({ item }: FeedItemProps) {
  const { markHandled, isPending } = useMarkHandled(
    'feed_item',
    item.id,
    [['dashboard']],
  );

  const isHandled = item.isHandled;

  return (
    <div
      data-testid={`feed-item-${item.id}`}
      className={cn(
        'card-base p-4 flex gap-3 items-start transition-opacity',
        isHandled ? 'opacity-50' : 'opacity-100',
      )}
    >
      <div className="flex-1 min-w-0">
        <Link href={item.linkPath} className="block group">
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
