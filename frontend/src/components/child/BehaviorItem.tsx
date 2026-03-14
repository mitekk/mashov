'use client';

import React from 'react';
import Link from 'next/link';
import { CheckCircle, Circle } from 'lucide-react';
import type { BehaviorItem as BehaviorItemType } from '@/types/api';
import { BucketBadge, Badge } from '@/components/ui/Badge';
import { formatShortDate } from '@/lib/dates';
import { getBucketColor } from '@/lib/behavior';
import { useMarkHandled } from '@/hooks/useReadState';
import { cn } from '@/lib/utils';

interface BehaviorItemProps {
  item: BehaviorItemType;
  studentGuid: string;
  detailHref?: string | null;
}

export function BehaviorItem({
  item,
  studentGuid,
  detailHref = null,
}: BehaviorItemProps) {
  const { markHandled, isPending } = useMarkHandled(
    'behavior',
    item.id,
    [['child-behavior', studentGuid], ['dashboard']],
  );

  const colors = getBucketColor(item.bucket);
  const content = (
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-2 flex-wrap mb-1">
        <BucketBadge bucket={item.bucket} />
        {item.justifiable && (
          <Badge variant="secondary">מוצדק</Badge>
        )}
        <span className="text-xs text-muted-foreground ms-auto whitespace-nowrap">
          {formatShortDate(item.lessonDate)}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{item.achvaName}</p>
      <div className="flex gap-3 mt-1 flex-wrap">
        {item.subject && (
          <span className="text-xs text-muted-foreground">{item.subject}</span>
        )}
        {item.reporter && (
          <span className="text-xs text-muted-foreground">{item.reporter}</span>
        )}
        {item.lesson !== null && (
          <span className="text-xs text-muted-foreground">שיעור {item.lesson}</span>
        )}
      </div>
      {item.remark && (
        <p className="text-xs text-muted-foreground mt-1 italic">{item.remark}</p>
      )}
    </div>
  );

  return (
    <div
      data-testid={`behavior-item-${item.id}`}
      className={cn(
        'card-base p-4 flex gap-3 items-start transition-opacity border-s-4',
        item.isHandled ? 'opacity-50' : 'opacity-100',
        colors.border,
      )}
    >
      {detailHref ? (
        <Link
          href={detailHref}
          data-testid={`behavior-item-link-${item.id}`}
          className="min-w-0 flex-1 rounded-xl p-1 transition-colors hover:bg-accent/30"
        >
          {content}
        </Link>
      ) : content}
      <button
        data-testid={`behavior-handle-${item.id}`}
        onClick={() => markHandled(!item.isHandled)}
        disabled={isPending}
        aria-label={item.isHandled ? 'בטל טיפול' : 'סמן כטופל'}
        className="flex-shrink-0 mt-0.5 text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
      >
        {item.isHandled ? (
          <CheckCircle className="w-5 h-5 text-primary" />
        ) : (
          <Circle className="w-5 h-5" />
        )}
      </button>
    </div>
  );
}
