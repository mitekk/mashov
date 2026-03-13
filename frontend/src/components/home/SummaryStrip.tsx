'use client';

import React from 'react';
import Link from 'next/link';
import { Mail, BookOpen, AlertTriangle, Users } from 'lucide-react';
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
    default: 'bg-secondary text-secondary-foreground border-border',
    attention: 'bg-amber-50 text-amber-700 border-amber-200',
    positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    info: 'bg-blue-50 text-blue-700 border-blue-200',
  };

  return (
    <Link
      href={href}
      className={`flex items-center gap-2 px-3 py-2 rounded-full border text-sm font-medium flex-shrink-0 tap-target transition-opacity hover:opacity-80 ${variantStyles[variant]}`}
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
  const childrenHref = getChildrenNavHref(effectiveSelectedChildGuid, 'homework');

  return (
    <div
      data-testid="summary-strip"
      className="flex gap-2 overflow-x-auto px-4 py-3 -mx-0 scrollbar-hide"
      style={{ scrollbarWidth: 'none' }}
    >
      <SummaryChip
        icon={<Mail className="w-4 h-4" />}
        count={summary.unreadConversations}
        label="הודעות"
        href="/inbox"
        variant={summary.unreadConversations > 0 ? 'info' : 'default'}
      />
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
      <SummaryChip
        icon={<Users className="w-4 h-4" />}
        count={summary.childrenCount}
        label="ילדים"
        href={childrenHref}
        variant="default"
      />
    </div>
  );
}
