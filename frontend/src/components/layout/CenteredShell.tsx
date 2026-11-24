import React from 'react';
import { cn } from '@/lib/utils';

interface CenteredShellProps {
  children: React.ReactNode;
  /**
   * `center` centres the panel in the viewport (sign-in, syncing).
   * `top` pins it near the top, for pages whose first element is a back button
   * that should sit where a header would.
   */
  align?: 'center' | 'top';
  /** Extra classes for the panel, e.g. a route that earns more width at `lg`. */
  panelClassName?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * The single-panel page shell for the four routes that deliberately bypass
 * `AppShell`: sign-in, syncing, Telegram setup and add-school. Each of them
 * had its own copy of `min-h-dvh … max-w-sm`, which meant shell-level fixes
 * (the notch inset, the desktop width) had to be made four times or not at all.
 *
 * `place-items-center` on a grid rather than `flex items-center justify-center`:
 * a grid child taller than the viewport stays scrollable, where a centred flex
 * child gets its overflow clipped above the fold.
 */
export function CenteredShell({
  children,
  align = 'center',
  panelClassName,
  className,
  'data-testid': testId,
}: CenteredShellProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'grid min-h-dvh bg-background px-4 pb-8 pt-safe',
        align === 'center' ? 'place-items-center' : 'items-start justify-center',
        className,
      )}
    >
      {/*
        The notch inset lives on the wrapper and the visual top space on the
        panel, never both on the wrapper: `.pt-safe` is a custom utility
        emitted after Tailwind's own, so a sibling `pt-6` would lose to it and
        the top-aligned variant would have no top space at all on desktop.
      */}
      <div
        data-shell-panel=""
        className={cn(
          'w-full max-w-sm md:max-w-md',
          align === 'top' && 'pt-6',
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
