'use client';

import React from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { useFeedbackDialog } from '@/hooks/useFeedbackDialog';

/**
 * The feedback entry point: a header icon, and nothing else.
 *
 * A trigger only. `open`, `thanks`, the dialog and the thank-you banner live in
 * `FeedbackDialogProvider`, because the header has a second trigger below `sm`
 * (an item in its overflow menu) and both are in the DOM at once -- two copies
 * of this component owning that state would mean two live regions announcing
 * the same thank-you.
 *
 * Like the provider it calls no TanStack hook: it renders inside `AppHeader`,
 * whose own test mounts it with no `QueryClientProvider`, so a query hook here
 * rather than inside the dialog -- which mounts only while open -- would break
 * those tests and put a request on every page load.
 */
export function FeedbackLauncher() {
  const { openDialog } = useFeedbackDialog();

  return (
    <button
      type="button"
      data-testid="feedback-launcher-button"
      aria-label="שליחת משוב"
      onClick={openDialog}
      // `h-10 w-10` to match `ThemeToggle` and `RefreshButton`, its siblings in
      // the header's fixed `h-14` row. The old `h-9 w-9 -my-2` existed to keep
      // a 44px tap target from growing a 48px auto-height row; the row has a
      // fixed height now, so there is nothing to pull it back inside.
      className="icon-button h-10 w-10"
    >
      <MessageSquarePlus className="h-4 w-4" />
    </button>
  );
}
