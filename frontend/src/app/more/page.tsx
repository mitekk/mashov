'use client';

import React from 'react';
import { Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SourceHealthList } from '@/components/more/SourceHealthList';
import { ProfileCard } from '@/components/more/ProfileCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useSourceHealth, useProfile, useClearAllReadState } from '@/hooks/useSettings';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0';

export default function MorePage() {
  const { data: health, isLoading: healthLoading, isError: healthError } = useSourceHealth();
  const { data: profile } = useProfile();
  const { mutate: clearAll, isPending: isClearing } = useClearAllReadState();

  return (
    <AppShell>
      <div data-testid="more-page" className="page-shell space-y-7">
        <header className="page-header">
          <h1 className="page-title">עוד</h1>
          <ThemeToggle />
        </header>

        {/* Profile */}
        {profile && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              פרטי הורה
            </h2>
            <ProfileCard profile={profile} />
          </section>
        )}

        {/* Source health */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            מצב סנכרון
          </h2>
          {healthLoading && <LoadingState message="טוען..." />}
          {healthError && <ErrorState />}
          {health && <SourceHealthList sources={health.sources} />}
        </section>

        {/* Clear read state */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            פעולות
          </h2>
          <div className="card-base">
            <button
              data-testid="clear-read-state-button"
              onClick={() => clearAll()}
              disabled={isClearing}
              className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4 flex-shrink-0" />
              <span>נקה מצב קריאה</span>
            </button>
          </div>
        </section>

        {/* App info */}
        <section>
          <p className="text-xs text-muted-foreground text-center">
            מרכז הורים · גרסה {APP_VERSION}
          </p>
        </section>
      </div>
    </AppShell>
  );
}
