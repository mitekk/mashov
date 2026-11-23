import React from 'react';
import { FreshnessBar } from './FreshnessBar';
import { AppNav } from './AppNav';
import { UserHeader } from './UserHeader';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    // `pt-safe` belongs here, not in `UserHeader`: that component returns null
    // until `me` has loaded, which would drop the notch padding on first paint.
    // It is cancelled at `lg`, where the nav is a side rail and there is no
    // status-bar overlay to clear.
    //
    // `lg:ps-rail` is the side rail's gutter. Logical, so under RTL the gutter
    // sits on the right -- the same edge the rail moves to.
    <div className="flex min-h-dvh flex-col pt-safe lg:ps-rail lg:pt-0">
      <FreshnessBar />
      <UserHeader />
      {/*
        No `overflow-y-auto` here. It made `<main>` a second scroller inside a
        `min-h-dvh` flex column that `body` already scrolls, so `pb-nav` padded
        the inner one and the last card could still sit under the fixed bar.
      */}
      <main className="flex-1 pb-nav">
        <div className="relative isolate">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/6 to-transparent" />
          {children}
        </div>
      </main>
      <AppNav />
    </div>
  );
}
