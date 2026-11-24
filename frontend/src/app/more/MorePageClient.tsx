'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { SourceHealthList } from '@/components/more/SourceHealthList';
import { ContentFreshnessCard } from '@/components/more/ContentFreshnessCard';
import { ProfileCard } from '@/components/more/ProfileCard';
import { SchoolLinksCard } from '@/components/more/SchoolLinksCard';
import { TelegramCard } from '@/components/more/TelegramCard';
import { LoadingState } from '@/components/ui/LoadingState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { useSourceHealth, useProfile } from '@/hooks/useSettings';
import { useSchoolLinks } from '@/hooks/useSchoolLinks';
import { useChildren } from '@/hooks/useChildren';
import {
  useDigestRecipients,
  useUpdateDigestRecipient,
} from '@/hooks/useDigestRecipients';
import { useDisconnectTelegram } from '@/hooks/useTelegramLink';
import { useMe } from '@/hooks/useAuth';
import { deleteAllSchoolLinks, deleteSchoolLink } from '@/api/schoolLinks';
import { ApiError } from '@/api/client';
import {
  SCHOOL_LINK_FALLBACK_MESSAGE,
  schoolLinkErrorMessage,
} from '@/lib/school-link-errors';
import { invalidateHouseholdScopedQueries } from '@/lib/query-invalidation';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import type { ChildrenResponse, SchoolLink } from '@/types/api';
import { signOut } from '@/api/auth';

// Set for every real build by next.config.ts, which derives it from
// APP_VERSION or frontend/package.json. The fallback is for environments that
// do not load the Next config at all, such as the vitest component tests.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0';

