import React from 'react';
import { FreshnessBar } from './FreshnessBar';
import { BottomNav } from './BottomNav';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex flex-col min-h-dvh">
      <FreshnessBar />
      <main className="flex-1 pb-nav overflow-y-auto">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
