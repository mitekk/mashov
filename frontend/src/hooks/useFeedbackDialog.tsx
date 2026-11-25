'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { X } from 'lucide-react';
import { FeedbackDialog } from '@/components/feedback/FeedbackDialog';

/** Long enough to read in a second language, short enough not to linger. */
export const FEEDBACK_THANKS_MS = 10_000;

/** One string, so the live region and the visible banner cannot disagree. */
const THANKS_TEXT = 'תודה! המשוב נשלח ונקרא על ידינו';

interface FeedbackDialogValue {
  /** Whether the form is on screen. */
  open: boolean;
  /** Whether the thank-you is showing. */
  thanks: boolean;
  openDialog: () => void;
  closeDialog: () => void;
}

const FeedbackDialogContext = createContext<FeedbackDialogValue | null>(null);

interface FeedbackDialogProviderProps {
  children: React.ReactNode;
}

/**
 * One feedback dialog, one thank-you banner, one live region -- however many
 * triggers there are.
 *
 * The header has one trigger -- the profile menu's item -- and the state
 * deliberately does not belong to it: Radix unmounts the menu's content on
 * select, so a trigger that owned the dialog would close it in the same breath
 * as opening it. Keeping the live region here also means one `role="status"`
 * however many triggers are added later, rather than a thank-you a screen
 * reader hears once per trigger.
 *
 * Calls no TanStack hook, deliberately. The provider mounts on every
 * authenticated screen; the query hooks stay inside `FeedbackDialog`, which is
 * mounted only while the form is open, so nothing network-ish loads with the
 * page. See the note in FeedbackDialog.tsx.
 */
export function FeedbackDialogProvider({ children }: FeedbackDialogProviderProps) {
  const [open, setOpen] = useState(false);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!thanks) return;
    const timer = setTimeout(() => setThanks(false), FEEDBACK_THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanks]);

  const openDialog = useCallback(() => {
    setThanks(false);
    setOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setOpen(false);
  }, []);

  const value = useMemo(
    () => ({ open, thanks, openDialog, closeDialog }),
    [open, thanks, openDialog, closeDialog],
  );

  return (
    <FeedbackDialogContext.Provider value={value}>
      {children}

      {/* Mounted only while open, so nothing network-ish loads with the page. */}
      {open && (
        <FeedbackDialog
          open={open}
          onOpenChange={(next) => (next ? openDialog() : closeDialog())}
          onSent={() => setThanks(true)}
        />
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
    </FeedbackDialogContext.Provider>
  );
}

export function useFeedbackDialog(): FeedbackDialogValue {
  const context = useContext(FeedbackDialogContext);
  if (!context) {
    throw new Error('useFeedbackDialog must be used within FeedbackDialogProvider');
  }
  return context;
}
