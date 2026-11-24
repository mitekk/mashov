import React from 'react';
import { FreshnessBar } from './FreshnessBar';
import { AppNav } from './AppNav';
import { AppHeader } from './AppHeader';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    // `pt-safe` is NOT here any more: it lives on `AppHeader`, which is
    // `sticky top-0` and so parks at the viewport top under the notch, where
    // padding on this wrapper -- above it in the flow -- does nothing. That is
    // safe because `AppHeader` never returns null, unlike the `UserHeader` it
    // replaced.
    //
    // `lg:ps-rail` is the side rail's gutter. Logical, so under RTL the gutter
    // sits on the right -- the same edge the rail moves to.
    <div className="flex min-h-dvh flex-col lg:ps-rail">
      <AppHeader />
      {/* BELOW the header, and deliberately not sticky: it scrolls away under
          it, and the header has no geometry to keep in sync with it.

          Ordering is the whole point. `pt-safe` lives on the header, which is
          `sticky top-0` and so parks at the viewport top under the notch.
          Anything rendered ABOVE it in the flow either takes the notch itself
          -- `StaleIndicator` renders a real banner in the `degraded` and
          `stale` states, which would land under the status bar -- or carries a
          second copy of the inset, which on an iPhone shows up as a ~47px
          blank strip inside the header. Putting the header first leaves it the
          single owner of the inset and the topmost chrome in every state. */}
      <FreshnessBar />
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
