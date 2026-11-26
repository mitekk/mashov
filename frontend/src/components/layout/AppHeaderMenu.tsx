'use client';

import React from 'react';
import Link from 'next/link';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import {
  ChevronDown,
  ExternalLink,
  MessageSquarePlus,
  MoonStar,
  RefreshCw,
  Settings,
  Sun,
  User,
} from 'lucide-react';
import { useSyncRefresh } from '@/hooks/useDashboard';
import { useFeedbackDialog } from '@/hooks/useFeedbackDialog';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

interface AppHeaderMenuProps {
  /** The parent's name, shown beside the initials from `lg` up. */
  displayName?: string | null;
  /** Initials for the avatar circle. `AppHeader` falls back to `?`. */
  initials: string;
  /** "· 2 ילדים", or an empty string. Part of the accessible name. */
  suffix: string;
  /**
   * Whether feedback has a household to attach itself to. The one item that
   * is gated: theme and sync act on no household in particular.
   */
  canSendFeedback: boolean;
}

const itemClassName = cn(
  'flex w-full cursor-default select-none items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm outline-none',
  // `min-h` rather than `.tap-target`, whose `min-width: 44px` would fight the
  // item's full-width stretch.
  'min-h-[44px] text-foreground',
  'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
);

/**
 * The single home for the header's app-wide actions: settings, feedback,
 * theme and household sync.
 *
 * The trigger is the profile avatar -- the parent's name and initials. There
 * is no inline copy of these controls at any width: three 44px icon buttons
 * plus an avatar do not fit beside a page title on a 360px phone, and keeping
 * both an inline row and a menu meant two live copies of every action in the
 * DOM, one hidden by Tailwind, with Playwright's strict mode counting the
 * hidden matches. One shape everywhere instead.
 *
 * הגדרות is what keeps `/more` reachable from the header now that the avatar
 * is a button rather than a link to it.
 */
