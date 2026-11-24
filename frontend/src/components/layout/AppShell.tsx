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
      {/* Above the header and deliberately NOT sticky: it scrolls away, and
          the header then sticks to the viewport top with no geometry to keep
          in sync between the two.

          The slot carries the notch padding only while there is a banner in
          it. `StaleIndicator` returns null in the fresh and syncing states, so
          `:empty` matches and `empty:pt-0` hands the inset back to the header,
          which is where it belongs the rest of the time. Without the modifier
          this div would reserve a safe-area strip above a header that already
          pads itself -- the inset twice, on every screen. */}
      <div className="pt-safe empty:pt-0 lg:pt-0">
        <FreshnessBar />
      </div>
      <AppHeader />
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
