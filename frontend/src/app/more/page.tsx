'use client';

import React from 'react';
import { Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SourceHealthList } from '@/components/more/SourceHealthList';
import { ProfileCard } from '@/components/more/ProfileCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useSourceHealth, useProfile, useClearAllReadState } from '@/hooks/useSettings';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0';

export default function MorePage() {
  const { data: health, isLoading: healthLoading, isError: healthError } = useSourceHealth();
  const { data: profile } = useProfile();
  const { mutate: clearAll, isPending: isClearing } = useClearAllReadState();

  return (
    <AppShell>
      <div data-testid="more-page" className="px-4 pb-4 space-y-6">
        <header className="pt-4">
          <h1 className="text-xl font-bold text-foreground">עוד</h1>
        </header>

        {/* Profile */}
        {profile && (
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              פרטי הורה
            </h2>
            <ProfileCard profile={profile} />
          </section>
        )}

        {/* Source health */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            מצב סנכרון
          </h2>
          {healthLoading && <LoadingState message="טוען..." />}
          {healthError && <ErrorState />}
          {health && <SourceHealthList sources={health.sources} />}
        </section>

        {/* Clear read state */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            פעולות
          </h2>
          <div className="card-base">
            <button
              data-testid="clear-read-state-button"
              onClick={() => clearAll()}
              disabled={isClearing}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm text-destructive hover:bg-destructive/5 transition-colors rounded-xl disabled:opacity-50"
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
