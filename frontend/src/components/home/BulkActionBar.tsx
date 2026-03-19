'use client';

import React from 'react';
import { Archive, Mail, MailOpen } from 'lucide-react';

interface BulkActionBarProps {
  count: number;
  isPending: boolean;
  onClear: () => void;
  onSelectAllVisible: () => void;
  showMarkRead: boolean;
  showMarkUnread: boolean;
  showArchive: boolean;
  showUnarchive: boolean;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}

export function BulkActionBar({
  count,
  isPending,
  onClear,
  onSelectAllVisible,
  showMarkRead,
  showMarkUnread,
  showArchive,
  showUnarchive,
  onMarkRead,
  onMarkUnread,
  onArchive,
  onUnarchive,
}: BulkActionBarProps) {
  return (
    <section
      data-testid="feed-bulk-actions"
      className="card-base flex flex-wrap items-center gap-2 px-3 py-2.5"
    >
      <span className="text-sm font-medium text-foreground">
        נבחרו {count}
      </span>
      <button
        type="button"
        data-testid="feed-bulk-select-all-visible"
        onClick={onSelectAllVisible}
        disabled={isPending}
        className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        בחר הכל
      </button>

      {showMarkRead && (
        <button
          type="button"
          data-testid="feed-bulk-mark-read"
          onClick={onMarkRead}
          disabled={isPending}
          className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Mail className="h-3.5 w-3.5" />
          סמן כנקרא
        </button>
      )}

      {showMarkUnread && (
        <button
          type="button"
          data-testid="feed-bulk-mark-unread"
          onClick={onMarkUnread}
          disabled={isPending}
          className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <MailOpen className="h-3.5 w-3.5" />
          סמן כלא נקרא
        </button>
      )}

      {showArchive && (
        <button
          type="button"
          data-testid="feed-bulk-archive"
          onClick={onArchive}
          disabled={isPending}
          className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Archive className="h-3.5 w-3.5" />
          ארכיון
        </button>
      )}

      {showUnarchive && (
        <button
          type="button"
          data-testid="feed-bulk-unarchive"
          onClick={onUnarchive}
          disabled={isPending}
          className="tap-target inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Archive className="h-3.5 w-3.5" />
          שחזר מארכיון
        </button>
      )}

      <button
        type="button"
        data-testid="feed-bulk-clear-selection"
        onClick={onClear}
        disabled={isPending}
        className="tap-target rounded-full border border-border/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        נקה בחירה
      </button>
    </section>
  );
}
