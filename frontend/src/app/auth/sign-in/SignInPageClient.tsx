'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMeOrNull, getSchools, login } from '@/api/auth';
import { SchoolAutocomplete } from '@/components/auth/SchoolAutocomplete';
import { CaptchaEscapeHatch } from '@/components/auth/CaptchaEscapeHatch';
import { readAuthError } from '@/lib/authErrors';
import { safeNextPath } from '@/lib/next-path';
import type { School } from '@/types/api';
// Static import, not /public: it hands <Image> the intrinsic 1000x750 so the
// box is reserved before the bytes land, and it is served from
// /_next/static/media/, which middleware.ts treats as public. A file in
// /public is matched by the auth guard and would 307 to this very page for
// the signed-out visitor who is looking at it.
import signInIllustration from '@/assets/images/sign-in-illustration.png';
import { CenteredShell } from '@/components/layout/CenteredShell';

/**
 * The spinner card, shared by the Suspense boundary below and by the form
 * itself while the session probe is in flight.
 *
 * It MUST be one component, not two copies: `useQuery` does not suspend, so
 * the Suspense fallback will not re-show for the probe, and the
 * anti-layout-shift height contract documented at the boundary has to hold
 * for both states or the illustration jumps.
 */
function SignInFormFallback() {
  return (
    <div
      data-testid="sign-in-loading"
      className="flex min-h-[31rem] items-center justify-center rounded-2xl border border-border/60 bg-card p-6 shadow-sm"
    >
      <div className="h-8 w-8 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
    </div>
  );
}

/**
 * The form only -- no page chrome.
 *
 * The split is not cosmetic and has to survive: this component calls
 * `useSearchParams()`, which makes its Suspense boundary bail out of SSR, so
 * anything rendered inside it is absent from the server HTML. The illustration
 * and the heading therefore live in `SignInPage` below, which is where the
 * reason is written down.
 */
