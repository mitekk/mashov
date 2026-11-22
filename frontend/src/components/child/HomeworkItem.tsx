'use client';

import React from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Archive, Paperclip } from 'lucide-react';
import type { HomeworkItem as HomeworkItemType } from '@/types/api';
import { formatShortDate } from '@/lib/dates';
import { useMarkNew } from '@/hooks/useMarkNew';
import { useArchive } from '@/hooks/useArchive';
import { cn } from '@/lib/utils';

interface HomeworkItemProps {
  item: HomeworkItemType;
  studentGuid: string;
  detailHref?: string | null;
  selected?: boolean;
  onToggleSelect?: (homeworkId: string, checked: boolean) => void;
}

export function HomeworkItem({
  item,
  studentGuid,
  detailHref = null,
  selected = false,
  onToggleSelect,
}: HomeworkItemProps) {
  const invalidateKeys = [['child-homework', studentGuid], ['dashboard']];

  const { mutate: mutateMarkNew, isPending: isMarkNewPending } = useMarkNew({
    type: 'homework',
    id: item.id,
    studentGuid,
    invalidateKeys,
  });

  const { mutate: mutateArchive, isPending: isArchivePending } = useArchive({
    type: 'homework',
    id: item.id,
    studentGuid,
    invalidateKeys,
  });

  const content = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="flex-shrink-0 rounded-full border border-info/35 bg-info-subtle px-2 py-0.5 text-xs font-medium text-info">
          {item.subjectName}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatShortDate(item.lessonDate)}
        </span>
        {item.files.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Paperclip className="w-3 h-3" />
            {item.files.length}
          </span>
        )}
        {item.isNew && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            חדש
          </span>
        )}
      </div>
      <p className="text-sm text-foreground">
        {item.homeworkText}
      </p>
      {item.remark && (
        <p className="text-xs text-muted-foreground mt-1 italic">
          {item.remark}
        </p>
      )}
    </div>
  );

  return (
    <div
      data-testid={`homework-item-${item.id}`}
      className={cn(
        'card-base flex items-start gap-3 p-4',
        selected && 'border-primary/50 bg-primary/5',
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onToggleSelect?.(item.id, event.target.checked)}
        data-testid={`homework-select-${item.id}`}
        className="mt-1 h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
        aria-label="בחר שיעורי בית"
      />
      {detailHref ? (
        <Link
          href={detailHref}
          data-testid={`homework-item-link-${item.id}`}
          className="min-w-0 flex-1 rounded-xl p-1 transition-colors hover:bg-accent/30"
        >
          {content}
        </Link>
      ) : content}
      <div className="flex flex-col gap-1 flex-shrink-0 mt-0.5">
        {!item.isArchived && !item.isPastYear && (
          <button
            data-testid={`homework-mark-new-${item.id}`}
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
        {item.isPastYear ? (
          // No toggle: a past-year item is archived by derivation, so
          // restoring it would write a flag the API overrules and move
          // nothing. The badge says why it is here instead (ADR-0036).
          <span
            data-testid={`homework-past-year-${item.id}`}
            className="text-[10px] leading-tight text-muted-foreground whitespace-nowrap px-1"
          >
            שנה קודמת
          </span>
        ) : (
          <button
            data-testid={`homework-archive-${item.id}`}
            onClick={() => mutateArchive(!item.isArchived)}
            disabled={isArchivePending}
            aria-label={item.isArchived ? 'שחזר מארכיון' : 'העבר לארכיון'}
            className="text-muted-foreground hover:text-primary transition-colors tap-target flex items-center justify-center"
          >
            <Archive className={cn('w-4 h-4', item.isArchived && 'text-primary')} />
          </button>
        )}
      </div>
    </div>
  );
}
