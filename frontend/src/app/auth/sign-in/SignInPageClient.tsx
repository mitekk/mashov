'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { createOtpSession, getSchools, login, requestOtp } from '@/api/auth';
import { SchoolAutocomplete } from '@/components/auth/SchoolAutocomplete';
import { readAuthError } from '@/lib/authErrors';
import type { School, SignInMethod } from '@/types/api';

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/';

  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * How the parent wants to prove who they are, mirroring Mashov's own
   * `loginMethod`. `email` and `sms` are passwordless.
   */
  const [method, setMethod] = useState<SignInMethod>('password');
  const [otpRequestId, setOtpRequestId] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');

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

      // Same shape for the forced change: the parent cannot act on it here,
      // and their password is correct, so hand them the screen that fixes it
      // rather than an error they can only reread.
      if (
        (code === 'PASSWORD_CHANGE_REQUIRED' || code === 'CREDENTIALS_SETUP_REQUIRED') &&
        selectedSchool
      ) {
        const query = new URLSearchParams({
          mode: code === 'CREDENTIALS_SETUP_REQUIRED' ? 'credentials' : 'password',
          semel: String(selectedSchool.semel),
          username: username.trim(),
          ...(challengeId ? { cid: challengeId } : {}),
        });
        router.push(`/auth/complete-setup?${query.toString()}`);
        return;
      }

      setErrorMsg(message);
    },
  });

  /**
   * Passwordless step 1.
   *
   * The 409 it can answer is not an error to paper over: our background sync
   * decrypts a stored password, so a school that has never been signed into
   * with one cannot be signed into without one. The server checks that BEFORE
   * sending a code, so the parent is never left holding a code they cannot use.
   */
  const otpRequestMutation = useMutation({
    mutationFn: requestOtp,
    onSuccess: (data) => setOtpRequestId(data.otpRequestId),
    onError: (err) => setErrorMsg(readAuthError(err).message),
  });

  const otpSessionMutation = useMutation({
    mutationFn: (code: string) => createOtpSession(otpRequestId ?? '', { code }),
    onSuccess: (data) => {
      try {
        if (selectedSchool) {
          localStorage.setItem('mashov.lastSchoolSemel', String(selectedSchool.semel));
        }
      } catch {
        // localStorage unavailable - ignore
      }
      router.push(
        data.isFirstLogin ? '/auth/syncing' : nextPath.startsWith('/auth') ? '/' : nextPath,
      );
    },
    onError: (err) => setErrorMsg(readAuthError(err).message),
  });

  /** Everything the form collects before a method-specific step. */
  function identityOrError(): { semel: number; username: string } | null {
    if (!selectedSchool) {
      setErrorMsg('יש לבחור בית ספר');
      return null;
    }
    if (!username.trim()) {
      setErrorMsg('יש להזין שם משתמש');
      return null;
    }
    return { semel: selectedSchool.semel, username: username.trim() };
  }

  function handleRequestCode() {
    setErrorMsg(null);
    const identity = identityOrError();
    if (!identity || method === 'password') return;
    otpRequestMutation.mutate({ ...identity, method });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);

    const identity = identityOrError();
    if (!identity) return;

    if (method !== 'password') {
      if (!otpRequestId) {
        handleRequestCode();
        return;
      }
      if (!otpCode.trim()) {
        setErrorMsg('יש להזין את קוד האימות');
        return;
      }
      otpSessionMutation.mutate(otpCode);
      return;
    }

    if (!password) {
      setErrorMsg('יש להזין סיסמה');
      return;
    }

    loginMutation.mutate({ ...identity, password });
  }

  const pending =
    loginMutation.isPending ||
    otpRequestMutation.isPending ||
    otpSessionMutation.isPending;

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
          {/*
            Mirrors Mashov's own `loginMethod`. The passwordless options are
            offered rather than hidden, with their one real constraint stated
            below rather than discovered later.
          */}
          <fieldset className="space-y-1.5">
            <legend className="block text-sm font-medium text-foreground">
              אופן הכניסה
            </legend>
            <div className="flex gap-2">
              {(
                [
                  ['password', 'סיסמה'],
                  ['email', 'קוד לאימייל'],
                  ['sms', 'קוד בסמס'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`sign-in-method-${value}`}
                  aria-pressed={method === value}
                  onClick={() => {
                    setMethod(value);
                    // A method change invalidates a code already requested on
                    // the other channel.
                    setOtpRequestId(null);
                    setOtpCode('');
                    setErrorMsg(null);
                  }}
                  className={
                    method === value
                      ? 'flex-1 rounded-xl border border-primary bg-primary/10 px-2 py-2 text-xs font-semibold text-primary'
                      : 'flex-1 rounded-xl border border-input px-2 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/50 transition-colors'
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

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

          {method === 'password' ? (
            <>
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
            </>
          ) : (
            <>
              {/*
                Stated up front, not discovered after signing in: the
                sixteen background tasks that keep this data fresh re-login
                by decrypting a stored password, so a passwordless-only
                household would see an app that never updates.
              */}
              <p
                data-testid="sign-in-passwordless-note"
                className="rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground"
              >
                כניסה עם קוד חד-פעמי אפשרית לבית ספר שכבר נכנסת אליו עם סיסמה. העדכון
                האוטומטי של הנתונים ברקע ממשיך להסתמך על הסיסמה השמורה.
              </p>

              {!otpRequestId ? (
                <button
                  type="button"
                  data-testid="sign-in-request-code"
                  disabled={pending}
                  onClick={handleRequestCode}
                  className="w-full rounded-xl border border-primary px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/5 disabled:opacity-60"
                >
                  {otpRequestMutation.isPending ? 'שולח קוד…' : 'שליחת קוד אימות'}
                </button>
              ) : (
                <div className="space-y-1.5">
                  <label
                    htmlFor="sign-in-otp-code-input"
                    className="block text-sm font-medium text-foreground"
                  >
                    קוד האימות
                  </label>
                  <input
                    id="sign-in-otp-code-input"
                    type="text"
                    data-testid="sign-in-otp-code"
                    dir="ltr"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm tracking-widest text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
                  />
                </div>
              )}
            </>
          )}

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
            disabled={pending}
            className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {pending ? 'מתחבר...' : 'כניסה'}
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
