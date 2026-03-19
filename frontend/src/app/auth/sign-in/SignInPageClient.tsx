'use client';

import React, { useState, useMemo, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getSchools, login } from '@/api/auth';
import { ApiError } from '@/api/client';
import type { School } from '@/types/api';

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/';

  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [schoolSearch, setSchoolSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data: schools = [] } = useQuery({
    queryKey: ['schools'],
    queryFn: getSchools,
    staleTime: 10 * 60_000,
  });

  const filteredSchools = useMemo(() => {
    if (!schoolSearch.trim()) return schools.slice(0, 50);
    const q = schoolSearch.toLowerCase();
    return schools
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          String(s.semel).includes(q),
      )
      .slice(0, 50);
  }, [schools, schoolSearch]);

  useEffect(() => {
    if (schools.length === 0 || selectedSchool) return;
    try {
      const saved = localStorage.getItem('mashov.lastSchoolSemel');
      if (!saved) return;
      const semel = Number(saved);
      const match = schools.find((s) => s.semel === semel);
      if (match) handleSelectSchool(match);
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

  function handleSelectSchool(school: School) {
    setSelectedSchool(school);
    setSchoolSearch(school.name);
    setShowDropdown(false);
  }

  function handleSchoolSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSchoolSearch(e.target.value);
    setShowDropdown(true);
    if (selectedSchool && e.target.value !== selectedSchool.name) {
      setSelectedSchool(null);
    }
  }

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
          {/* School selector */}
          <div className="relative space-y-1.5">
            <label
              htmlFor="school-search"
              className="block text-sm font-medium text-foreground"
            >
              בית ספר
            </label>
            <input
              id="school-search"
              type="text"
              data-testid="sign-in-school-selector"
              autoComplete="off"
              placeholder="חפש בית ספר..."
              value={schoolSearch}
              onChange={handleSchoolSearchChange}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
            />
            {showDropdown && filteredSchools.length > 0 && (
              <ul
                className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg"
                role="listbox"
              >
                {filteredSchools.map((school) => (
                  <li
                    key={school.semel}
                    role="option"
                    aria-selected={selectedSchool?.semel === school.semel}
                    onMouseDown={() => handleSelectSchool(school)}
                    className="cursor-pointer px-3 py-2.5 text-sm text-popover-foreground hover:bg-accent transition-colors"
                  >
                    <span className="font-medium">{school.name}</span>
                    <span className="mr-2 text-xs text-muted-foreground">{school.semel}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

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
