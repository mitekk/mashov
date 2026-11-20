'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { SchoolAutocomplete } from '@/components/auth/SchoolAutocomplete';
import { createSchoolLink } from '@/api/schoolLinks';
import { useSchoolLinks } from '@/hooks/useSchoolLinks';
import { ApiError } from '@/api/client';
import { invalidateHouseholdScopedQueries } from '@/lib/query-invalidation';
import {
  SCHOOL_LINK_FALLBACK_MESSAGE,
  schoolLinkErrorMessage,
} from '@/lib/school-link-errors';
import type { School } from '@/types/api';

/**
 * Linking another school.
 *
 * A route rather than a modal: it gets real back-button behaviour on a phone,
 * a shareable URL, and a page object a test can drive, and `/more/...` already
 * passes the phase-1 route gate so nothing else has to change.
 */
export default function AddSchoolPageClient() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: existingLinks } = useSchoolLinks();

  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * The school another household already holds, once the backend has offered
   * to move it here -- `null` until then.
   *
   * A merge revokes the other sign-in's sessions and moves its state, so it
   * never rides along on the first submit: the parent sees what it would do
   * and says yes.
   *
   * It carries the credentials the offer was made for, rather than re-reading
   * the form at confirm time. Otherwise the consent and the request are two
   * different things: a parent reading the offer may well decide the username
   * was wrong and edit it, and clicking confirm would then send the edited
   * credentials under a consent given for the original ones -- merging, if
   * that account is also foreign-owned, a household they were never shown.
   * `clearPendingMerge` withdraws the offer on any edit as well, so the card
   * on screen always describes the request the button would send.
   */
  const [pendingMerge, setPendingMerge] = useState<{
    schoolName: string;
    childrenCount: number;
    semel: number;
    username: string;
    password: string;
  } | null>(null);

  const linkMutation = useMutation({
    mutationFn: createSchoolLink,
    onSuccess: (link) => {
      // Invalidated, never cleared: clearing drops ['me'] and the whole shell
      // flashes through its null state.
      invalidateHouseholdScopedQueries(queryClient);
      // The same screen first sign-in uses, because the problem is identical:
      // the connection exists but its data does not yet.
      router.replace(`/auth/syncing?schoolId=${encodeURIComponent(link.id)}`);
    },
    onError: (err, variables) => {
      if (err instanceof ApiError) {
        const body = err.body as {
          error?: {
            code?: string;
            merge?: { schoolName?: string; childrenCount?: number };
          };
        };
        const code = body?.error?.code;
        // Not a failure: there is something the parent can do, so the screen
        // asks rather than reports.
        if (code === 'MERGE_AVAILABLE' && variables) {
          setPendingMerge({
            schoolName: body.error?.merge?.schoolName ?? selectedSchool?.name ?? '',
            childrenCount: body.error?.merge?.childrenCount ?? 0,
            semel: variables.semel,
            username: variables.username,
            password: variables.password,
          });
          return;
        }
        setErrorMsg(schoolLinkErrorMessage(code));
        return;
      }
      setErrorMsg(SCHOOL_LINK_FALLBACK_MESSAGE);
    },
  });

  /**
   * Withdraw a merge offer the form no longer describes.
   *
   * Called from every input that feeds the request, so the card on screen and
   * the request the confirm button would send can never disagree.
   */
  function clearPendingMerge(): void {
    setPendingMerge(null);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMsg(null);
    setPendingMerge(null);

    if (!selectedSchool) {
      setErrorMsg('יש לבחור בית ספר');
      return;
    }
    if (!username.trim()) {
      setErrorMsg('יש להזין שם משתמש');
      return;
    }
    if (!password) {
      setErrorMsg('יש להזין סיסמה');
      return;
    }

    linkMutation.mutate({
      semel: selectedSchool.semel,
      username: username.trim(),
      password,
    });
  }

  return (
    <div
      data-testid="add-school-page"
      className="min-h-dvh bg-background px-4 py-6"
    >
      <div className="mx-auto w-full max-w-sm">
        <button
          type="button"
          data-testid="add-school-back-btn"
          onClick={() => router.push('/more')}
          className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
          חזרה להגדרות
        </button>

        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">הוספת בית ספר</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            הזינו את פרטי חשבון המשוב של בית הספר הנוסף. הילדים משני בתי הספר יופיעו יחד.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm space-y-5"
        >
          <SchoolAutocomplete
            value={selectedSchool}
            onSelect={(school) => {
              clearPendingMerge();
              setSelectedSchool(school);
            }}
            // Typing over the picked school drops the selection. Without this
            // the form submitted a school the input was no longer showing, and
            // the `INVALID_CREDENTIALS` that came back named a school the
            // parent never chose.
            onClear={() => {
              clearPendingMerge();
              setSelectedSchool(null);
            }}
            inputTestId="add-school-selector"
            optionTestIdPrefix="school-option"
            // Shown but unselectable: preventing the error beats reporting it,
            // and a parent looking for a school they already added needs to
            // see it is there rather than conclude the search is broken.
            disabledSemels={(existingLinks ?? []).map((link) => link.semel)}
          />

          <div className="space-y-1.5">
            <label
              htmlFor="add-school-username"
              className="block text-sm font-medium text-foreground"
            >
              שם משתמש
            </label>
            <input
              id="add-school-username"
              type="text"
              data-testid="add-school-username"
              autoComplete="off"
              dir="ltr"
              value={username}
              onChange={(event) => {
                clearPendingMerge();
                setUsername(event.target.value);
              }}
              className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="add-school-password"
              className="block text-sm font-medium text-foreground"
            >
              סיסמה
            </label>
            <input
              id="add-school-password"
              type="password"
              data-testid="add-school-password"
              autoComplete="off"
              dir="ltr"
              value={password}
              onChange={(event) => {
                clearPendingMerge();
                setPassword(event.target.value);
              }}
              className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
            />
          </div>

          {pendingMerge && (
            <div
              data-testid="add-school-merge-confirm"
              role="alert"
              className="space-y-3 rounded-xl bg-primary/10 px-3 py-3 text-sm text-foreground"
            >
              <p className="font-semibold">
                {pendingMerge.schoolName} מחובר לחשבון נפרד באפליקציה
              </p>
              <p className="text-muted-foreground">
                אם תאחדו אותם, הילדים משני בתי הספר יופיעו כאן יחד
                {pendingMerge.childrenCount > 0 &&
                  ` (${pendingMerge.childrenCount} ילדים בבית הספר הזה)`}
                , וההתחברות הנפרדת לבית הספר הזה תפסיק לעבוד. אפשר לנתק את בית
                הספר בכל שלב.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="add-school-merge-confirm-btn"
                  disabled={linkMutation.isPending}
                  onClick={() =>
                    linkMutation.mutate({
                      semel: pendingMerge.semel,
                      username: pendingMerge.username,
                      password: pendingMerge.password,
                      confirmMerge: true,
                    })
                  }
                  className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
                >
                  {linkMutation.isPending ? 'מאחד...' : 'איחוד בתי הספר'}
                </button>
                <button
                  type="button"
                  data-testid="add-school-merge-cancel-btn"
                  disabled={linkMutation.isPending}
                  onClick={() => setPendingMerge(null)}
                  className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-accent transition-colors"
                >
                  ביטול
                </button>
              </div>
            </div>
          )}

          {errorMsg && (
            <p
              data-testid="add-school-error"
              role="alert"
              className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            data-testid="add-school-submit-btn"
            // Gated on the selection as well as the mutation: `onClear` above
            // is what makes an edited input lose the school, and this is what
            // stops the form submitting the nothing that is left.
            disabled={linkMutation.isPending || !selectedSchool}
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {linkMutation.isPending ? 'מתחבר...' : 'חיבור בית הספר'}
          </button>
        </form>
      </div>
    </div>
  );
}
