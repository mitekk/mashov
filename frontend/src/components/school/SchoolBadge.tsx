'use client';

import React from 'react';
import { School } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { useMe } from '@/hooks/useAuth';

interface SchoolBadgeProps {
  /** The short label the server resolved; `null` for an unowned item. */
  schoolShortLabel: string | null | undefined;
  /** The full name, for the tooltip. */
  schoolName?: string | null;
  testId?: string;
  className?: string;
}

/**
 * Which school an item belongs to.
 *
 * Renders `null` below two connected schools, and reads `me` itself to decide.
 * Self-hiding avoids prop-drilling a boolean through ChildrenPageClient ->
 * ChildCard, HomePageClient -> ChildQuickCard and InboxPageClient ->
 * ConversationItem, and `['me']` is already cached by the app shell, so it
 * costs nothing. The upshot is that a one-school household's DOM is unchanged.
 *
 * Icon and text, never colour alone: the domain tokens (attention, positive,
 * info) already carry meaning here, and .claude/rules/frontend.md forbids
 * colour as the only channel.
 */
export function SchoolBadge({
  schoolShortLabel,
  schoolName,
  testId,
  className,
}: SchoolBadgeProps) {
  const { data: me } = useMe();

  if (!schoolShortLabel) return null;
  if ((me?.schools?.length ?? 0) < 2) return null;

  return (
    <Badge
      variant="neutral"
      className={className}
      // Not a title on the Badge's own span: the full school name is the
      // thing a truncated label needs to reveal.
    >
      <School className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      <span
        data-testid={testId ?? 'school-badge'}
        title={schoolName ?? schoolShortLabel}
        className="truncate max-w-[6rem]"
      >
        {schoolShortLabel}
      </span>
    </Badge>
  );
}
