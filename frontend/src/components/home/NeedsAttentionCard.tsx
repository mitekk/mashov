import React from 'react';
import Link from 'next/link';
import { Mail, AlertTriangle, BookOpen, AlertCircle } from 'lucide-react';
import type { NeedsAttentionItem } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import {
  buildBehaviorDetailHref,
  buildChildSectionHref,
  buildHomeworkDetailHref,
} from '@/lib/child-routes';

interface NeedsAttentionCardProps {
  item: NeedsAttentionItem;
}

function getTypeStyles(type: string | null | undefined): {
  border: string;
  icon: React.ReactNode;
  iconColor: string;
} {
  switch (type) {
    case 'new_conversation':
      return {
        border: 'border-s-4 border-s-info',
        icon: <Mail className="w-4 h-4" />,
        iconColor: 'text-info',
      };
    case 'negative_behavior':
      return {
        border: 'border-s-4 border-s-attention',
        icon: <AlertTriangle className="w-4 h-4" />,
        iconColor: 'text-attention',
      };
    case 'new_homework':
      return {
        border: 'border-s-4 border-s-border',
        icon: <BookOpen className="w-4 h-4" />,
        iconColor: 'text-muted-foreground',
      };
    case 'sync_degraded':
      return {
        border: 'border-s-4 border-s-destructive',
        icon: <AlertCircle className="w-4 h-4" />,
        iconColor: 'text-destructive',
      };
    default:
      return {
        border: 'border-s-4 border-s-border',
        icon: <AlertCircle className="w-4 h-4" />,
        iconColor: 'text-muted-foreground',
      };
  }
}

export function NeedsAttentionCard({ item }: NeedsAttentionCardProps) {
  const { border, icon, iconColor } = getTypeStyles(item.type);
  const resolvedHref = (() => {
    if (item.studentGuid) {
      if (item.type === 'new_homework') {
        return buildHomeworkDetailHref(item.studentGuid, item.id)
          ?? buildChildSectionHref(item.studentGuid, 'homework');
      }
      if (item.type === 'negative_behavior') {
        return buildBehaviorDetailHref(item.studentGuid, item.id)
          ?? buildChildSectionHref(item.studentGuid, 'behavior');
      }
      return buildChildSectionHref(item.studentGuid, 'homework');
    }

    if (typeof item.linkPath === 'string' && item.linkPath.trim().length > 0) {
      return item.linkPath;
    }
    return '/home';
  })();

  const safeHref = getPhase1HrefOrNull(resolvedHref);

  const className = cn(
    'card-base tap-target flex items-start gap-3 p-4 transition-colors',
    border,
    safeHref ? 'hover:bg-accent/40' : 'cursor-not-allowed opacity-70',
  );

  const content = (
    <>
      <span className={cn('mt-0.5 flex-shrink-0', iconColor)}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-foreground truncate">
            {item.title}
          </p>
          <span className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap">
            {formatRelativeHe(item.timestamp)}
          </span>
        </div>
        {item.studentName && (
          <p className="text-xs text-muted-foreground mt-0.5">{item.studentName}</p>
        )}
        {item.summary && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {item.summary}
          </p>
        )}
        {!safeHref && (
          <p className="text-[11px] text-muted-foreground mt-1">
            קישור זה אינו זמין בשלב 1
          </p>
        )}
      </div>
    </>
  );

  if (safeHref) {
    return (
      <Link
        href={safeHref}
        data-testid={`attention-card-${item.id}`}
        className={className}
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      data-testid={`attention-card-disabled-${item.id}`}
      aria-disabled
      className={className}
    >
      {content}
    </div>
  );
}
