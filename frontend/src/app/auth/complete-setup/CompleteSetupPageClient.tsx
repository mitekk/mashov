'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { setCredentials } from '@/api/auth';
import { CaptchaEscapeHatch } from '@/components/auth/CaptchaEscapeHatch';
import { authErrorText, readAuthError } from '@/lib/authErrors';
import { PASSWORD_RULES, brokenRules } from '@/lib/passwordPolicy';
import { CenteredShell } from '@/components/layout/CenteredShell';

/**
 * The forced credential change.
 *
 * Reached when `POST /auth/login` answers `PASSWORD_CHANGE_REQUIRED` (Mashov's
 * `ChangePass`) or `CREDENTIALS_SETUP_REQUIRED` (`SetUsernameAndPass` /
 * `CreateUsername`). In all of those the parent's password is CORRECT and
 * Mashov still will not let them in. Collapsed into "wrong password", it was a
 * loop of retyping a right password until the rate limiter locked them out.
 *
 * The current password is asked for again rather than carried from the sign-in
 * form: it never goes in a URL or in browser storage, Mashov's own change
 * routes require it to prove the change, and our backend stores the NEW one for
 * the background sync afterwards.
 *
 * Unlike the recovery screen, the username is known here, so the live checklist
 * can include the relational "must not contain the username" rule.
 */
function CompleteSetupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const semel = Number(searchParams.get('semel') ?? '');
  /**
   * Collected here, not read from the query -- the Mashov username is the
   * parent's national ID number for these accounts, and a query string puts it
   * in browser history and every access log.
   */
  const [username, setUsername] = useState(searchParams.get('username') ?? '');
  const challengeId = searchParams.get('cid') ?? '';
  /** `credentials` also asks for a username; `password` is a change only. */
  const mode = searchParams.get('mode') === 'credentials' ? 'credentials' : 'password';

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * The last error's CODE, kept beside its message only so the captcha
   * escape hatch can be gated on `CAPTCHA_REQUIRED` -- it must never show
   * in the happy path.
   */
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);

  const effectiveUsername = newUsername.trim() || username.trim();
  const broken = brokenRules(newPassword, effectiveUsername);

  const mutation = useMutation({
    mutationFn: () =>
      setCredentials({
        semel,
        username: username.trim(),
        password: currentPassword,
        newPassword,
        ...(mode === 'credentials' && newUsername.trim()
          ? { newUsername: newUsername.trim() }
          : {}),
        ...(challengeId ? { challengeId } : {}),
      }),
    onSuccess: (data) => router.push(data.isFirstLogin ? '/auth/syncing' : '/'),
    onError: (err) => {
      const read = readAuthError(err);

      // Mashov can demand a one-time code before it will accept the change,
      // and it sends a challenge id with that refusal. Routing onward beats
      // rendering "a code is required" on a screen with no way to enter one.
      if (read.code === 'MFA_REQUIRED' && read.challengeId) {
        const query = new URLSearchParams({
          cid: read.challengeId,
          semel: String(semel),
        });
        router.push(`/auth/mfa?${query.toString()}`);
        return;
      }

      setErrorCode(read.code);
      setErrorMsg(authErrorText(read));
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
    if (!currentPassword) {
      setErrorMsg('יש להזין את הסיסמה הנוכחית');
      return;
    }
    if (broken.length > 0) {
      setErrorMsg('הסיסמה החדשה אינה עומדת בדרישות משוב');
      return;
    }

    mutation.mutate();
  }

  if (!Number.isFinite(semel) || semel <= 0) {
    return (
      <Shell title="הקישור אינו בתוקף">
        <p className="text-sm text-muted-foreground">
          חסרים פרטים להשלמת ההגדרה. יש להתחבר מחדש.
        </p>
        <Link
          href="/auth/sign-in"
          data-testid="complete-setup-start-again"
          className="mt-4 block w-full rounded-xl bg-primary px-4 py-2.5 text-center text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          חזרה לכניסה
        </Link>
      </Shell>
    );
  }

  return (
    <Shell
      title={mode === 'credentials' ? 'השלמת הגדרת החשבון' : 'החלפת סיסמה'}
    >
      <p className="mb-4 text-sm text-muted-foreground">
        {mode === 'credentials'
          ? 'משוב דורש להגדיר שם משתמש וסיסמה לפני הכניסה.'
          : 'משוב דורש החלפת סיסמה לפני הכניסה. הסיסמה הנוכחית שלך נכונה.'}
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field
          id="complete-setup-username"
          label="שם המשתמש שלך במשוב"
          type="text"
          autoComplete="username"
          dir="ltr"
          value={username}
          onChange={setUsername}
        />

        <Field
          id="complete-setup-current-password"
          label="הסיסמה הנוכחית במשוב"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
        />

        {mode === 'credentials' && (
          <Field
            id="complete-setup-new-username"
            label="שם משתמש חדש"
            type="text"
            autoComplete="username"
            dir="ltr"
            value={newUsername}
            onChange={setNewUsername}
          />
        )}

        <Field
          id="complete-setup-new-password"
          label="סיסמה חדשה"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={setNewPassword}
        />

        {/* Live, for the same reason as the reset screen: the parent must not
            be able to press the button on a password Mashov will refuse. */}
        <ul data-testid="complete-setup-policy-checklist" className="space-y-1">
          {PASSWORD_RULES.map((rule) => {
            const satisfied = !broken.includes(rule.id);
            return (
              <li
                key={rule.id}
                data-testid={`complete-setup-rule-${rule.id}`}
                data-satisfied={String(satisfied)}
                className={
                  satisfied
                    ? 'flex items-center gap-2 text-xs text-primary'
                    : 'flex items-center gap-2 text-xs text-muted-foreground'
                }
              >
                {satisfied ? (
                  <Check className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                ) : (
                  <X className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                )}
                <span>{rule.message}</span>
              </li>
            );
          })}
        </ul>

        {errorMsg && (
          <p
            data-testid="complete-setup-error"
            role="alert"
            className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
          >
            {errorMsg}
          </p>
        )}

        {errorCode === 'CAPTCHA_REQUIRED' && (
          <CaptchaEscapeHatch testIdPrefix="complete-setup" />
        )}

        <button
          type="submit"
          data-testid="complete-setup-submit"
          disabled={mutation.isPending}
          className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {mutation.isPending ? 'שומר…' : 'שמירה וכניסה'}
        </button>

        <p className="text-center text-sm">
          <Link
            href="/auth/sign-in"
            data-testid="complete-setup-back-to-sign-in"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            חזרה לכניסה
          </Link>
        </p>
      </form>
    </Shell>
  );
}

function Field({
  id,
  label,
  type,
  autoComplete,
  dir,
  value,
  onChange,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  dir?: 'ltr';
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-input`} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={`${id}-input`}
        type={type}
        data-testid={id}
        autoComplete={autoComplete}
        dir={dir}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
      />
    </div>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <CenteredShell>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
      </div>
      <div className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
        {children}
      </div>
    </CenteredShell>
  );
}

export default function CompleteSetupPageClient() {
  return (
    <Suspense
      fallback={
        <CenteredShell>
          <div className="mx-auto h-8 w-8 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        </CenteredShell>
      }
    >
      <CompleteSetupForm />
    </Suspense>
  );
}
