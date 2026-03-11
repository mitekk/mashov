'use client';

import React from 'react';
import { CheckCircle, Circle, Paperclip } from 'lucide-react';
import type { HomeworkItem as HomeworkItemType } from '@/types/api';
import { formatShortDate } from '@/lib/dates';
import { useMarkHandled } from '@/hooks/useReadState';
import { cn } from '@/lib/utils';

interface HomeworkItemProps {
  item: HomeworkItemType;
  studentGuid: string;
}

export function HomeworkItem({ item, studentGuid }: HomeworkItemProps) {
  const { markHandled, isPending } = useMarkHandled(
    'homework',
    item.id,
    [['child-homework', studentGuid], ['dashboard']],
  );

  return (
    <div
      data-testid={`homework-item-${item.id}`}
      className={cn(
        'card-base p-4 flex gap-3 items-start transition-opacity',
        item.isHandled ? 'opacity-50' : 'opacity-100',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-xs font-medium text-primary bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full flex-shrink-0">
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
        </div>
        <p
          className={cn(
            'text-sm text-foreground',
            item.isHandled && 'line-through',
          )}
        >
          {item.homeworkText}
        </p>
        {item.remark && (
          <p className="text-xs text-muted-foreground mt-1 italic">
            {item.remark}
          </p>
        )}
      </div>
      <button
        data-testid={`homework-handle-${item.id}`}
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
