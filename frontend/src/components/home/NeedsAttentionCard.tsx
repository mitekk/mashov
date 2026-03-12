import React from 'react';
import Link from 'next/link';
import { Mail, AlertTriangle, BookOpen, AlertCircle } from 'lucide-react';
import type { NeedsAttentionItem } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface NeedsAttentionCardProps {
  item: NeedsAttentionItem;
}

function getTypeStyles(type: string | null | undefined): {
  border: string;
  icon: React.ReactNode;
  iconColor: string;
} {
  switch (type) {
    case 'unread_conversation':
      return {
        border: 'border-s-4 border-s-blue-500',
        icon: <Mail className="w-4 h-4" />,
        iconColor: 'text-blue-500',
      };
    case 'negative_behavior':
      return {
        border: 'border-s-4 border-s-amber-500',
        icon: <AlertTriangle className="w-4 h-4" />,
        iconColor: 'text-amber-500',
      };
    case 'unhandled_homework':
      return {
        border: 'border-s-4 border-s-slate-400',
        icon: <BookOpen className="w-4 h-4" />,
        iconColor: 'text-slate-500',
      };
    case 'sync_degraded':
      return {
        border: 'border-s-4 border-s-red-400',
        icon: <AlertCircle className="w-4 h-4" />,
        iconColor: 'text-red-400',
      };
    default:
      return {
        border: 'border-s-4 border-s-slate-300',
        icon: <AlertCircle className="w-4 h-4" />,
        iconColor: 'text-slate-500',
      };
  }
}

export function NeedsAttentionCard({ item }: NeedsAttentionCardProps) {
  const { border, icon, iconColor } = getTypeStyles(item.type);
  const safeHref =
    typeof item.linkPath === 'string' && item.linkPath.trim().length > 0
      ? item.linkPath
      : '/home';

  return (
    <Link
      href={safeHref}
      data-testid={`attention-card-${item.id}`}
      className={cn(
        'card-base p-4 flex gap-3 items-start tap-target hover:bg-accent/30 transition-colors',
        border,
      )}
    >
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
      </div>
    </Link>
  );
}
