'use client';

import React from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept stable: the e2e page objects address the dialogs by these. */
  testId?: string;
  titleId?: string;
  title: string;
  description: React.ReactNode;
  error?: string | null;
  errorTestId?: string;
  cancelTestId: string;
  confirmTestId: string;
  confirmLabel: string;
  pendingLabel: string;
  isPending?: boolean;
  onConfirm: () => void;
}

/**
 * A destructive confirmation, on Radix.
 *
 * /more had three hand-rolled `fixed inset-0` modals -- no focus trap, no
 * focus restore, no Escape, no scroll lock and no `aria-modal` semantics
 * beyond the attribute, while the rest of the app used Radix portals. This is
 * the one implementation they share.
 *
 * Confirm is a plain button, NOT `AlertDialog.Action`: Action closes the
 * dialog on click, and these actions have to stay open to show a failure. The
 * success path navigates away and unmounts the dialog anyway.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  testId,
  titleId,
  title,
  description,
  error,
  errorTestId,
  cancelTestId,
  confirmTestId,
  confirmLabel,
  pendingLabel,
  isPending = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content
          dir="rtl"
          data-testid={testId}
          // Passed explicitly, not left to Radix. DialogTitle spreads caller
          // props AFTER its own id, so our `titleId` RENAMES the heading while
          // DialogContent keeps pointing aria-labelledby at a context id that
          // no longer exists -- three data-deleting confirmations announcing
          // as an unlabelled alert dialog, plus a console.error from Radix's
          // (not NODE_ENV-gated) title warning in the production bundle.
          //
          // Spread conditionally for the same reason: this is spread AFTER
          // Radix's own attribute too, so a bare `aria-labelledby={undefined}`
          // would not fall back -- it would DELETE the generated one and ship
          // the dialog unnamed, which is the failure this prop exists to
          // prevent. Without a titleId, Radix's own pairing is already correct.
          {...(titleId ? { 'aria-labelledby': titleId } : {})}
          // Escape is suppressed while the mutation is in flight for the same
          // reason confirm does not close: the dialog is what holds the error
          // if the request fails. Closing it mid-flight throws that away while
          // the mutation keeps running.
          onEscapeKeyDown={(event) => {
            if (isPending) event.preventDefault();
          }}
          className="dialog-panel fixed inset-x-4 top-1/2 z-50 mx-auto w-full max-w-sm -translate-y-1/2 space-y-4 rounded-2xl border border-border bg-card p-6 shadow-xl sm:max-w-md"
        >
          {/* Conditional for the same reason as aria-labelledby above: Radix
              spreads caller props after its own id, so `id={undefined}` would
              strip the generated one rather than fall back to it. */}
          <AlertDialog.Title
            {...(titleId ? { id: titleId } : {})}
            className="text-base font-bold text-foreground"
          >
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground">
            {description}
          </AlertDialog.Description>
          {error && (
            <p
              role="alert"
              data-testid={errorTestId}
              className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-3 pt-1">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                data-testid={cancelTestId}
                disabled={isPending}
                className="tap-target flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 disabled:opacity-60"
              >
                ביטול
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              data-testid={confirmTestId}
              onClick={onConfirm}
              disabled={isPending}
              className="tap-target flex-1 rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {isPending ? pendingLabel : confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
