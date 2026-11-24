'use client';

import React, { useEffect, useState } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import { FeedbackDialog } from './FeedbackDialog';

/** Long enough to read in a second language, short enough not to linger. */
export const FEEDBACK_THANKS_MS = 10_000;

/** One string, so the live region and the visible banner cannot disagree. */
const THANKS_TEXT = 'תודה! המשוב נשלח ונקרא על ידינו';

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
        // `.icon-button` composes `.tap-target`, whose `min-height: 44px` wins
        // over `h-9` -- so the button really is 44px tall and `-my-2` is what
        // pulls it back inside the 32px avatar row. Measured: the header row is
        // 48px with and without this button. The tap area stays 44px; only the
        // space it claims in the flex row shrinks.
        className="icon-button h-9 w-9 -my-2"
      >
        <MessageSquarePlus className="h-4 w-4" />
      </button>

      {/* Mounted only while open, so nothing network-ish loads with the page. */}
      {open && (
        <FeedbackDialog open={open} onOpenChange={setOpen} onSent={() => setThanks(true)} />
      )}

      {/*
        Always in the tree, text toggled inside it. A live region inserted at
        the same moment as its content is frequently not announced at all
        (NVDA, VoiceOver) -- the parent would tap send, the dialog would close,
        and a blind parent would be told nothing, then send again into the
        hourly limit.
      */}
      <div role="status" data-testid="feedback-thanks-live" lang="he-IL" className="sr-only">
        {thanks ? THANKS_TEXT : ''}
      </div>

      {thanks && (
        <div
          // Visual only: the region above is what gets announced, and reading
          // the same sentence twice is worse than once.
          aria-hidden="true"
          data-testid="feedback-thanks"
          lang="he-IL"
          dir="rtl"
          // `pb-nav` rather than a literal, and `lg:ps-rail` to match
          // `AppShell`: AppNav is `fixed bottom-0 z-50` on a phone and a side
          // rail at `lg`, and both tokens track it rather than restating it.
          //
          // `pointer-events-none` because that padding puts this box over the
          // whole of AppNav, above it in z-order and invisible, for ten
          // seconds -- `aria-hidden` does not affect hit testing, so without
          // it a parent who sends feedback and reaches for a nav tab taps
          // nothing. The banner itself opts back in.
          className="pb-nav pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex items-center justify-between gap-3 px-4 lg:ps-rail"
        >
          <span className="pointer-events-auto mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
            {THANKS_TEXT}
            <button
              type="button"
              data-testid="feedback-thanks-dismiss"
              aria-label="סגירת ההודעה"
              // Out of the tab order: this sits inside an `aria-hidden`
              // subtree, and a tabbable control the accessibility tree says
              // does not exist is a WCAG 4.1.2 failure. For a screen-reader
              // user the live region has already spoken and the ten-second
              // timer is the dismissal.
              tabIndex={-1}
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
