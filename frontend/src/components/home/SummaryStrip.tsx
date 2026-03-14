'use client';

import React from 'react';
import Link from 'next/link';
import { BookOpen, AlertTriangle } from 'lucide-react';
import type { DashboardSummary } from '@/types/api';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import { getChildrenNavHref } from '@/lib/child-routes';
import { useDashboard } from '@/hooks/useDashboard';

interface SummaryStripProps {
  summary: DashboardSummary;
}

interface ChipProps {
  icon: React.ReactNode;
  count: number;
  label: string;
  href: string;
  variant?: 'default' | 'attention' | 'positive' | 'info';
}

function SummaryChip({ icon, count, label, href, variant = 'default' }: ChipProps) {
  const variantStyles = {
    default: 'bg-secondary/80 text-secondary-foreground border-border',
    attention: 'bg-attention-subtle text-attention border-attention/35',
    positive: 'bg-positive-subtle text-positive border-positive/35',
    info: 'bg-info-subtle text-info border-info/35',
  };

  return (
    <Link
      href={href}
      className={`tap-target flex flex-shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors hover:bg-accent ${variantStyles[variant]}`}
    >
      <span className="w-4 h-4 flex-shrink-0">{icon}</span>
      <span className="font-semibold tabular-nums">{count}</span>
      <span className="text-xs opacity-80">{label}</span>
    </Link>
  );
}

export function SummaryStrip({ summary }: SummaryStripProps) {
  const { selectedChildGuid } = useSelectedChild();
  const { data } = useDashboard();
  const selectedChildExists = Boolean(
    selectedChildGuid
    && data?.children.some((child) => child.studentGuid === selectedChildGuid),
  );
  const effectiveSelectedChildGuid = selectedChildExists ? selectedChildGuid : null;

  const homeworkHref = getChildrenNavHref(effectiveSelectedChildGuid, 'homework');
  const behaviorHref = getChildrenNavHref(effectiveSelectedChildGuid, 'behavior');

  return (
    <div
      data-testid="summary-strip"
      className="flex gap-2 overflow-x-auto py-1 scrollbar-hide"
      style={{ scrollbarWidth: 'none' }}
    >
      <SummaryChip
        icon={<BookOpen className="w-4 h-4" />}
        count={summary.recentHomeworkCount}
        label="שיעורי בית"
        href={homeworkHref}
        variant="default"
      />
      <SummaryChip
        icon={<AlertTriangle className="w-4 h-4" />}
        count={summary.recentBehaviorCount}
        label="התנהגות"
        href={behaviorHref}
        variant={summary.recentBehaviorCount > 0 ? 'attention' : 'default'}
      />
    </div>
  );
}
