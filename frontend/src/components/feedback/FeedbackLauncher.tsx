'use client';

import React, { useEffect, useState } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import { FeedbackDialog } from './FeedbackDialog';

/** Long enough to read in a second language, short enough not to linger. */
export const FEEDBACK_THANKS_MS = 10_000;

/**
 * The feedback entry point: a header icon, and nothing else until it is
 * pressed.
 *
 * It owns only `open` and `thanks`, and calls no TanStack hook. That is
 * deliberate: this renders inside `UserHeader`, whose own test mounts it with
 * no `QueryClientProvider`, so a query hook here -- rather than inside the
 * dialog, which mounts only while open -- would break those tests and put a
 * request on every page load.
 *
 * The thank-you is a plain fixed banner rather than a Radix Toast provider.
 * `@radix-ui/react-toast` is a dependency but imported nowhere, and a provider
 * scoped inside this component would introduce a primitive (viewport, swipe,
 * timers, z-index) without making it reusable -- a second consumer would have
 * to move it anyway. A general toast system belongs in `app/providers.tsx`
 * with its own ADR.
 */
export function FeedbackLauncher() {
  const [open, setOpen] = useState(false);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!thanks) return;
    const timer = setTimeout(() => setThanks(false), FEEDBACK_THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanks]);

  return (
    <>
      <button
        type="button"
        data-testid="feedback-launcher-button"
        aria-label="שליחת משוב"
        onClick={() => {
          setThanks(false);
          setOpen(true);
        }}
        // `.icon-button` already composes `.tap-target`; `h-9 -my-1` keeps the
        // header exactly as tall as it was, per the ReleasesDialog close button.
        className="icon-button h-9 w-9 -my-1"
      >
        <MessageSquarePlus className="h-4 w-4" />
      </button>

      {/* Mounted only while open, so nothing network-ish loads with the page. */}
      {open && (
        <FeedbackDialog open={open} onOpenChange={setOpen} onSent={() => setThanks(true)} />
      )}

      {thanks && (
        <div
          role="status"
          data-testid="feedback-thanks"
          lang="he-IL"
          dir="rtl"
          // `pb-nav` rather than a literal: BottomNav is `fixed bottom-0 z-50`,
          // and the token keeps tracking it if the nav moves or becomes a
          // side-rail at `lg`.
          className="pb-nav fixed inset-x-0 bottom-0 z-[60] flex items-center justify-between gap-3 px-4"
        >
          <span className="mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
            תודה! המשוב נשלח ונקרא על ידינו
            <button
              type="button"
              data-testid="feedback-thanks-dismiss"
              aria-label="סגירת ההודעה"
              onClick={() => setThanks(false)}
              className="icon-button h-8 w-8 shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </span>
        </div>
      )}
    </>
  );
}
