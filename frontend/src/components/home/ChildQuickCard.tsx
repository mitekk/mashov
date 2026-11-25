'use client';

import React from 'react';
import Link from 'next/link';
import type { DashboardChildCard } from '@/types/api';
import { formatRelativeHe } from '@/lib/dates';
import { getPhase1HrefOrNull } from '@/lib/phase1-routes';
import { buildChildSectionHref } from '@/lib/child-routes';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import { ChildStatChips } from '@/components/children/ChildStatChips';
import { cn } from '@/lib/utils';

interface ChildQuickCardProps {
  child: DashboardChildCard;
}

export function ChildQuickCard({ child }: ChildQuickCardProps) {
  const { setSelectedChildGuid } = useSelectedChild();
  const safeHref = getPhase1HrefOrNull(
    buildChildSectionHref(child.studentGuid, 'homework'),
  );

  const positiveBehaviorCount = child.positiveBehaviorCount ?? 0;
  const neutralBehaviorCount = child.neutralBehaviorCount ?? 0;

  const content = (
    <>
      <div>
        <p className="text-sm font-semibold text-foreground truncate">
          {child.fullName}
        </p>
        <p className="text-xs text-muted-foreground">
          כיתה {child.classCode}{child.classNum}
        </p>
      </div>
      {/*
        The same pills the children list uses, in `tooltip` mode: icon +
        number, Hebrew label on hover and in the accessible name. Four
        labelled pills would take four lines in a 176px rail card.

        Measured at 360px, this widens the card from 176x121 to 219x127.5 --
        four `.chip-sm` pills are ~186px, wider than the `min-w-[176px]`
        floor, so the card grows instead of wrapping. Chosen deliberately
        over capping the width and spending 28px of height on a second pill
        row: the rail stays short, and one row scans faster than two.
      */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ChildStatChips
          testIdPrefix="child-card"
          labelMode="tooltip"
          studentGuid={child.studentGuid}
          homeworkCount={child.recentHomeworkCount}
          attentionCount={child.recentBehaviorCount}
          positiveCount={positiveBehaviorCount}
          neutralCount={neutralBehaviorCount}
        />
      </div>
      {child.latestUpdateAt && (
        <p className="text-3xs text-muted-foreground opacity-60">
          {formatRelativeHe(child.latestUpdateAt)}
        </p>
      )}
      {!safeHref && (
        <p className="text-2xs text-muted-foreground mt-1">
          קישור זה אינו זמין בשלב 1
        </p>
      )}
    </>
  );

  // The rail floor and its md release live HERE, on the card, not on the
  // parent's `.card-grid`: `@layer components` always loses to
  // `@layer utilities`, whatever the selector specificity, so a component
  // class could never override `min-w-[176px]` on this child.
  const className =
    'card-base tap-target flex min-w-[176px] flex-shrink-0 flex-col gap-2.5 border-border p-4 transition-colors md:w-auto md:min-w-0 md:flex-shrink';

  if (!safeHref) {
    return (
      <div
        data-testid={`child-card-disabled-${child.studentGuid}`}
        aria-disabled
        className={`${className} opacity-70 cursor-not-allowed`}
      >
        {content}
      </div>
    );
  }

  return (
    <Link
      href={safeHref}
      onClick={() => setSelectedChildGuid(child.studentGuid)}
      data-testid={`child-card-${child.studentGuid}`}
      className={cn(className, 'hover:bg-accent/40')}
    >
      {content}
    </Link>
  );
}
