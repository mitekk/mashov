'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { SourceHealthList } from '@/components/more/SourceHealthList';
import { ProfileCard } from '@/components/more/ProfileCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { useSourceHealth, useProfile } from '@/hooks/useSettings';
import { useMe } from '@/hooks/useAuth';
import { deleteConnection } from '@/api/connection';
import { signOut } from '@/api/auth';
import { School } from 'lucide-react';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0';

export default function MorePage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: health, isLoading: healthLoading, isError: healthError } = useSourceHealth();
  const { data: profile } = useProfile();
  const { data: me } = useMe();

  // Disconnect confirm modal
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const disconnectMutation = useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => {
      queryClient.clear();
      router.push('/auth/sign-in');
    },
  });

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.clear();
      router.push('/auth/sign-in');
    },
    onError: () => {
      queryClient.clear();
      router.push('/auth/sign-in');
    },
  });

  return (
    <AppShell>
      <div data-testid="more-page" className="page-shell space-y-7">
        <header className="page-header">
          <h1 className="page-title">עוד</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <RefreshButton />
          </div>
        </header>

        {/* Connected school */}
        {me?.connectedSchool && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              בית ספר מחובר
            </h2>
            <div className="card-base p-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <School className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p
                  data-testid="settings-school-name"
                  className="text-sm font-semibold text-foreground"
                >
                  {me.connectedSchool.schoolName}
                </p>
                <p className="text-xs text-muted-foreground">
                  שנת לימודים {me.connectedSchool.schoolYear}
                </p>
              </div>
            </div>
          </section>
        )}

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

        {/* Account actions */}
        <section className="space-y-3">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            חשבון
          </h2>
          <button
            data-testid="settings-signout-btn"
            onClick={() => signOutMutation.mutate()}
            disabled={signOutMutation.isPending}
            className="w-full rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-accent/50 transition-colors disabled:opacity-60"
          >
            {signOutMutation.isPending ? 'מתנתק...' : 'התנתקות'}
          </button>
          <button
            data-testid="settings-disconnect-btn"
            onClick={() => setShowDisconnectConfirm(true)}
            className="w-full rounded-xl border border-destructive/40 px-4 py-3 text-sm font-medium text-destructive hover:bg-destructive/5 transition-colors"
          >
            ניתוק מבית הספר
          </button>
        </section>

        {/* App info */}
        <section>
          <p className="text-xs text-muted-foreground text-center">
            מרכז הורים · גרסה {APP_VERSION}
          </p>
        </section>
      </div>

      {/* Disconnect confirmation modal */}
      {showDisconnectConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="disconnect-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl space-y-4">
            <h2 id="disconnect-modal-title" className="text-base font-bold text-foreground">
              ניתוק מבית הספר
            </h2>
            <p className="text-sm text-muted-foreground">
              האם אתה בטוח? כל המידע יימחק.
            </p>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setShowDisconnectConfirm(false)}
                className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent/50 transition-colors"
              >
                ביטול
              </button>
              <button
                data-testid="settings-disconnect-confirm-btn"
                onClick={() => {
                  setShowDisconnectConfirm(false);
                  disconnectMutation.mutate();
                }}
                disabled={disconnectMutation.isPending}
                className="flex-1 rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {disconnectMutation.isPending ? 'מנתק...' : 'נתק'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
