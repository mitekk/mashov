'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useMe } from '@/hooks/useAuth';
import { useDashboard } from '@/hooks/useDashboard';
import { UnreadBadge } from '@/components/inbox/UnreadBadge';
import { FeedbackDialogProvider } from '@/hooks/useFeedbackDialog';
import { useHeaderScroll } from '@/hooks/useHeaderScroll';
import { AppHeaderMenu } from './AppHeaderMenu';
import { HeaderChildSwitcher } from './HeaderChildSwitcher';
import { resolveHeaderTitle } from './headerTitles';
import { NAV_ITEMS, isNavItemActive, type NavItem } from './navItems';

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
 * The nav entry whose unread counter the דואר title carries.
 *
 * Resolved, not asserted: this header is in `AppShell` on every authenticated
 * route, so a rename of the inbox href that left this `undefined` would throw
 * inside `isNavItemActive` and white-screen the whole app rather than just
 * drop a badge.
 */
const INBOX_ITEM: NavItem | undefined = NAV_ITEMS.find((item) => item.href === '/inbox');

/**
 * The one app-wide header: the page title, and the profile avatar that opens
 * `AppHeaderMenu` -- where feedback, theme, household sync and הגדרות live.
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
 *   because this component NEVER returns null -- the shell always renders, and
 *   nothing in the row is gated on `me`: the avatar falls back to `?` and only
 *   the menu's feedback item waits for a household. The fixed `h-14` is the
 *   other half: no layout shift when `me` resolves. `lg:pt-0` keeps the old
 *   behaviour -- at `lg` there is no status-bar overlay to clear.
 * - **`FreshnessBar` stays above this, non-sticky.** It scrolls away and the
 *   header then sticks to the viewport top, so there is no geometry to keep in
 *   sync between the two.
 */
export function AppHeader() {
  const { data: me } = useMe();
  const pathname = usePathname() ?? '';
  const { data: dashboard } = useDashboard();
  const ref = useHeaderScroll<HTMLElement>();

  const initials = me?.displayName ? getInitials(me.displayName) : '?';
  const suffix = childrenSuffix(me?.childrenCount ?? 0);
  const title = resolveHeaderTitle(pathname);
  const unreadCount = dashboard?.summary?.newConversations ?? 0;
  const showsUnread = INBOX_ITEM !== undefined
    && isNavItemActive(INBOX_ITEM, pathname)
    && unreadCount > 0;

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
        <div className="flex h-14 items-center gap-2 px-4">
          {/*
            `flex-1` here is what pushes the action cluster to the end of the
            row, so dropping `justify-end` above changes no action's position.
          */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {title && (
              /*
                `aria-hidden` is deliberate, and so is this being a `<span>`.
                `useHeaderScroll` marks the whole header `inert` once it has
                faded out, so an `<h1>` living here would leave the a11y tree
                mid-scroll and the document would lose its heading. Each page
                keeps its own `<h1 className="sr-only">` instead: structure
                survives the fade, and the title is not announced twice.
              */
              <span
                data-testid="app-header-title"
                aria-hidden="true"
                className="truncate text-lg font-semibold tracking-tight text-foreground"
              >
                {title}
              </span>
            )}
            {/* Rides along with the דואר title -- same counter `AppNav`'s own
                badge reads, so the two can never disagree. */}
            {showsUnread && <UnreadBadge count={unreadCount} />}
            <HeaderChildSwitcher />
          </div>

          <AppHeaderMenu
            displayName={me?.displayName}
            initials={initials}
            suffix={suffix}
            // Gated on `me` on purpose: feedback needs a household to attach
            // itself to, so the item is absent for the one paint before `me`
            // resolves. Theme and sync need no household.
            canSendFeedback={Boolean(me)}
          />
        </div>
      </header>
    </FeedbackDialogProvider>
  );
}
