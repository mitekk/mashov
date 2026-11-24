'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { startRecovery } from '@/api/auth';
import { SchoolAutocomplete } from '@/components/auth/SchoolAutocomplete';
import { CaptchaEscapeHatch } from '@/components/auth/CaptchaEscapeHatch';
import { readAuthError } from '@/lib/authErrors';
import type { RecoveryChannel, School } from '@/types/api';
import { CenteredShell } from '@/components/layout/CenteredShell';

/**
 * Step 1 of password recovery: who you are, and where to send the code.
 *
 * Until this existed, a parent who forgot their Mashov password had no path
 * inside our app at all -- only Mashov's own site.
 *
 * ## The copy is a security control, not decoration
 *
 * The server answers an identical `202` for a real account and an unknown one,
 * specifically so this endpoint cannot be used to test whether an ID number is
 * registered at a school. Screen copy that said "a code was sent to your
 * email" would hand that back. So the page states the condition up front and
 * never confirms a send: `אם הפרטים נכונים, נשלח קוד אימות…`.
 */
function ForgotPasswordForm() {
  const router = useRouter();

  const [school, setSchool] = useState<School | null>(null);
  const [idNumber, setIdNumber] = useState('');
  const [channel, setChannel] = useState<RecoveryChannel>('email');
  // Mashov takes the destination from the parent and checks it against what
  // the school holds; it does not send to a contact it already has. Kept per
  // channel so switching tabs does not drop what was typed.
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * The last error's CODE, kept beside its message only so the captcha
   * escape hatch can be gated on `CAPTCHA_REQUIRED` -- it must never show
   * in the happy path.
   */
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);

  const mutation = useMutation({
    mutationFn: startRecovery,
    onSuccess: (data) => {
      // The recoveryId travels in the URL: opaque, single-use, and TTL'd
      // server-side, so it is safe there in a way a verification code is not --
      // and a refresh of the reset form does not strand the parent.
      //
      // The semel rides along because the reset form auto signs in afterwards
      // and `POST /auth/login` needs it. It is a public school code, not a
      // secret: the sign-in page's own picker is populated from the same list.
      const query = new URLSearchParams({
        rid: data.recoveryId,
        semel: String(school?.semel ?? ''),
        // A hint, not an authority: the server already told us whether Mashov
        // sent codes to both channels, so the reset form can render both fields
        // immediately instead of making the parent submit once to find out. The
        // server-stored flag still decides, so a dropped or forged hint only
        // costs the round trip this saves.
        ...(data.requiresSecondChannel ? { two: '1' } : {}),
      });
      router.push(`/auth/reset-password?${query.toString()}`);
    },
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

    if (!school) {
      setErrorMsg('יש לבחור בית ספר');
      return;
    }
    if (!idNumber.trim()) {
      setErrorMsg('יש להזין מספר זהות');
      return;
    }

    const destination = (channel === 'sms' ? phone : email).trim();
    if (!destination) {
      setErrorMsg(
        channel === 'sms' ? 'יש להזין מספר טלפון נייד' : 'יש להזין כתובת אימייל',
      );
      return;
    }

    mutation.mutate({
      semel: school.semel,
      idNumber: idNumber.trim(),
      channel,
      destination,
    });
  }

  return (
    <CenteredShell>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-foreground">שכחתי סיסמה</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          נאפס את הסיסמה שלך במשוב, בלי לצאת מהאפליקציה
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm space-y-5"
      >
        <SchoolAutocomplete
          value={school}
          onSelect={setSchool}
          onClear={() => setSchool(null)}
          inputTestId="forgot-password-school-selector"
          optionTestIdPrefix="school-option"
        />

        <div className="space-y-1.5">
          <label
            htmlFor="forgot-password-id-number-input"
            className="block text-sm font-medium text-foreground"
          >
            מספר זהות
          </label>
          <input
            id="forgot-password-id-number-input"
            type="text"
            data-testid="forgot-password-id-number"
            // RTL detail that bites: an ID number in an RTL input renders
            // with its digits in the wrong visual order.
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            value={idNumber}
            onChange={(event) => setIdNumber(event.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
          />
        </div>

        <fieldset className="space-y-1.5">
          <legend className="block text-sm font-medium text-foreground">
            לאן לשלוח את קוד האימות
          </legend>
          <div className="flex gap-2">
            {(
              [
                ['email', 'לאימייל'],
                ['sms', 'לטלפון'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-testid={`forgot-password-channel-${value}`}
                aria-pressed={channel === value}
                onClick={() => setChannel(value)}
                className={
                  channel === value
                    ? 'flex-1 rounded-xl border border-primary bg-primary/10 px-3 py-2 text-sm font-semibold text-primary'
                    : 'flex-1 rounded-xl border border-input px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent/50 transition-colors'
                }
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <label
            htmlFor="forgot-password-destination-input"
            className="block text-sm font-medium text-foreground"
          >
            {channel === 'sms' ? 'מספר טלפון נייד' : 'כתובת אימייל'}
          </label>
          <input
            id="forgot-password-destination-input"
            // `tel` and `email` rather than `text`: the mobile keyboard is the
            // whole difference between typing this easily and not.
            type={channel === 'sms' ? 'tel' : 'email'}
            data-testid="forgot-password-destination"
            // Same RTL detail as the ID field: an address or a phone number
            // renders with its characters in the wrong visual order in an RTL
            // input.
            dir="ltr"
            inputMode={channel === 'sms' ? 'tel' : 'email'}
            autoComplete={channel === 'sms' ? 'tel' : 'email'}
            value={channel === 'sms' ? phone : email}
            onChange={(event) =>
              channel === 'sms'
                ? setPhone(event.target.value)
                : setEmail(event.target.value)
            }
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
          />
        </div>

        {/*
          Stated before anything is submitted, and phrased as a condition.
          The server's 202 is identical for a real and an unknown account;
          copy confirming a send would give that back.

          The condition now names the destination, because Mashov checks the
          typed address against the school's record rather than sending to a
          contact it already holds.
        */}
        <p
          data-testid="forgot-password-privacy-note"
          className="rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground"
        >
          אם הפרטים נכונים ו
          {channel === 'email' ? 'כתובת האימייל ' : 'מספר הטלפון '}
          תואם את הרשום במשוב, יישלח קוד אימות.
        </p>

        {errorMsg && (
          <p
            data-testid="forgot-password-error"
            role="alert"
            className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
          >
            {errorMsg}
          </p>
        )}

        {/*
          Defensive, and currently unreachable: step 1 folds `UserSuspended`
          into the indistinguishable 202 on purpose, because Mashov only
          escalates to a captcha for accounts it RECOGNISES -- so surfacing
          CAPTCHA_REQUIRED here would be a perfect "does this ID exist"
          oracle. Kept because the day that fold changes, this screen should
          not be the one place with no way out.
        */}
        {errorCode === 'CAPTCHA_REQUIRED' && (
          <CaptchaEscapeHatch testIdPrefix="forgot-password" />
        )}

        <button
          type="submit"
          data-testid="forgot-password-submit"
          disabled={mutation.isPending}
          className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {mutation.isPending ? 'שולח…' : 'שליחת קוד אימות'}
        </button>

        <p className="text-center text-sm">
          <Link
            href="/auth/sign-in"
            data-testid="forgot-password-back-to-sign-in"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            חזרה לכניסה
          </Link>
        </p>
      </form>
    </CenteredShell>
  );
}

export default function ForgotPasswordPageClient() {
  return (
    <Suspense
      fallback={
        <CenteredShell>
          <div className="mx-auto h-8 w-8 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        </CenteredShell>
      }
    >
      <ForgotPasswordForm />
    </Suspense>
  );
}
