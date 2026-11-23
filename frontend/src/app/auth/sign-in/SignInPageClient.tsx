'use client';

import React, { useState, useMemo, useEffect, Suspense } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getSchools, login } from '@/api/auth';
import { SchoolAutocomplete } from '@/components/auth/SchoolAutocomplete';
import { ApiError } from '@/api/client';
import type { School } from '@/types/api';
// Static import, not /public: it hands <Image> the intrinsic 1000x750 so the
// box is reserved before the bytes land, and it is served from
// /_next/static/media/, which middleware.ts treats as public. A file in
// /public is matched by the auth guard and would 307 to this very page for
// the signed-out visitor who is looking at it.
import signInIllustration from '@/assets/images/sign-in-illustration.png';

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
      if (err instanceof ApiError && (err.status === 401 || err.status === 429)) {
        setErrorMsg('פרטי הכניסה שגויים, נסה שוב');
      } else {
        setErrorMsg('אירעה שגיאה, נסה שוב מאוחר יותר');
      }
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
    <div className="min-h-dvh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* alt="" on purpose: this is decoration. A screen reader announcing a
            description of the artwork before the login form would be noise, and
            the heading below already says what the page is.

            `sizes` breaks at 533px because that is where 60vw meets the 320px
            cap -- below it the rendered width really is 60vw, above it the
            image is a fixed 320px however wide the viewport gets. Describing it
            as 320px everywhere would make a 390px phone fetch a 1080w variant
            to paint 234 CSS px. `priority` is this route's one LCP element. */}
        <Image
          src={signInIllustration}
          alt=""
          priority
          sizes="(max-width: 533px) 60vw, 320px"
          className="mx-auto mb-6 h-auto w-[60vw] max-w-[320px]"
          data-testid="sign-in-illustration"
        />

        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-foreground">כניסה למרכז הורים</h1>
          <p className="mt-1 text-sm text-muted-foreground">הכנס את פרטי החשבון שלך</p>
        </div>

        {/* Card-shaped so hydration does not move the illustration above it. */}
        <Suspense
          fallback={
            <div className="flex min-h-[19rem] items-center justify-center rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
              <div className="h-8 w-8 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
            </div>
          }
        >
          <SignInForm />
        </Suspense>
      </div>
    </div>
  );
}