export default function MorePage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: health, isLoading: healthLoading, isError: healthError } = useSourceHealth();
  const { data: profiles } = useProfile();
  const { data: me } = useMe();
  const { data: schoolLinks } = useSchoolLinks();
  const { data: childrenResponse } = useChildren();
  const { data: digestRecipients } = useDigestRecipients();
  const { selectedChildGuid, setSelectedChildGuid } = useSelectedChild();

  // Disconnect confirm modal
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  // What went wrong with the last bulk disconnect, shown inside its modal.
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  /** Open or close the bulk modal, always clearing the last error with it. */
  const showDisconnect = (open: boolean) => {
    setDisconnectError(null);
    setShowDisconnectConfirm(open);
  };
  // The single school a per-row "ניתוק" is asking about, or null.
  const [pendingUnlink, setPendingUnlink] = useState<SchoolLink | null>(null);
  // What went wrong with the last unlink, shown inside the modal.
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  /**
   * Open or close the per-row modal, always clearing the last error with it.
   *
   * Every path in and out goes through here. A message left behind would greet
   * the next attempt as a failure that has not happened yet.
   */
  const showUnlink = (link: SchoolLink | null) => {
    setUnlinkError(null);
    setPendingUnlink(link);
  };

  // The Telegram disconnect confirm modal, and what went wrong with the last
  // attempt. Paired, and only ever changed together through the helper below --
  // the same discipline showUnlink and showDisconnect enforce, because a
  // message left behind would greet the next attempt as a failure that has not
  // happened yet.
  const [showTelegramConfirm, setShowTelegramConfirm] = useState(false);
  const [telegramDisconnectError, setTelegramDisconnectError] = useState<string | null>(null);

  /** Open or close the Telegram modal, always clearing the last error with it. */
  const showTelegramDisconnect = (open: boolean) => {
    setTelegramDisconnectError(null);
    setShowTelegramConfirm(open);
  };

  // What went wrong with the last per-child toggle, shown inside the card.
  const [telegramToggleError, setTelegramToggleError] = useState<string | null>(null);

  // `undefined` -- ['school-links'] not resolved yet -- takes the PLURAL
  // branch. Being told "all schools will be deleted" with one school linked is
  // merely odd; the reverse tells a two-school household it is disconnecting
  // its only school while `deleteAllSchoolLinks` wipes both. The old
  // `pendingUnlink &&` term was dead: the per-row modal only opens above one
  // school.
  // `undefined` -- ['school-links'] not resolved yet -- takes the PLURAL
  // branch, and it drives every word of the bulk disconnect: the label, the
  // modal's heading and its body. Being told "all schools will be deleted"
  // with one school linked is merely odd; the reverse tells a two-school
  // household it is disconnecting its only school while `deleteAllSchoolLinks`
  // wipes both. The old `pendingUnlink &&` term was dead -- the per-row modal
  // only opens above one school -- and the old `?? 1` default was the half
  // that was wrong.
  const isLastSchool = schoolLinks !== undefined && schoolLinks.length <= 1;

  const disconnectMutation = useMutation({
    mutationFn: deleteAllSchoolLinks,
    onSuccess: () => {
      // The household has no schools left, so every cached answer is about
      // data that no longer exists. `clear()` is right here and nowhere else.
      queryClient.clear();
      router.push('/auth/sign-in');
    },
    // The other half of T13 finding 6's terminal state. This mutation had no
    // `onError` either, and its confirm button closed the modal BEFORE firing
    // — so a failure left nothing at all on screen and a parent believing they
    // had disconnected while still signed in with every school linked. It is
    // the path a one-school household takes: `SchoolLinksCard`'s per-row
    // "ניתוק" routes here whenever only one school is linked, which is the very
    // button the finding was raised against.
    onError: (err) => {
      if (err instanceof ApiError) {
        const code = (err.body as { error?: { code?: string } })?.error?.code;
        setDisconnectError(schoolLinkErrorMessage(code));
        return;
      }
      setDisconnectError(SCHOOL_LINK_FALLBACK_MESSAGE);
    },
  });

  const unlinkOneMutation = useMutation({
    mutationFn: (link: SchoolLink) => deleteSchoolLink(link.id),
    onSuccess: (_result, link) => {
      // The removed school's children are captured BEFORE invalidating,
      // because afterwards the cache no longer knows which children were
      // whose -- and a selected child who has just been deleted would leave
      // the workspace pointed at a guid that now 404s.
      const children = queryClient.getQueryData<ChildrenResponse>(['children']);
      const removedGuids = (children?.data ?? [])
        .filter((child) => child.schoolId === link.id)
        .map((child) => child.studentGuid);
      if (selectedChildGuid && removedGuids.includes(selectedChildGuid)) {
        setSelectedChildGuid(null);
      }

      // Invalidated, never cleared: the parent still has a household and the
      // shell renders from ['me'], so clearing would flash it through null.
      invalidateHouseholdScopedQueries(queryClient);
      showUnlink(null);
    },
    // T13 finding 6, the settled half: there was no `onError` at all, so a
    // failed unlink left the modal open, the confirm button re-enabled and
    // nothing on screen — the terminal state the parent was left in after
    // their retry 404'd.
    onError: (err) => {
      // A 404 means the school is already gone, which is the outcome the
      // parent asked for. Not a failure to report at them.
      if (err instanceof ApiError && err.status === 404) {
        invalidateHouseholdScopedQueries(queryClient);
        showUnlink(null);
        return;
      }
      if (err instanceof ApiError) {
        const code = (err.body as { error?: { code?: string } })?.error?.code;
        setUnlinkError(schoolLinkErrorMessage(code));
        return;
      }
      setUnlinkError(SCHOOL_LINK_FALLBACK_MESSAGE);
    },
  });

  const telegramToggleMutation = useUpdateDigestRecipient();
  const telegramDisconnectMutation = useDisconnectTelegram();

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

        {/* Connected schools */}
        {schoolLinks && schoolLinks.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {schoolLinks.length === 1 ? 'בית ספר מחובר' : 'בתי ספר מחוברים'}
            </h2>
            <SchoolLinksCard
              links={schoolLinks}
              onUnlink={(link) =>
                // The last school is the sign-out-and-wipe case, so it routes
                // to the bulk confirm, which says so.
                schoolLinks.length <= 1 ? showDisconnect(true) : showUnlink(link)
              }
            />
          </section>
        )}

        {/* Profile -- one card per linked school. `upstreamUserId` is a
            per-school id, so a two-school parent has two sets of contact
            details and both are current; one card captioned with one school
            and filled from the other is B4. */}
        {profiles && profiles.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {profiles.length === 1 ? 'פרטי הורה' : 'פרטי הורה לפי בית ספר'}
            </h2>
            <div className="space-y-3">
              {profiles.map((profile) => (
                <ProfileCard key={profile.householdConnectionId} profile={profile} />
              ))}
            </div>
          </section>
        )}

        {/* Source health */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            מצב סנכרון
          </h2>
          {healthLoading && <LoadingState message="טוען..." />}
          {healthError && <ErrorState />}
          {health && (
            <div className="space-y-3">
              <ContentFreshnessCard contentFreshness={health.contentFreshness} />
              <SourceHealthList sources={health.sources} />
            </div>
          )}
        </section>

        {/* Telegram updates. Between sync state and the account actions: it is
            a delivery preference, not an account action -- disconnecting it
            removes a chat id, not a household. */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            עדכונים בטלגרם
          </h2>
          <TelegramCard
            recipients={digestRecipients ?? []}
            allChildren={childrenResponse?.data ?? []}
            pendingToggleId={
              telegramToggleMutation.isPending
                ? (telegramToggleMutation.variables?.id ?? null)
                : null
            }
            toggleError={telegramToggleError}
            onToggle={(id, enabled) => {
              setTelegramToggleError(null);
              telegramToggleMutation.mutate(
                { id, enabled },
                {
                  onError: () =>
                    setTelegramToggleError('לא הצלחנו לעדכן את ההגדרה. נסו שוב בעוד רגע.'),
                },
              );
            }}
            onDisconnect={() => showTelegramDisconnect(true)}
          />
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
            onClick={() => showDisconnect(true)}
            className="w-full rounded-xl border border-destructive/40 px-4 py-3 text-sm font-medium text-destructive hover:bg-destructive/5 transition-colors"
          >
            {isLastSchool ? 'ניתוק מבית הספר' : 'ניתוק מכל בתי הספר'}
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
      {pendingUnlink && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="unlink-modal-title"
          data-testid="settings-unlink-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl space-y-4">
            <h2 id="unlink-modal-title" className="text-base font-bold text-foreground">
              {`לנתק את "${pendingUnlink.schoolName}"?`}
            </h2>
            {/* The blast radius, named. The old copy said "כל המידע יימחק",
                which is now a lie: the other school's data stays. */}
            <p className="text-sm text-muted-foreground">
              {`יימחקו כל הנתונים של ${childrenPhrase(pendingUnlink.childrenCount)} בבית הספר הזה — שיעורי בית, התנהגות, הודעות ודואר.`}
              {remainingSchoolsPhrase(schoolLinks ?? [], pendingUnlink)}
            </p>
            {unlinkError && (
              <p
                role="alert"
                data-testid="settings-unlink-error"
                className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {unlinkError}
              </p>
            )}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                data-testid="settings-unlink-cancel-btn"
                onClick={() => showUnlink(null)}
                className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent/50 transition-colors"
              >
                ביטול
              </button>
              <button
                data-testid={`settings-unlink-confirm-btn-${pendingUnlink.semel}`}
                onClick={() => unlinkOneMutation.mutate(pendingUnlink)}
                disabled={unlinkOneMutation.isPending}
                className="flex-1 rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {unlinkOneMutation.isPending ? 'מנתק...' : 'ניתוק'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTelegramConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="telegram-disconnect-modal-title"
          data-testid="telegram-disconnect-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-6 shadow-xl">
            <h2
              id="telegram-disconnect-modal-title"
              className="text-base font-bold text-foreground"
            >
              לנתק את העדכונים בטלגרם?
            </h2>
            <p className="text-sm text-muted-foreground">
              נפסיק לשלוח עדכונים על כל הילדים, והחיבור לטלגרם יימחק. אפשר לחבר מחדש בכל שלב.
            </p>
            {telegramDisconnectError && (
              <p
                role="alert"
                data-testid="telegram-disconnect-error"
                className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {telegramDisconnectError}
              </p>
            )}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                data-testid="telegram-disconnect-cancel-btn"
                onClick={() => showTelegramDisconnect(false)}
                className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
              >
                ביטול
              </button>
              <button
                data-testid="telegram-disconnect-confirm-btn"
                disabled={telegramDisconnectMutation.isPending}
                onClick={() => {
                  setTelegramDisconnectError(null);
                  telegramDisconnectMutation.mutate(undefined, {
                    onSuccess: () => showTelegramDisconnect(false),
                    onError: () =>
                      setTelegramDisconnectError(
                        'לא הצלחנו לנתק כרגע. נסו שוב בעוד רגע.',
                      ),
                  });
                }}
                className="flex-1 rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {telegramDisconnectMutation.isPending ? 'מנתק...' : 'ניתוק'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisconnectConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="disconnect-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl space-y-4">
            <h2 id="disconnect-modal-title" className="text-base font-bold text-foreground">
              {isLastSchool ? 'ניתוק מבית הספר' : 'ניתוק מכל בתי הספר'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isLastSchool
                ? 'זה בית הספר היחיד המחובר. ניתוק שלו ימחק את כל המידע ויוציא אותך מהחשבון.'
                : 'יימחקו כל הנתונים של כל בתי הספר, ותצאו מהחשבון.'}
            </p>
            {disconnectError && (
              <p
                role="alert"
                data-testid="settings-disconnect-error"
                className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {disconnectError}
              </p>
            )}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                data-testid="settings-disconnect-cancel-btn"
                onClick={() => showDisconnect(false)}
                className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent/50 transition-colors"
              >
                ביטול
              </button>
              <button
                data-testid="settings-disconnect-confirm-btn"
                // Deliberately does NOT close the modal first. The success
                // path navigates to sign-in and unmounts it anyway, and
                // closing pre-emptively is what made a failure silent.
                onClick={() => {
                  setDisconnectError(null);
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

/** Hebrew counts one, two and many differently. */
function childrenPhrase(count: number): string {
  if (count === 0) return 'הילדים';
  if (count === 1) return 'הילד';
  if (count === 2) return '2 הילדים';
  return `${count} הילדים`;
}

/**
 * Which schools survive the unlink, named.
 *
 * Naming them is the point: "the other school's data stays" is abstract, while
 * "הנתונים של אורט רמון יישארו" is something a parent can check against what
 * they meant to do.
 */
function remainingSchoolsPhrase(links: SchoolLink[], removing: SchoolLink): string {
  const remaining = links.filter((link) => link.id !== removing.id);
  if (remaining.length === 0) return '';
  const names = remaining.map((link) => `"${link.schoolName}"`).join(' ו');
  return ` הנתונים של ${names} יישארו.`;
}
