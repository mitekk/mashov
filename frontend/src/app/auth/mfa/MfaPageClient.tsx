'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { createMfaSession, sendMfaCode } from '@/api/auth';
import { CaptchaEscapeHatch } from '@/components/auth/CaptchaEscapeHatch';
import { readAuthError } from '@/lib/authErrors';
import type { RecoveryChannel } from '@/types/api';

/**
 * Answering a Mashov MFA challenge, without leaving the app.
 *
 * Reached from the sign-in form when `POST /auth/login` answers
 * `400 MFA_REQUIRED` with a challenge id. Before this, that rendered as "wrong
 * credentials" and the parent retyped a correct password until the rate limiter
 * locked them out.
 *
 * ## Why it asks for the password again
 *
 * The challenge id, school and username ride in the query string; the password
 * does not, and is not put in browser storage either. So this screen asks for
 * it once more. That is deliberate, and it is not only about the URL: our
 * backend stores the password (encrypted) for the sixteen cron tasks that
 * re-login in the background, so an MFA sign-in with no password would hand
 * the parent a working session and no data updates at all, silently.
 */
function MfaForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const challengeId = searchParams.get('cid') ?? '';
  const semel = Number(searchParams.get('semel') ?? '');
  /**
   * Collected here, not read from the query.
   *
   * For these accounts the Mashov username IS the national ID number, so a
   * query string would put it in browser history and in every reverse-proxy
   * access log. The screen already asks for the password; one more field is the
   * price of keeping the identifier out of those logs.
   */
  const [username, setUsername] = useState(searchParams.get('username') ?? '');

  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * The last error's CODE, kept beside its message only so the captcha
   * escape hatch can be gated on `CAPTCHA_REQUIRED` -- it must never show
   * in the happy path.
   */
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [sentOn, setSentOn] = useState<RecoveryChannel | null>(null);

  const sendMutation = useMutation({
    mutationFn: (method: RecoveryChannel) => sendMfaCode(challengeId, { method }),
    onSuccess: (_data, method) => {
      setSentOn(method);
      setErrorMsg(null);
      setErrorCode(undefined);
    },
    onError: (err) => {
      const read = readAuthError(err);
      setErrorCode(read.code);
      setErrorMsg(read.message);
    },
  });

  const submitMutation = useMutation({
    mutationFn: () =>
      createMfaSession(challengeId, {
        semel,
        username: username.trim(),
        password,
        code,
      }),
    onSuccess: (data) => router.push(data.isFirstLogin ? '/auth/syncing' : '/'),
    onError: (err) => {
      const read = readAuthError(err);
      setErrorCode(read.code);
      setErrorMsg(read.message);
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMsg(null);
    setErrorCode(undefined);

    if (!username.trim()) {
      setErrorMsg('יש להזין את שם המשתמש שלך במשוב');
      return;
    }
    if (!code.trim()) {
      setErrorMsg('יש להזין את קוד האימות');
      return;
    }
    if (!password) {
      // Checked here so the parent gets a field-level answer rather than a
      // round trip that can only fail.
      setErrorMsg('יש להזין את הסיסמה שלך במשוב');
      return;
    }

    submitMutation.mutate();
  }

  if (!challengeId || !Number.isFinite(semel) || semel <= 0) {
    return (
      <Shell title="האימות אינו בתוקף">
        <p className="text-sm text-muted-foreground">
          תהליך האימות פג או שלא התחיל. יש להתחבר מחדש.
        </p>
        <Link
          href="/auth/sign-in"
          data-testid="mfa-start-again"
          className="mt-4 block w-full rounded-xl bg-primary px-4 py-2.5 text-center text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          חזרה לכניסה
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title="אימות דו-שלבי">
      <p className="mb-4 text-sm text-muted-foreground">
        משוב דורש קוד אימות חד-פעמי להשלמת הכניסה.
      </p>

      <div className="mb-5 flex gap-2">
        {(
          [
            ['email', 'שליחה לאימייל'],
            ['sms', 'שליחה בסמס'],
          ] as const
        ).map(([method, label]) => (
          <button
            key={method}
            type="button"
            data-testid={`mfa-send-${method}`}
            disabled={sendMutation.isPending}
            onClick={() => sendMutation.mutate(method)}
            className="flex-1 rounded-xl border border-input px-3 py-2 text-sm font-medium text-foreground hover:bg-accent/50 transition-colors disabled:opacity-60"
          >
            {label}
          </button>
        ))}
      </div>

      {sentOn && (
        <p
          data-testid="mfa-sent-note"
          className="mb-4 rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground"
        >
          {sentOn === 'email'
            ? 'הקוד נשלח לאימייל הרשום במשוב.'
            : 'הקוד נשלח לטלפון הרשום במשוב.'}
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <label
            htmlFor="mfa-username-input"
            className="block text-sm font-medium text-foreground"
          >
            שם המשתמש שלך במשוב
          </label>
          <input
            id="mfa-username-input"
            type="text"
            data-testid="mfa-username"
            dir="ltr"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="mfa-code-input"
            className="block text-sm font-medium text-foreground"
          >
            קוד האימות
          </label>
          <input
            id="mfa-code-input"
            type="text"
            data-testid="mfa-code"
            // `one-time-code` so iOS offers the code straight from the SMS, and
            // `dir="ltr"` so the digits do not reorder in an RTL layout.
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm tracking-widest text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="mfa-password-input"
            className="block text-sm font-medium text-foreground"
          >
            הסיסמה שלך במשוב
          </label>
          <input
            id="mfa-password-input"
            type="password"
            data-testid="mfa-password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          />
          <p className="text-xs text-muted-foreground">
            נדרשת שוב כדי שהנתונים ימשיכו להתעדכן ברקע.
          </p>
        </div>

        {errorMsg && (
          <p
            data-testid="mfa-error"
            role="alert"
            className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
          >
            {errorMsg}
          </p>
        )}

        {errorCode === 'CAPTCHA_REQUIRED' && (
          <CaptchaEscapeHatch testIdPrefix="mfa" />
        )}

        <button
          type="submit"
          data-testid="mfa-submit"
          disabled={submitMutation.isPending}
          className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitMutation.isPending ? 'מאמת…' : 'אימות וכניסה'}
        </button>

        <p className="text-center text-sm">
          <Link
            href="/auth/sign-in"
            data-testid="mfa-back-to-sign-in"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            חזרה לכניסה
          </Link>
        </p>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        </div>
        <div className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}

export default function MfaPageClient() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center bg-background">
          <div className="h-8 w-8 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        </div>
      }
    >
      <MfaForm />
    </Suspense>
  );
}
