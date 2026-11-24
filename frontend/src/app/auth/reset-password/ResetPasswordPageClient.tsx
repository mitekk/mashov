'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { completeRecovery, login } from '@/api/auth';
import { authErrorText, readAuthError } from '@/lib/authErrors';
import { PASSWORD_RULES, brokenRules } from '@/lib/passwordPolicy';
import { CenteredShell } from '@/components/layout/CenteredShell';

/**
 * Step 2 of password recovery: the code, and the new password.
 *
 * ## The live checklist is the point
 *
 * `POST /api/user/reset/{code}` answers `404` for a password-policy violation
 * exactly as it does for a bad code, and the code is single-use. A parent who
 * submits a six-letter password is told their code was wrong, with no way back.
 * The backend validates the policy before calling upstream so a 404 is
 * unambiguous -- and this checklist exists so the parent never gets that far.
 *
 * ## Auto sign-in happens HERE, not on the server
 *
 * The recovery flow is unauthenticated and keyed by an ID number, so whoever
 * completes it has proved control of the school-registered email or phone --
 * not ownership of our household, which in a merged household is provably not
 * the same person. So the server mints no session and writes no credential.
 * This form holds the new password in memory and chains into the ordinary
 * `POST /auth/login`, which re-encrypts it, refreshes the roster and heals the
 * connection. Same experience, boundary intact.
 */
