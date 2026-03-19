'use client';

import React, { useState } from 'react';
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
import { updateConnection, deleteConnection } from '@/api/connection';
import { signOut } from '@/api/auth';
import { ApiError } from '@/api/client';
import { School } from 'lucide-react';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0';

export default function MorePage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: health, isLoading: healthLoading, isError: healthError } = useSourceHealth();
  const { data: profile } = useProfile();
  const { data: me } = useMe();

  // Update credentials form
  const [showCredentials, setShowCredentials] = useState(false);
  const [credUsername, setCredUsername] = useState('');
  const [credPassword, setCredPassword] = useState('');
  const [credSuccess, setCredSuccess] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  // Disconnect confirm modal
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const updateCredentialsMutation = useMutation({
    mutationFn: updateConnection,
    onSuccess: () => {
      setCredSuccess(true);
      setCredError(null);
      setCredUsername('');
      setCredPassword('');
      setTimeout(() => setCredSuccess(false), 3000);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setCredError('שגיאה בעדכון פרטים, נסה שוב');
      }
    },
  });

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

  function handleUpdateCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredError(null);
    const body: { username?: string; password?: string } = {};
    if (credUsername.trim()) body.username = credUsername.trim();
    if (credPassword) body.password = credPassword;
    if (!body.username && !body.password) {
      setCredError('יש להזין שם משתמש או סיסמה חדשים');
      return;
    }
    updateCredentialsMutation.mutate(body);
  }

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

        {/* Update credentials */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            פרטי חיבור
          </h2>
          <div className="card-base overflow-hidden">
            <button
              data-testid="settings-update-credentials-btn"
              onClick={() => setShowCredentials((v) => !v)}
              className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-foreground hover:bg-accent/50 transition-colors"
            >
              <span>עדכון שם משתמש / סיסמה</span>
              <span className="text-muted-foreground text-xs">{showCredentials ? '▲' : '▼'}</span>
            </button>
            {showCredentials && (
              <form
                onSubmit={handleUpdateCredentials}
                className="px-4 pb-4 pt-2 space-y-4 border-t border-border/50"
              >
                <div className="space-y-1.5">
                  <label htmlFor="cred-username" className="block text-xs font-medium text-muted-foreground">
                    שם משתמש חדש (אופציונלי)
                  </label>
                  <input
                    id="cred-username"
                    type="text"
                    autoComplete="username"
                    value={credUsername}
                    onChange={(e) => setCredUsername(e.target.value)}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="cred-password" className="block text-xs font-medium text-muted-foreground">
                    סיסמה חדשה (אופציונלי)
                  </label>
                  <input
                    id="cred-password"
                    type="password"
                    autoComplete="new-password"
                    value={credPassword}
                    onChange={(e) => setCredPassword(e.target.value)}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
                  />
                </div>
                {credError && (
                  <p role="alert" className="text-xs text-destructive">{credError}</p>
                )}
                {credSuccess && (
                  <p role="status" className="text-xs text-green-600 dark:text-green-400">
                    עודכן בהצלחה
                  </p>
                )}
                <button
                  type="submit"
                  disabled={updateCredentialsMutation.isPending}
                  className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {updateCredentialsMutation.isPending ? 'שומר...' : 'שמור'}
                </button>
              </form>
            )}
          </div>
        </section>

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
