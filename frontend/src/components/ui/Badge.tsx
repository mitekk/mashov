import React from 'react';
import { cn } from '@/lib/utils';
import type { FeedSourceType, BehaviorBucket } from '@/types/api';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'secondary' | 'attention' | 'positive' | 'info' | 'neutral';
  size?: 'sm' | 'md';
  className?: string;
}

const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-primary/10 text-primary border-primary/20',
  secondary: 'bg-secondary text-secondary-foreground border-border',
  attention: 'bg-amber-50 text-amber-700 border-amber-200',
  positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  neutral: 'bg-slate-50 text-slate-600 border-slate-200',
};

export function Badge({
  children,
  variant = 'default',
  size = 'sm',
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SourceTypeBadge({ type }: { type: FeedSourceType }) {
  const labels: Record<FeedSourceType, string> = {
    homework: 'שיעורי בית',
    behavior: 'התנהגות',
    mail: 'דואר',
    positive: 'חיזוק חיובי',
  };

  const variants: Record<FeedSourceType, BadgeProps['variant']> = {
    homework: 'info',
    behavior: 'attention',
    mail: 'default',
    positive: 'positive',
  };

  return (
    <Badge variant={variants[type]}>
      {labels[type]}
    </Badge>
  );
}

export function BucketBadge({ bucket }: { bucket: BehaviorBucket }) {
  const labels: Record<BehaviorBucket, string> = {
    attention: 'תשומת לב',
    positive: 'חיובי',
    neutral: 'ניטרלי',
  };

  const variants: Record<BehaviorBucket, BadgeProps['variant']> = {
    attention: 'attention',
    positive: 'positive',
    neutral: 'neutral',
  };

  return (
    <Badge variant={variants[bucket]}>
      {labels[bucket]}
    </Badge>
  );
}
