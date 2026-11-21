import React from 'react';
import Link from 'next/link';
import { Plus, School } from 'lucide-react';
import type { SchoolLink } from '@/types/api';

interface SchoolLinksCardProps {
  links: SchoolLink[];
  onUnlink: (link: SchoolLink) => void;
}

/**
 * The connected schools, one row each.
 *
 * Replaces the single "בית ספר מחובר" card, which could only ever describe
 * one. With one school linked this renders the same information it always did,
 * so the change is invisible until a second school exists.
 *
 * The singular `settings-school-name` testid is deliberately dropped rather
 * than kept on the primary row: it cannot honestly identify one of N, and
 * leaving it alongside the per-school ids would give two elements answering
 * "which school?".
 */
export function SchoolLinksCard({ links, onUnlink }: SchoolLinksCardProps) {
  if (links.length === 0) return null;

  return (
    <div data-testid="settings-schools-card" className="card-base divide-y divide-border">
      {links.map((link) => (
        <div
          key={link.id}
          data-testid={`settings-school-row-${link.semel}`}
          className="flex items-center gap-3 p-4"
        >
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <School className="w-4 h-4 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p
              data-testid={`settings-school-name-${link.semel}`}
              className="truncate text-sm font-semibold text-foreground"
              title={link.schoolName}
            >
              {link.schoolName}
            </p>
            <p className="text-xs text-muted-foreground">
              שנת לימודים {link.schoolYear}
              {' · '}
              <span data-testid={`settings-school-children-count-${link.semel}`}>
                {childrenLabel(link.childrenCount)}
              </span>
            </p>
            {link.lastSyncAt === null && (
              <p
                data-testid={`settings-school-syncing-${link.semel}`}
                className="mt-1 text-xs text-muted-foreground"
              >
                מסנכרן נתונים…
              </p>
            )}
          </div>
          <button
            type="button"
            data-testid={`settings-school-unlink-btn-${link.semel}`}
            onClick={() => onUnlink(link)}
            className="flex-shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/5 transition-colors"
          >
            ניתוק
          </button>
        </div>
      ))}

      <Link
        href="/more/schools/new"
        data-testid="settings-add-school-btn"
        className="flex items-center gap-3 p-4 text-sm font-medium text-primary hover:bg-accent/50 transition-colors"
      >
        <span className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Plus className="w-4 h-4" aria-hidden="true" />
        </span>
        הוספת בית ספר
      </Link>
    </div>
  );
}

/**
 * Hebrew counts one, two and many differently, so this is not a plural `s`.
 * Zero is its own case: a school linked moments ago has no children yet, and
 * "0 ילדים" reads as an error rather than as "still syncing".
 */
function childrenLabel(count: number): string {
  if (count === 0) return 'אין ילדים עדיין';
  if (count === 1) return '1 ילד';
  if (count === 2) return '2 ילדים';
  return `${count} ילדים`;
}
