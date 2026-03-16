import React from 'react';
import { FreshnessBar } from './FreshnessBar';
import { BottomNav } from './BottomNav';
import { UserHeader } from './UserHeader';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex flex-col min-h-dvh">
      <FreshnessBar />
      <UserHeader />
      <main className="flex-1 pb-nav overflow-y-auto">
        <div className="relative isolate">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/6 to-transparent" />
          {children}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
