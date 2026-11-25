'use client';

import React from 'react';
import { AlertTriangle, BookOpen, Info, ThumbsUp } from 'lucide-react';
import { getBucketLabel } from '@/lib/behavior';
import { cn } from '@/lib/utils';

interface ChildStatChipsProps {
  /** Which card this row sits in; prefixes every testid. */
  testIdPrefix: 'child-list' | 'child-card';
  /**
   * `inline` prints the label in the pill; `tooltip` shows icon + number and
   * puts the label on hover and in the accessible name. The home rail's cards
   * have a 176px floor, where four labelled pills take four lines.
   */
  labelMode?: 'inline' | 'tooltip';
  studentGuid: string;
  homeworkCount: number;
  attentionCount: number;
  positiveCount: number;
  neutralCount: number;
}

/**
 * The four counts on a children-list card.
 *
 * This replaces a `flex gap-4 text-xs` row of four shrinkable spans. In the
 * ~300px content column of a card that row had no wrap control, so the spans
 * shrank below their own label width and Hebrew broke mid-phrase (שיעורי /
 * בית) while the icons lost their baseline. `.chip-sm` is
 * `whitespace-nowrap`, so the row now wraps BETWEEN pills and never inside a
 * label.
 *
 * The other half is contrast carrying the meaning: in the old row a 0 and a 3
 * looked identical, which is noise exactly where the card's whole job is
 * "which child needs me". A zero is quiet (border only, muted text); a
 * non-zero takes the subtle colour pair its bucket uses on the child hero
 * chips, one size down. Neutral -- attendance the school logged -- gets a
 * plain filled pill rather than a colour: informative, not alarming.
 */
export function ChildStatChips({
  testIdPrefix,
  labelMode = 'inline',
  studentGuid,
  homeworkCount,
  attentionCount,
  positiveCount,
  neutralCount,
}: ChildStatChipsProps) {
  const quiet = 'border-border/60 text-muted-foreground';

  const homeworkLabel = 'שיעורי בית';
  const attentionLabel = getBucketLabel('attention');
  const positiveLabel = 'חיוביים';
  const neutralLabel = getBucketLabel('neutral');

  // `inline` output must stay byte-identical -- it is already verified -- so
  // `title`/`aria-label` exist only in `tooltip` mode. Without the
  // `aria-label` a label-less pill is announced as a bare number.
  const labelProps = (count: number, label: string) =>
    labelMode === 'tooltip' ? { title: label, 'aria-label': `${count} ${label}` } : {};
  const inlineLabel = (label: string) => (labelMode === 'inline' ? ` ${label}` : '');

  return (
    <>
      <span
        data-testid={`${testIdPrefix}-homework-count-${studentGuid}`}
        {...labelProps(homeworkCount, homeworkLabel)}
        className={cn(
          'chip-sm',
          homeworkCount > 0 ? 'border-info/35 bg-info-subtle text-info font-semibold' : quiet,
        )}
      >
        <BookOpen className="h-3.5 w-3.5" />
        {homeworkCount}{inlineLabel(homeworkLabel)}
      </span>
      <span
        data-testid={`${testIdPrefix}-negative-count-${studentGuid}`}
        {...labelProps(attentionCount, attentionLabel)}
        className={cn(
          'chip-sm',
          attentionCount > 0
            ? 'border-attention/35 bg-attention-subtle text-attention font-semibold'
            : quiet,
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {attentionCount}{inlineLabel(attentionLabel)}
      </span>
      <span
        data-testid={`${testIdPrefix}-positive-count-${studentGuid}`}
        {...labelProps(positiveCount, positiveLabel)}
        className={cn(
          'chip-sm',
          positiveCount > 0
            ? 'border-positive/35 bg-positive-subtle text-positive font-semibold'
            : quiet,
        )}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
        {positiveCount}{inlineLabel(positiveLabel)}
      </span>
      {/* Attendance: its own pill, not part of the amber one. */}
      <span
        data-testid={`${testIdPrefix}-neutral-count-${studentGuid}`}
        {...labelProps(neutralCount, neutralLabel)}
        className={cn(
          'chip-sm',
          neutralCount > 0 ? 'border-border bg-muted text-foreground font-semibold' : quiet,
        )}
      >
        <Info className="h-3.5 w-3.5" />
        {neutralCount}{inlineLabel(neutralLabel)}
      </span>
    </>
  );
}
