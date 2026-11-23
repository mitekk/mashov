import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, School } from 'lucide-react';
import { updateSchoolLink } from '@/api/schoolLinks';
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
            {link.credentialStale && <CredentialStaleBanner link={link} />}
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

/**
 * "This school's stored password no longer works", and the form that fixes it.
 *
 * A password reset done through the in-app recovery flow leaves the credential
 * we hold for that school dead. Nothing visible breaks immediately -- the
 * session is still valid -- so without this the parent's only symptom is data
 * quietly going stale, with nothing to tell them which school or why.
 *
 * It re-enters the password rather than sending the parent to sign in again:
 * the household may hold a second school whose credential is fine, and signing
 * out of a working household to fix one of its schools is a worse trade than
 * one password field. `PUT /school-links/:id` re-validates against Mashov and
 * rewrites the credential, which clears the flag.
 */
function CredentialStaleBanner({ link }: { link: SchoolLink }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (newPassword: string) =>
      updateSchoolLink(link.id, { password: newPassword }),
    onSuccess: () => {
      setOpen(false);
      setPassword('');
      // Both: the management list and every page's school badge read the flag.
      void queryClient.invalidateQueries({ queryKey: ['school-links'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: () => setErrorMsg('הסיסמה לא התקבלה במשוב, נסה שוב'),
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMsg(null);
    if (!password) {
      // Checked here rather than left to the backend: a blank password would
      // be a round trip that can only fail.
      setErrorMsg('יש להזין סיסמה');
      return;
    }
    mutation.mutate(password);
  }

  return (
    <div
      data-testid={`school-credential-stale-banner-${link.semel}`}
      className="mt-2 rounded-xl bg-destructive/10 p-3"
    >
      <p className="flex items-start gap-2 text-xs font-medium text-destructive">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span>
          הסיסמה של בית הספר הזה עודכנה במשוב. יש להזין אותה כאן כדי שהנתונים ימשיכו
          להתעדכן.
        </span>
      </p>

      {!open ? (
        <button
          type="button"
          data-testid={`school-credential-reenter-btn-${link.semel}`}
          onClick={() => setOpen(true)}
          className="mt-2 rounded-lg bg-destructive px-2.5 py-1 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90"
        >
          עדכון סיסמה
        </button>
      ) : (
        <form onSubmit={handleSubmit} className="mt-2 space-y-2">
          <label
            htmlFor={`school-credential-password-${link.semel}-input`}
            className="block text-xs font-medium text-foreground"
          >
            סיסמה חדשה במשוב
          </label>
          <input
            id={`school-credential-password-${link.semel}-input`}
            type="password"
            data-testid={`school-credential-password-${link.semel}`}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {errorMsg && (
            <p
              data-testid={`school-credential-error-${link.semel}`}
              role="alert"
              className="text-xs font-medium text-destructive"
            >
              {errorMsg}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              data-testid={`school-credential-submit-${link.semel}`}
              disabled={mutation.isPending}
              className="rounded-lg bg-destructive px-2.5 py-1 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {mutation.isPending ? 'מעדכן…' : 'שמירה'}
            </button>
            <button
              type="button"
              data-testid={`school-credential-cancel-${link.semel}`}
              onClick={() => {
                setOpen(false);
                setPassword('');
                setErrorMsg(null);
              }}
              className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/50"
            >
              ביטול
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
