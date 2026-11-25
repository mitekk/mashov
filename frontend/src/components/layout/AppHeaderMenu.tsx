'use client';

import React, { useEffect, useState } from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { MessageSquarePlus, MoonStar, MoreHorizontal, RefreshCw, Sun } from 'lucide-react';
import { useSyncRefresh } from '@/hooks/useDashboard';
import { useFeedbackDialog } from '@/hooks/useFeedbackDialog';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

interface AppHeaderMenuProps {
  /**
   * Whether feedback has a household to attach itself to. Same gate the inline
   * branch applies to `FeedbackLauncher`.
   */
  canSendFeedback: boolean;
  className?: string;
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
 * The header's app-wide actions, collapsed into one button below `sm`.
 *
 * Three 44px icon buttons plus an avatar do not fit beside a page title on a
 * 360px phone, so the inline row is `hidden sm:flex` and this takes its place.
 *
 * None of these items reuses the inline controls' testids. Both branches are
 * in the DOM at every width -- one hidden by Tailwind -- and Playwright's
 * strict mode counts hidden matches, so a duplicate `theme-toggle` would
 * resolve two nodes and break every existing locator. Same trap
 * responsive.spec.ts guards by asserting `bottom-nav` resolves to exactly one
 * node.
 */
export function AppHeaderMenu({ canSendFeedback, className }: AppHeaderMenuProps) {
  const { theme, toggleTheme } = useTheme();
  const { openDialog } = useFeedbackDialog();
  const sync = useSyncRefresh();

  const isDark = theme === 'dark';
  const themeLabel = isDark ? 'מצב בהיר' : 'מצב כהה';

  const [open, setOpen] = useState(false);

  // The trigger is `sm:hidden`, but the content is portaled to <body> and has
  // no width gating of its own. A parent who opens this at 360 and rotates to
  // landscape (>= sm on a phone) would leave the trigger `display: none` with
  // its anchor rect collapsed to 0x0, and Radix would keep the menu mounted:
  // an orphaned popover in the viewport corner with nothing to explain it.
  // Same rotation-across-`sm` case the shared sync state in useDashboard.ts
  // exists for.
  useEffect(() => {
    if (!open) return undefined;
    const wideEnoughForInline = window.matchMedia?.('(min-width: 640px)');
    if (!wideEnoughForInline) return undefined;

    const closeIfInlineTakesOver = (): void => {
      if (wideEnoughForInline.matches) setOpen(false);
    };

    closeIfInlineTakesOver();
    wideEnoughForInline.addEventListener?.('change', closeIfInlineTakesOver);
    return () => {
      wideEnoughForInline.removeEventListener?.('change', closeIfInlineTakesOver);
    };
  }, [open]);

  return (
    // `dir` belongs on the root: it is what makes the arrow keys and the
    // content's alignment follow the writing direction.
    <DropdownMenuPrimitive.Root dir="rtl" open={open} onOpenChange={setOpen}>
      <DropdownMenuPrimitive.Trigger
        data-testid="header-menu-trigger"
        aria-label="עוד פעולות"
        className={cn('icon-button tap-target', className)}
      >
        <MoreHorizontal className="h-5 w-5" />
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
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
