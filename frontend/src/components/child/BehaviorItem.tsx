'use client';

import React from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Archive } from 'lucide-react';
import type { BehaviorItem as BehaviorItemType } from '@/types/api';
import { BucketBadge, Badge } from '@/components/ui/Badge';
import { formatShortDate } from '@/lib/dates';
import { getBucketColor } from '@/lib/behavior';
import { useMarkNew } from '@/hooks/useMarkNew';
import { useArchive } from '@/hooks/useArchive';
import { cn } from '@/lib/utils';

interface BehaviorItemProps {
  item: BehaviorItemType;
  studentGuid: string;
  detailHref?: string | null;
  selected?: boolean;
  onToggleSelect?: (behaviorId: string, checked: boolean) => void;
}

export function BehaviorItem({
  item,
  studentGuid,
  detailHref = null,
  selected = false,
  onToggleSelect,
}: BehaviorItemProps) {
  const invalidateKeys = [['child-behavior', studentGuid], ['dashboard']];

  const { mutate: mutateMarkNew, isPending: isMarkNewPending } = useMarkNew({
    type: 'behavior',
    id: item.id,
    studentGuid,
    invalidateKeys,
  });

  const { mutate: mutateArchive, isPending: isArchivePending } = useArchive({
    type: 'behavior',
    id: item.id,
    studentGuid,
    invalidateKeys,
  });

  const colors = getBucketColor(item.bucket);
  const content = (
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-2 flex-wrap mb-1">
        <BucketBadge bucket={item.bucket} />
        {item.justifiable && (
          <Badge variant="secondary">מוצדק</Badge>
        )}
        {item.isNew && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            חדש
          </span>
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
        'card-base p-4 flex gap-3 items-start border-s-4',
        colors.border,
        selected && 'border-primary/50 bg-primary/5',
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onToggleSelect?.(item.id, event.target.checked)}
        data-testid={`behavior-select-${item.id}`}
        className="mt-1 h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
        aria-label="בחר אירוע התנהגות"
      />
      {detailHref ? (
        <Link
          href={detailHref}
          data-testid={`behavior-item-link-${item.id}`}
          className="min-w-0 flex-1 rounded-xl p-1 transition-colors hover:bg-accent/30"
        >
          {content}
        </Link>
      ) : content}
      <div className="flex flex-col gap-1 flex-shrink-0 mt-0.5">
        {!item.isArchived && (
          <button
            data-testid={`behavior-mark-new-${item.id}`}
            onClick={() => mutateMarkNew(!item.isNew)}
            disabled={isMarkNewPending}
            aria-label={item.isNew ? 'סמן כנקרא' : 'סמן כלא נקרא'}
            className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
          >
            {item.isNew ? (
              <Eye className="w-5 h-5 text-primary" />
            ) : (
              <EyeOff className="w-5 h-5" />
            )}
          </button>
        )}
        <button
          data-testid={`behavior-archive-${item.id}`}
          onClick={() => mutateArchive(!item.isArchived)}
          disabled={isArchivePending}
          aria-label={item.isArchived ? 'שחזר מארכיון' : 'העבר לארכיון'}
          className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
        >
          <Archive className={cn('w-4 h-4', item.isArchived && 'text-primary')} />
        </button>
      </div>
    </div>
  );
}
