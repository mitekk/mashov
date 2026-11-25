'use client';

import React, { useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChildSelect, type ChildOption } from '@/components/child/ChildSelect';
import { useChildren } from '@/hooks/useChildren';
import { useSelectedChild } from '@/hooks/useSelectedChild';
import {
  buildChildSectionHref,
  parseChildBehaviorFilter,
  parseChildSection,
} from '@/lib/child-routes';

/** The guid of `/children/<guid>` exactly, or null for anything deeper. */
export function childWorkspaceGuid(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'children') return null;
  return segments[1];
}

/**
 * The child picker that rides in the app header on `/children/<guid>`.
 *
 * Only on that route: a homework or behaviour detail page is about one item of
 * one child, and switching children from there has no sensible destination, so
 * those routes keep the plain ילדים title.
 *
 * This wrapper exists so the route check happens BEFORE any hook that fetches.
 * The app header renders on every page, so a `useChildren()` called here --
 * hooks being unconditional -- would fire `GET /api/v1/children` on /home,
 * /inbox and /more as well. On a route where that request 401s, `apiFetch`'s
 * handler hard-navigates to `/auth/sign-in`: an entire app logged out by a
 * control that was not even going to render.
 */
export function HeaderChildSwitcher() {
  const pathname = usePathname();
  const studentGuid = childWorkspaceGuid(pathname ?? '');

  if (!studentGuid) return null;
  return <ChildSwitcherControl studentGuid={studentGuid} />;
}

/**
 * The switcher proper, mounted only on `/children/<guid>` -- the one route
 * that already loads the household list anyway.
 *
 * The section and behaviour filter are read from `window.location.search` in
 * the handler rather than from `useSearchParams()`. That hook would bail the
 * route out of static prerendering unless every page wrapped the header in its
 * own `<Suspense>`, and the handler only ever runs on the client, where
 * `location.search` is the same value the hook would have returned.
 */
function ChildSwitcherControl({ studentGuid }: { studentGuid: string }) {
  const router = useRouter();
  const { setSelectedChildGuid } = useSelectedChild();
  const { data: childrenData } = useChildren();

  const options = useMemo<ChildOption[]>(
    () =>
      (childrenData?.data ?? []).map((child) => ({
        studentGuid: child.studentGuid,
        fullName: child.fullName,
        isActive: child.isActive,
        schoolId: child.schoolId,
        schoolShortLabel: child.schoolShortLabel,
      })),
    [childrenData?.data],
  );

  // Nothing to switch between until the list has arrived, and a `value` with
  // no matching item renders an empty trigger -- so the title stands alone
  // until the open child is one of the options.
  if (!options.some((option) => option.studentGuid === studentGuid)) return null;

  const handleChange = (nextStudentGuid: string) => {
    if (!nextStudentGuid || nextStudentGuid === studentGuid) return;
    setSelectedChildGuid(nextStudentGuid);

    const search =
      typeof window === 'undefined' ? '' : window.location.search;
    const params = new URLSearchParams(search);
    const href = buildChildSectionHref(
      nextStudentGuid,
      parseChildSection(params.get('section')),
      { behavior: parseChildBehaviorFilter(params.get('behavior')) },
    );
    if (!href) return;
    router.push(href);
  };

  return (
    <ChildSelect
      options={options}
      value={studentGuid}
      onChange={handleChange}
      triggerClassName="h-8 w-auto max-w-[min(100%,12rem)] gap-1.5 rounded-full border-border/80 bg-card/85 px-3 py-0 text-sm font-medium text-foreground shadow-none focus-visible:ring-offset-0"
    />
  );
}