export function AppHeaderMenu({
  displayName,
  initials,
  suffix,
  canSendFeedback,
}: AppHeaderMenuProps) {
  const { theme, toggleTheme } = useTheme();
  const { openDialog } = useFeedbackDialog();
  const sync = useSyncRefresh();

  const isDark = theme === 'dark';
  const themeLabel = isDark ? 'מצב בהיר' : 'מצב כהה';

  return (
    // `dir` belongs on the root: it is what makes the arrow keys and the
    // content's alignment follow the writing direction.
    //
    // `modal={false}`, which is NOT Radix's default: modal mode wraps the
    // content in `react-remove-scroll`, which sets
    // `body { overflow: hidden !important; margin-right: <scrollbar>px }`.
    // The document is `dir="rtl"` (`app/layout.tsx`), so the scrollbar lives
    // on the LEFT -- removing it slides the page left while the compensating
    // gap is added on the right, so the shift is double-counted and never
    // compensated. The `overflow: hidden` also overrides the deliberate
    // `overflow-x: clip` in `globals.css`, which exists so `position: sticky`
    // descendants keep working. A header menu has no reason to lock scroll at
    // all; this takes `react-remove-scroll` out of the tree entirely.
    // Outside pointer events are no longer blocked, which is the wanted
    // behaviour here -- clicking the page closes the menu and reaches the page.
    //
    // The genuinely modal consumers (`ConfirmDialog`, `FeedbackDialog`,
    // `ReleasesDialog`, `SchoolActivitiesDialog`, `AttachmentViewer`,
    // `ui/Select`) keep modal mode: they SHOULD lock scroll. A
    // `scrollbar-gutter: stable` on `html` would stop the same RTL gutter
    // double-count reaching them, and was tried -- but it reserves the gutter
    // permanently, which narrows the layout by the scrollbar width and so
    // breaks every "full-bleed element is exactly viewport-wide" assertion in
    // `tests/e2e/responsive.spec.ts` (6px short at tablet and desktop). Not
    // worth a visible layout cost for a shift nobody has reported.
    <DropdownMenuPrimitive.Root dir="rtl" modal={false}>
      <DropdownMenuPrimitive.Trigger
        data-testid="header-profile-trigger"
        aria-label={`${displayName ?? 'פרופיל'}${suffix} — תפריט`}
        // `.tap-target` is what holds the 44px touch floor on a row whose
        // avatar circle is only 32px.
        className={cn(
          'flex items-center gap-2 rounded-full text-sm text-muted-foreground transition-colors',
          // `group` is what lets the chevron read the trigger's `data-state`:
          // Tailwind cannot target a parent's state from the child otherwise.
          'group tap-target hover:text-foreground data-[state=open]:text-foreground',
          // A transparent border reserves the pill's box, so showing it on
          // hover does not shift the header row.
          'border border-transparent px-1.5 lg:px-2',
          'hover:border-border hover:bg-accent/60 data-[state=open]:border-border data-[state=open]:bg-accent/60',
          // The global `:focus-visible` ring reads as a stray outline on this
          // pill, and the open menu already shows where focus is.
          'focus-visible:ring-0 focus-visible:ring-offset-0',
        )}
      >
        {/* `lg`, not `sm`: below that the page title owns the row. */}
        {displayName && (
          <span className="hidden text-xs font-medium lg:block">
            {displayName}
            {suffix}
          </span>
        )}
        <span className="flex h-8 w-8 select-none items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
          {initials}
        </span>
        {/*
          Last child, so under `dir="rtl"` it sits leftmost: `⌄ (קד) שם`. The
          accessible name already ends in `— תפריט`, so this is decorative.
        */}
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
        />
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={8}
          // `z-[70]`, matching `Select`: above every dialog overlay (`z-50`),
          // because a popover opened from inside a dialog has to clear it.
          className={cn(
            'z-[70] min-w-[13rem] overflow-hidden rounded-2xl border border-border bg-popover p-1 text-popover-foreground',
            'shadow-[0_18px_40px_-26px_hsl(var(--foreground)/0.45)]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in data-[state=closed]:fade-out',
            'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
          )}
        >
          {/*
            `asChild`, so Radix hands the keyboard and `onSelect` to a real
            `next/link` rather than wrapping an anchor in a div that only the
            mouse can reach.
          */}
          <DropdownMenuPrimitive.Item
            asChild
            data-testid="header-menu-settings"
            className={itemClassName}
          >
            <Link href="/more">
              <Settings className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>הגדרות</span>
            </Link>
          </DropdownMenuPrimitive.Item>

          {canSendFeedback && (
            <DropdownMenuPrimitive.Item
              data-testid="header-menu-feedback"
              onSelect={() => openDialog()}
              className={itemClassName}
            >
              <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>שליחת משוב</span>
            </DropdownMenuPrimitive.Item>
          )}

          <DropdownMenuPrimitive.Item
            data-testid="header-menu-theme"
            onSelect={() => toggleTheme()}
            className={itemClassName}
          >
            {isDark ? (
              <Sun className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <MoonStar className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span>{themeLabel}</span>
          </DropdownMenuPrimitive.Item>

          <DropdownMenuPrimitive.Item
            data-testid="header-menu-refresh"
            disabled={sync.isPending}
            onSelect={() => sync.mutate()}
            className={itemClassName}
          >
            <RefreshCw
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground',
                sync.isPending && 'animate-spin',
              )}
            />
            <span>{sync.isPending ? 'מסנכרן...' : 'רענן נתונים'}</span>
          </DropdownMenuPrimitive.Item>

          <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />

          {/*
            External, so a plain `<a>` rather than `next/link` -- the same
            convention `CaptchaEscapeHatch` follows for off-app links.
          */}
          <DropdownMenuPrimitive.Item
            asChild
            data-testid="header-menu-about"
            className={itemClassName}
          >
            <a
              href="https://profile.mitya.dev/"
              target="_blank"
              rel="noopener noreferrer"
              // The new tab is not visible in the item's text, and the ↗ glyph
              // is decorative, so it goes in the accessible name instead.
              aria-label="אודות (נפתח בלשונית חדשה)"
            >
              <User className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>אודות</span>
              {/* `ms-auto`, not `ml-auto`, so the glyph pins to the far edge in RTL. */}
              <ExternalLink
                className="ms-auto h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </a>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
