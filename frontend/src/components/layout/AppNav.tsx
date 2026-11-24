'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isNavItemActive, useNavItems } from './navItems';

/**
 * The app's single navigation surface: a bottom tab bar below `lg`, a vertical
 * side rail from `lg` up.
 *
 * ONE `<nav>`, flipped by CSS -- not a bottom bar plus a side rail. Two
 * renderers would resolve `nav-inbox` twice under Playwright's strict mode
 * (even with one of them `display:none`) and would put two navigation
 * landmarks in the a11y tree. The cost is longer className strings; it buys
 * stable testids and no hydration flip.
 *
 * Every offset is logical (`start`/`end`), so under `dir="rtl"` the rail lands
 * on the right edge with its border on the left with no special-casing. `start`
 * and `end` are used in place of `inset-x-*` deliberately: mixing the logical
 * and physical families leaves which one wins to stylesheet source order.
 */
export function AppNav() {
  const pathname = usePathname();
  const navItems = useNavItems();

  return (
    <nav
      data-testid="bottom-nav"
      className={cn(
        'fixed bottom-0 start-0 end-0 z-50 border-t border-border/80 bg-card/90 backdrop-blur',
        // The home-indicator inset is a utility, not an inline style, so that
        // `lg:pb-0` can cancel it once the bar is no longer at the bottom.
        'pb-safe',
        'lg:top-0 lg:end-auto lg:w-rail lg:border-e lg:border-s-0 lg:border-t-0 lg:pb-0',
      )}
    >
      <div
        className={cn(
          // px-4 (not px-2) so the tab bar's edges line up with `page-shell`.
          'mx-auto flex max-w-5xl items-stretch px-4 py-1.5',
          'lg:h-full lg:max-w-none lg:flex-col lg:justify-center lg:gap-2 lg:px-2',
        )}
      >
        {navItems.map((item) => {
          const isActive = isNavItemActive(item, pathname);
          return (
            <Link
              key={item.testId}
              href={item.href}
              data-testid={item.testId}
              className={cn(
                'tap-target flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-2 transition-colors',
                'lg:w-full lg:flex-none',
                isActive
                  ? 'bg-primary/12 text-primary'
                  : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="relative">
                {item.icon}
                {item.badge !== undefined && (
                  <span className="absolute -top-1 -start-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-3xs font-bold text-destructive-foreground">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </span>
              <span className="text-3xs font-medium leading-none">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
