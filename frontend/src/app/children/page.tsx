'use client';

import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ChildCard } from '@/components/children/ChildCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useChildren } from '@/hooks/useChildren';
import { Users } from 'lucide-react';

export default function ChildrenPage() {
  const { data, isLoading, isError, refetch } = useChildren();

  return (
    <AppShell>
      <div className="page-shell space-y-5">
        <header className="page-header">
          <h1 className="page-title">ילדים</h1>
          <ThemeToggle />
        </header>

        {isLoading && <LoadingState message="טוען ילדים..." />}
        {isError && <ErrorState onRetry={() => void refetch()} />}
        {!isLoading && !isError && data && (
          data.data.length === 0 ? (
            <EmptyState
              icon={<Users className="w-10 h-10" />}
              title="אין ילדים"
              subtitle="לא נמצאו ילדים מחוברים לחשבון"
            />
          ) : (
            <div data-testid="children-page" className="grid gap-3 md:grid-cols-2">
              {data.data.map((child) => (
                <ChildCard key={child.studentGuid} child={child} />
              ))}
            </div>
          )
        )}
      </div>
    </AppShell>
  );
}
