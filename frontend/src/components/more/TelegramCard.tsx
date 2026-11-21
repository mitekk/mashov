import React from 'react';
import Link from 'next/link';
import { Plus, Send } from 'lucide-react';
import type { ChildListItem, DigestRecipient } from '@/types/api';

interface TelegramCardProps {
  /** Every recipient row the parent owns; non-telegram channels are ignored. */
  recipients: DigestRecipient[];
  /**
   * The roster, for names, classes and school labels. Named `allChildren`
   * rather than `children` because a React prop called `children` is something
   * else entirely.
   */
  allChildren: ChildListItem[];
  onToggle: (recipientId: string, enabled: boolean) => void;
  onDisconnect: () => void;
  /** The recipient whose toggle is mid-flight, if any. */
  pendingToggleId?: string | null;
  toggleError?: string | null;
}

/**
 * Telegram updates in `/more`: either an invitation to set them up, or what the
 * parent is currently subscribed to.
 *
 * Presentational, like `SchoolLinksCard`: the mutations and the disconnect
 * confirm modal belong to the page, which already owns two modals of exactly
 * that shape.
 *
 * The join from `studentGuid` to a name happens here rather than on the server.
 * `GET /digest/recipients` answers rows, the children list is already cached on
 * this screen, and a server-side join would be a new read route for a label.
 */
export function TelegramCard(props: TelegramCardProps) {
  const { recipients, allChildren, onToggle, onDisconnect, pendingToggleId, toggleError } =
    props;

  const telegramRows = recipients.filter((row) => row.channel === 'telegram');
  const byGuid = new Map(allChildren.map((item) => [item.studentGuid, item]));
  // One school makes the label pure noise on every row.
  const showSchoolLabels = new Set(allChildren.map((item) => item.schoolId ?? 'unknown')).size > 1;
  const subscribedGuids = new Set(telegramRows.map((row) => row.studentGuid));
  const hasUnsubscribedChild = allChildren.some(
    (item) => !subscribedGuids.has(item.studentGuid),
  );

  if (telegramRows.length === 0) {
    return (
      <div data-testid="telegram-card" className="card-base divide-y divide-border">
        <Link
          href="/more/telegram"
          data-testid="telegram-card-connect-link"
          className="flex items-center gap-3 p-4 transition-colors hover:bg-accent/50"
        >
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Send className="h-4 w-4 text-primary" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">
              קבלו עדכונים יומיים בטלגרם
            </span>
            <span className="block text-xs text-muted-foreground">
              הודעה אחת על כל ילד, רק בימים שבהם קרה משהו
            </span>
          </span>
          <span className="flex-shrink-0 text-xs font-medium text-primary">הגדרה</span>
        </Link>
      </div>
    );
  }

  return (
    <div data-testid="telegram-card" className="card-base divide-y divide-border">
      {telegramRows.map((row) => {
        const item = byGuid.get(row.studentGuid);
        const inputId = `telegram-card-toggle-${row.studentGuid}`;

        return (
          <div
            key={row.id}
            data-testid={`telegram-card-row-${row.studentGuid}`}
            className="flex items-center gap-3 p-4"
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor={inputId}
                className="block truncate text-sm font-semibold text-foreground"
              >
                {/* A departed child's row survives the roster. Showing it with
                    a placeholder beats hiding the only switch that turns it
                    off. */}
                {item?.fullName ?? 'ילד שאינו מופיע ברשימה'}
              </label>
              <p className="text-xs text-muted-foreground">
                {item ? (
                  <>
                    כיתה {item.classCode}
                    {item.classNum}
                  </>
                ) : (
                  'לא נמצא בבתי הספר המחוברים'
                )}
                {showSchoolLabels && item?.schoolShortLabel && (
                  <>
                    {' · '}
                    <span data-testid={`telegram-card-school-${row.studentGuid}`}>
                      {item.schoolShortLabel}
                    </span>
                  </>
                )}
              </p>
            </div>
            <input
              id={inputId}
              data-testid={inputId}
              type="checkbox"
              role="switch"
              aria-label={`עדכונים בטלגרם על ${item?.fullName ?? row.studentGuid}`}
              checked={row.enabled}
              disabled={pendingToggleId === row.id}
              onChange={() => onToggle(row.id, !row.enabled)}
              className="h-5 w-5 flex-shrink-0 rounded border-input accent-primary disabled:opacity-60"
            />
          </div>
        );
      })}

      {toggleError && (
        <p
          role="alert"
          data-testid="telegram-card-toggle-error"
          className="px-4 py-3 text-sm text-destructive"
        >
          {toggleError}
        </p>
      )}

      {hasUnsubscribedChild && (
        <Link
          href="/more/telegram"
          data-testid="telegram-card-add-child-link"
          className="flex items-center gap-3 p-4 text-sm font-medium text-primary transition-colors hover:bg-accent/50"
        >
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Plus className="h-4 w-4" aria-hidden="true" />
          </span>
          הוספת ילד
        </Link>
      )}

      <div className="flex items-center justify-between p-4">
        <p className="text-xs text-muted-foreground">העדכונים נשלחים לטלגרם המחובר</p>
        <button
          type="button"
          data-testid="telegram-card-disconnect-btn"
          onClick={onDisconnect}
          className="flex-shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/5"
        >
          ניתוק
        </button>
      </div>
    </div>
  );
}