function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const recoveryId = searchParams.get('rid') ?? '';
  const semel = Number(searchParams.get('semel') ?? '');

  const [code, setCode] = useState('');
  const [secondCode, setSecondCode] = useState('');
  /**
   * Whether Mashov wants a code from both channels.
   *
   * Seeded from the `two=1` hint step 1 passed on, so a two-channel parent sees
   * both fields immediately rather than discovering the second one by
   * submitting and reading an error. The hint is only ever a HINT: the
   * server-stored flag is the authority, and `SECOND_CODE_REQUIRED` still turns
   * this on for a client that arrived without it.
   */
  const [needsSecondCode, setNeedsSecondCode] = useState(
    searchParams.get('two') === '1',
  );
  const [newPassword, setNewPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState<{ username: string | null } | null>(null);

  // The username is not known until the reset succeeds, so the relational rule
  // is checked against nothing until then. That is the honest state: a parent
  // recovering a password does not necessarily remember their username.
  const broken = brokenRules(newPassword);

  const resetMutation = useMutation({
    mutationFn: () =>
      completeRecovery(recoveryId, {
        code,
        ...(needsSecondCode && secondCode.trim() ? { secondCode } : {}),
        newPassword,
      }),
    onSuccess: (data) => {
      setDone({ username: data.username ?? null });
      // Best effort. A failure here is not a failed reset -- the password HAS
      // changed in Mashov -- so the success panel stands either way and offers
      // a sign-in link.
      if (data.username && Number.isFinite(semel) && semel > 0) {
        signInMutation.mutate({ semel, username: data.username, password: newPassword });
      }
    },
    onError: (err) => {
      const read = readAuthError(err);
      const { code: errorCode } = read;

      if (errorCode === 'SECOND_CODE_REQUIRED') {
        // Mashov sent a code to both channels. Revealed by the server, not
        // guessed at: a client that could choose the single-code route would be
        // choosing its own authorisation strength.
        setNeedsSecondCode(true);
        setErrorMsg('משוב שלח קוד גם לאימייל וגם לטלפון. יש להזין את שני הקודים.');
        return;
      }
      // Both mean "this recovery is over, start again", and the server has
      // already deleted the handle in the locked case -- so the next attempt
      // would answer RECOVERY_SESSION_EXPIRED anyway. Showing an error the
      // parent cannot act on, and only then the start-again panel, is two
      // screens for one dead end.
      if (
        errorCode === 'RECOVERY_SESSION_EXPIRED' ||
        errorCode === 'RECOVERY_LOCKED'
      ) {
        setExpired(true);
        return;
      }
      // `authErrorText`, not the code's own copy: a 422 WEAK_PASSWORD carries
      // the broken rules' Hebrew messages in `details[]`, and the checklist on
      // this screen deliberately hides the relational rule -- so the detail is
      // the only thing that tells the parent what to change.
      setErrorMsg(authErrorText(read));
    },
  });

  const signInMutation = useMutation({
    mutationFn: login,
    onSuccess: (data) => router.push(data.isFirstLogin ? '/auth/syncing' : '/'),
    // Swallowed on purpose: the reset succeeded, and the success panel already
    // offers a manual sign-in link.
    onError: () => undefined,
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMsg(null);

    if (!code.trim()) {
      setErrorMsg('יש להזין את קוד האימות');
      return;
    }
    if (needsSecondCode && !secondCode.trim()) {
      setErrorMsg('יש להזין את שני הקודים');
      return;
    }
    if (broken.length > 0) {
      setErrorMsg('הסיסמה אינה עומדת בדרישות משוב');
      return;
    }

    resetMutation.mutate();
  }

  if (!recoveryId || expired) {
    return (
      <Shell title="הקישור אינו בתוקף">
        <p className="text-sm text-muted-foreground">
          תהליך איפוס הסיסמה פג, הסתיים או שלא התחיל. יש להתחיל מחדש.
        </p>
        <Link
          href="/auth/forgot-password"
          data-testid="reset-password-start-again"
          className="mt-4 block w-full rounded-xl bg-primary px-4 py-2.5 text-center text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          התחלה מחדש
        </Link>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell title="הסיסמה עודכנה">
        <p data-testid="reset-password-success" className="text-sm text-foreground">
          הסיסמה עודכנה במשוב.
        </p>
        {done.username && (
          <p
            data-testid="reset-password-username"
            className="mt-2 rounded-xl bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
          >
            שם המשתמש שלך: <span dir="ltr">{done.username}</span>
          </p>
        )}
        {signInMutation.isPending ? (
          <p className="mt-4 text-sm text-muted-foreground">מתחבר…</p>
        ) : (
          <Link
            href="/auth/sign-in"
            data-testid="reset-password-go-to-sign-in"
            className="mt-4 block w-full rounded-xl bg-primary px-4 py-2.5 text-center text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            כניסה עם הסיסמה החדשה
          </Link>
        )}
      </Shell>
    );
  }

  return (
    <Shell title="סיסמה חדשה">
      <form onSubmit={handleSubmit} className="space-y-5">
        <CodeField
          id="reset-password-code"
          label="קוד האימות שקיבלת"
          value={code}
          onChange={setCode}
        />

        {needsSecondCode && (
          <CodeField
            id="reset-password-second-code"
            label="הקוד מהערוץ השני"
            value={secondCode}
            onChange={setSecondCode}
          />
        )}

        <div className="space-y-1.5">
          <label
            htmlFor="reset-password-new-password-input"
            className="block text-sm font-medium text-foreground"
          >
            סיסמה חדשה
          </label>
          <input
            id="reset-password-new-password-input"
            type="password"
            data-testid="reset-password-new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
          />
        </div>

        {/*
          Live, not submit-time. Mashov's 404-on-policy-violation is
          indistinguishable from a bad code and the code is single-use, so the
          parent must never be able to press the button on a password that
          cannot work.
        */}
        <ul data-testid="reset-password-policy-checklist" className="space-y-1">
          {PASSWORD_RULES.filter((rule) => rule.id !== 'noUsername').map((rule) => {
            const satisfied = !broken.includes(rule.id);
            return (
              <li
                key={rule.id}
                data-testid={`reset-password-rule-${rule.id}`}
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
            data-testid="reset-password-error"
            role="alert"
            className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
          >
            {errorMsg}
          </p>
        )}

        <button
          type="submit"
          data-testid="reset-password-submit"
          disabled={resetMutation.isPending}
          className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {resetMutation.isPending ? 'מעדכן…' : 'עדכון סיסמה'}
        </button>
      </form>
    </Shell>
  );
}

/**
 * `dir="ltr"` and `inputMode="numeric"` so the digits do not reorder visually
 * in an RTL layout, and `autoComplete="one-time-code"` so iOS offers the code
 * straight from the SMS.
 */
function CodeField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
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
        type="text"
        data-testid={id}
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm tracking-widest text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
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

export default function ResetPasswordPageClient() {
  return (
    <Suspense
      fallback={
        <CenteredShell>
          <div className="mx-auto h-8 w-8 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        </CenteredShell>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
