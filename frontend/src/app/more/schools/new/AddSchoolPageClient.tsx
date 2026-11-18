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
    onError: (err) => {
      if (err instanceof ApiError) {
        const code = (err.body as { error?: { code?: string } })?.error?.code;
        setErrorMsg(schoolLinkErrorMessage(code));
        return;
      }
      setErrorMsg(SCHOOL_LINK_FALLBACK_MESSAGE);
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMsg(null);

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
            onSelect={setSelectedSchool}
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
              onChange={(event) => setUsername(event.target.value)}
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
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
            />
          </div>

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
            disabled={linkMutation.isPending}
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {linkMutation.isPending ? 'מתחבר...' : 'חיבור בית הספר'}
          </button>
        </form>
      </div>
    </div>
  );
}
