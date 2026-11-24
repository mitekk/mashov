'use client';

import React from 'react';
import Link from 'next/link';
import { useMe } from '@/hooks/useAuth';
import { FeedbackLauncher } from '@/components/feedback/FeedbackLauncher';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { FeedbackDialogProvider } from '@/hooks/useFeedbackDialog';
import { useHeaderScroll } from '@/hooks/useHeaderScroll';
import { AppHeaderMenu } from './AppHeaderMenu';

function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join('');
}

/**
 * "· 2 ילדים" after the name, or nothing.
 *
 * The name itself arrives stripped of the credential's `[child class]` tag --
 * one child of one school, which this header showed above every school's
 * content. The count replaces it with the whole household.
 */
function childrenSuffix(childrenCount: number): string {
  if (childrenCount <= 0) return '';
  if (childrenCount === 1) return ' · ילד אחד';
  return ` · ${childrenCount} ילדים`;
}

/**
 * The one app-wide header: feedback, theme, household sync, and the profile
 * avatar.
 *
 * Theme and sync used to be copy-pasted into six page `<header>`s -- they are
 * household-wide actions (`useSyncRefresh()` takes no argument on purpose;
 * theme is a single context) sitting in per-page content, so every new page
 * had to remember to re-add them and theme.spec.ts carried a test whose whole
 * job was catching the page that forgot.
 *
 * Three things here are load-bearing:
 *
 * - **`z-40`.** `AppNav` and every dialog overlay are `z-50`, `Select` is
 *   `z-[70]`. At `z-50` this would float over an open modal.
 * - **`pt-safe` is here**, not on the `AppShell` wrapper: a `sticky top-0`
 *   element parks at the viewport top, under the notch, and the wrapper's
 *   padding sits above it and does nothing once stuck. That is only safe
 *   because this component NEVER returns null -- the shell always renders and
 *   only the avatar and `FeedbackLauncher` are gated on `me`. The fixed `h-14`
 *   is the other half: no layout shift when `me` resolves. `lg:pt-0` keeps the
 *   old behaviour -- at `lg` there is no status-bar overlay to clear.
 * - **`FreshnessBar` stays above this, non-sticky.** It scrolls away and the
 *   header then sticks to the viewport top, so there is no geometry to keep in
 *   sync between the two.
 */
export function AppHeader() {
  const { data: me } = useMe();
  const ref = useHeaderScroll<HTMLElement>();

  const initials = me?.displayName ? getInitials(me.displayName) : '?';
  const suffix = childrenSuffix(me?.childrenCount ?? 0);

  return (
    <FeedbackDialogProvider>
      <header
        ref={ref}
        data-testid="app-header"
        // `.app-header` is the hand-written rule in globals.css that turns
        // `--app-header-p` (written by useHeaderScroll, outside React) into
        // opacity and a translate. Without it the header is simply sticky.
        className="app-header sticky top-0 z-40 border-b border-border/60 bg-background/80 pt-safe backdrop-blur lg:pt-0"
      >
        <div className="flex h-14 items-center justify-end gap-2 px-4">
          {/* From `sm` up there is room for all three side by side. */}
          <div
            data-testid="app-header-inline"
            className="hidden items-center gap-2 sm:flex"
          >
            {/*
              Gated on `me` on purpose: feedback needs a household to attach
              itself to, so it is absent on `/auth/*` -- which has no header at
              all -- and for the one paint before `me` resolves.
            */}
            {me && <FeedbackLauncher />}
            <ThemeToggle />
            <RefreshButton />
          </div>

          {/* Below `sm` the same three collapse into one button. */}
          <AppHeaderMenu canSendFeedback={Boolean(me)} className="sm:hidden" />

          {me && (
            <Link
              href="/more"
              data-testid="header-profile-link"
              aria-label={`${me.displayName ?? 'פרופיל'}${suffix} — הגדרות`}
              className="flex items-center gap-2 rounded-full text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {me.displayName && (
                <span className="hidden text-xs font-medium sm:block">
                  {me.displayName}
                  {suffix}
                </span>
              )}
              <span className="flex h-8 w-8 select-none items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {initials}
              </span>
            </Link>
          )}
        </div>
      </header>
    </FeedbackDialogProvider>
  );
}
