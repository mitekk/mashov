'use client';

import React from 'react';
import Link from 'next/link';
import { useMe } from '@/hooks/useAuth';

function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join('');
}

/**
 * "· 2 ילדים" after the name, or nothing.
 *
 * The name itself arrives stripped of the credential's `[child class]` tag --
 * one child of one school, which this header showed above every school's
 * content. The count replaces it with the whole household.
 */
function childrenSuffix(childrenCount: number): string {
  if (childrenCount <= 0) return '';
  if (childrenCount === 1) return ' · ילד אחד';
  return ` · ${childrenCount} ילדים`;
}

export function UserHeader() {
  const { data: me } = useMe();

  if (!me) return null;

  const initials = me.displayName ? getInitials(me.displayName) : '?';
  const suffix = childrenSuffix(me.childrenCount ?? 0);

  return (
    <div className="flex items-center justify-end px-4 pt-3 pb-1">
      <Link
        href="/more"
        aria-label={`${me.displayName ?? 'פרופיל'}${suffix} — הגדרות`}
        className="flex items-center gap-2 rounded-full text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {me.displayName && (
          <span className="hidden sm:block text-xs font-medium">
            {me.displayName}
            {suffix}
          </span>
        )}
        <span className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary select-none">
          {initials}
        </span>
      </Link>
    </div>
  );
}