function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  // Sanitised at the boundary, so BOTH consumers below -- the bounce and the
  // post-login push -- are safe by construction. `next` arrives from a query
  // string and used to be pushed into the router verbatim.
  const nextParam = searchParams.get('next');
  const nextPath = safeNextPath(nextParam);

  /**
   * Is there already a live session?
   *
   * Telegram deep links point at /home, and a browser that does not send the
   * cookie on that first hop gets bounced here -- so a signed-in parent was
   * being asked for credentials they did not need to retype. /auth/ is in
   * middleware's PUBLIC_PATHS, so nothing upstream of this component checks.
   *
   * Why the check cannot simply move to the edge: `mashov_session` is set
   * `sameSite: 'strict'` (`auth.controller.ts:90`), so a top-level navigation
   * STARTED BY Telegram is cross-site and carries no cookie at all --
   * middleware is blind on exactly the request that matters, and bounces a
   * validly signed-in parent here regardless. This probe is an XHR issued by a
   * document already on our origin, so it is same-site and does carry it.
   *
   * Probing the real endpoint rather than the cookie in middleware is also
   * what makes this loop-free: the answer is the session's actual validity, so a
   * stale-but-present cookie renders the form instead of ping-ponging
   * /auth/sign-in -> /home -> /auth/sign-in.
   *
   * Gated on `next` being PRESENT, which is load-bearing rather than an
   * optimisation. `middleware.ts:81` is the only thing in the system that ever
   * appends `next` -- every in-app navigation here (`useAuth`'s sign-out and
   * its 401 handler, `MorePageClient`'s sign-out and disconnect-all,
   * `handle401Redirect`) pushes a BARE /auth/sign-in. So `next` present means
   * "something sent me here to resume a journey", and absent means "I just
   * left the app". Without the gate, a sign-out whose DELETE failed --
   * `useSignOut` redirects here on error anyway, with the cookie possibly
   * still live -- would read 200 and throw the parent straight back in: an app
   * that cannot be signed out of.
   *
   * A distinct key, NOT ['me']: `useMe()` is typed `AppUser` and four pages
   * consume it, so writing `null` there would hand them a null user. Seeding
   * ['me'] on success only (below) is safe, and saves the destination a round
   * trip.
   */
  const session = useQuery({
    queryKey: ['sign-in-session-probe'],
    queryFn: getMeOrNull,
    enabled: nextParam !== null,
    // Not optional: `providers.tsx` sets a global `retry: 2` with a 1s/2s
    // backoff, so a signed-out parent would watch the spinner for 3s before
    // the form appeared.
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!session.data) return;
    queryClient.setQueryData(['me'], session.data);
    // `replace`, not `push`: this page must not sit in history, or Back from
    // the destination returns here and bounces forward again.
    router.replace(nextPath);
  }, [session.data, nextPath, router, queryClient]);

  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * The last error's CODE, kept beside its message only so the captcha
   * escape hatch can be gated on `CAPTCHA_REQUIRED` -- it must never show
   * in the happy path.
   */
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);

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
        router.push(nextPath);
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
        // The username is NOT in the query. For these accounts it is the
        // parent's national ID number, so a query string puts it in browser
        // history and in every reverse-proxy access log. The next screen asks
        // for it, exactly as it already asks for the password.
        const query = new URLSearchParams({
          cid: challengeId,
          semel: String(selectedSchool.semel),
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
        // Same reason as the MFA route above: no ID number in the URL.
        const query = new URLSearchParams({
          mode: code === 'CREDENTIALS_SETUP_REQUIRED' ? 'credentials' : 'password',
          semel: String(selectedSchool.semel),
          ...(challengeId ? { cid: challengeId } : {}),
        });
        router.push(`/auth/complete-setup?${query.toString()}`);
        return;
      }

      setErrorCode(code);
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
  /** Everything the form collects before submitting. */
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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setErrorCode(undefined);

    const identity = identityOrError();
    if (!identity) return;

    if (!password) {
      setErrorMsg('יש להזין סיסמה');
      return;
    }

    loginMutation.mutate({ ...identity, password });
  }

  const pending = loginMutation.isPending;

  // The `nextParam` term is NOT redundant: a disabled react-query sits at
  // `status: 'pending'` with `fetchStatus: 'idle'` forever, so `isPending`
  // alone would spin for every parent who arrives without `next` -- which is
  // all of them, bar a deep link.
  //
  // `session.data` stays in the condition so the form never flashes during the
  // `replace` above. Any error -- 401, a network failure, the 4s timeout --
  // leaves `isPending` false and `data` undefined, so the form renders: there
  // is no path to a stuck spinner.
  const bouncing = nextParam !== null && (session.isPending || session.data != null);
  if (bouncing) return <SignInFormFallback />;

  return (
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

      {errorCode === 'CAPTCHA_REQUIRED' && (
        <CaptchaEscapeHatch testIdPrefix="sign-in" />
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
  );
}

export default function SignInPage() {
  // The page chrome lives OUTSIDE the Suspense boundary on purpose. SignInForm
  // calls useSearchParams(), which makes its boundary bail out of SSR and
  // render on the client -- so anything inside it is absent from the server
  // HTML. An <Image priority> in there emits no <link rel="preload"> and waits
  // for hydration, which is the whole benefit gone. Hoisted out, the
  // illustration and heading are server-rendered and the preload is in the
  // first response; only the form, which genuinely needs the query string,
  // waits.
  return (
    // At 1280 a 320px card floating in whitespace is not a layout, it is an
    // accident. From lg the illustration moves beside the form instead of
    // above it, so `panelClassName` widens the panel to hold two columns.
    <CenteredShell panelClassName="lg:grid lg:max-w-4xl lg:grid-cols-2 lg:items-center lg:gap-10">
      <div className="lg:order-last">
        {/* alt="" on purpose: this is decoration. A screen reader announcing a
            description of the artwork before the login form would be noise, and
            the heading below already says what the page is.

            `sizes` breaks at 533px because that is where 60vw meets the 320px
            cap -- below it the rendered width really is 60vw, above it the
            image is a fixed 320px however wide the viewport gets. Describing it
            as 320px everywhere would make a 390px phone fetch a 1080w variant
            to paint 234 CSS px. The third stop is the lg two-column layout,
            where the image fills a ~420px grid column instead. `priority` is
            this route's one LCP element. */}
        <Image
          src={signInIllustration}
          alt=""
          priority
          sizes="(max-width: 533px) 60vw, (max-width: 1023px) 320px, 420px"
          className="mx-auto mb-6 h-auto w-[60vw] max-w-[320px] lg:mb-0 lg:w-full"
          data-testid="sign-in-illustration"
        />
      </div>

      <div>
        <div className="mb-8 text-center lg:text-start">
          <h1 className="text-2xl font-bold text-foreground">כניסה למרכז הורים</h1>
          <p className="mt-1 text-sm text-muted-foreground">הכנס את פרטי החשבון שלך</p>
        </div>

        {/*
          Card-shaped so hydration does not move the illustration above it.

          The height tracks the PASSWORD card, which is the one a cold visitor
          sees. 19rem matched the original three-field form; this one opens with
          the entry-method switch and closes with the forgot-password link, so
          the old number would under-reserve and let the illustration jump on
          hydration -- the exact shift this fallback exists to prevent. The
          passwordless variants differ in height, but reaching one takes a
          click, by which point hydration is long done.
        */}
        <Suspense fallback={<SignInFormFallback />}>
          <SignInForm />
        </Suspense>
      </div>
    </CenteredShell>
  );
}
