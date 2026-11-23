'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getSchools, login } from '@/api/auth';
import { SchoolAutocomplete } from '@/components/auth/SchoolAutocomplete';
import { readAuthError } from '@/lib/authErrors';
import type { School } from '@/types/api';

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/';

  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Still fetched here, for the last-used-school restore below. The
  // autocomplete runs the same query under the same key, so this is one
  // request shared through the cache, not two.
  const { data: schools = [] } = useQuery({
    queryKey: ['schools'],
    queryFn: getSchools,
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    if (schools.length === 0 || selectedSchool) return;
    try {
      const saved = localStorage.getItem('mashov.lastSchoolSemel');
      if (!saved) return;
      const semel = Number(saved);
      const match = schools.find((s) => s.semel === semel);
      if (match) setSelectedSchool(match);
    } catch {
      // localStorage unavailable - ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schools]);

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: (data) => {
      try {
        if (selectedSchool) {
          localStorage.setItem('mashov.lastSchoolSemel', String(selectedSchool.semel));
        }
      } catch {
        // localStorage unavailable - ignore
      }
      if (data.isFirstLogin) {
        router.push('/auth/syncing');
      } else {
        router.push(nextPath.startsWith('/auth') ? '/' : nextPath);
      }
    },
    onError: (err) => {
      // Mashov distinguishes far more than "wrong password": for seven of its
      // answers the password is CORRECT and the account needs a next step. The
      // old two-branch version told all of those parents their password was
      // wrong, and they retyped it until the rate limiter locked them out.
      const { code, message, challengeId } = readAuthError(err);

      // An MFA challenge is not an error the parent can act on here, so the
      // form hands them straight to the code screen. Only with a challenge id:
      // without one the next screen has nothing to work with, and sending them
      // there would be a dead end with a spinner.
      if (code === 'MFA_REQUIRED' && challengeId && selectedSchool) {
        const query = new URLSearchParams({
          cid: challengeId,
          semel: String(selectedSchool.semel),
          username: username.trim(),
        });
        router.push(`/auth/mfa?${query.toString()}`);
        return;
      }

      setErrorMsg(message);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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

    loginMutation.mutate({
      semel: selectedSchool.semel,
      username: username.trim(),
      password,
    });
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-foreground">כניסה למרכז הורים</h1>
          <p className="mt-1 text-sm text-muted-foreground">הכנס את פרטי החשבון שלך</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm space-y-5"
        >
          <SchoolAutocomplete
            value={selectedSchool}
            onSelect={setSelectedSchool}
            onClear={() => setSelectedSchool(null)}
            inputTestId="sign-in-school-selector"
            optionTestIdPrefix="school-option"
          />

          {/* Username */}
          <div className="space-y-1.5">
            <label htmlFor="username" className="block text-sm font-medium text-foreground">
              שם משתמש
            </label>
            <input
              id="username"
              type="text"
              data-testid="sign-in-username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
            />
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium text-foreground">
              סיסמה
            </label>
            <input
              id="password"
              type="password"
              data-testid="sign-in-password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
            />
          </div>

          {/* Error */}
          {errorMsg && (
            <p
              data-testid="sign-in-error"
              role="alert"
              className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive font-medium"
            >
              {errorMsg}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            data-testid="sign-in-submit"
            disabled={loginMutation.isPending}
            className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loginMutation.isPending ? 'מתחבר...' : 'כניסה'}
          </button>

          {/*
            The only path a parent who has forgotten their password had was
            Mashov's own site. This is what keeps them inside the app.
          */}
          <p className="text-center text-sm">
            <Link
              href="/auth/forgot-password"
              data-testid="sign-in-forgot-password"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              שכחתי סיסמה
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center bg-background">
          <div className="h-8 w-8 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}
