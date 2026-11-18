'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getSyncStatus, triggerSyncRefresh } from '@/api/sync';
import { ApiError } from '@/api/client';

/**
 * This screen used to have exactly one way out: `done` from the status
 * endpoint, which was derived from a source count that a single failed source
 * made unreachable. One upstream failure and the user sat here forever.
 *
 * It now has three independent exits, any one of which suffices:
 *
 *   1. `done` from the status endpoint, which the refresh itself now reports.
 *   2. The refresh request resolving — it awaits every task, so resolution *is*
 *      completion, with no dependency on the progress store at all.
 *   3. A hard cap from mount. A genuine last resort, above the proxy's 90s
 *      budget for `POST /sync/refresh` so that request always resolves or 504s
 *      first.
 *
 * Nothing here is allowed to leave the user with a spinner and no way forward.
 */
const POLL_INTERVAL_MS = 2_000;

const SKIP_DELAY_MS = Number(process.env.NEXT_PUBLIC_SYNCING_SKIP_DELAY_MS) || 10_000;

/** Sits above the proxy's SLOW_PATH_TIMEOUT_MS (90s) by design. */
const HARD_CAP_MS = Number(process.env.NEXT_PUBLIC_SYNCING_HARD_CAP_MS) || 120_000;

/** How long after a proxy timeout we admit that this is taking unusually long. */
const SLOW_NOTICE_MS = 15_000;

const MIN_HARD_CAP_MS = 1_000;
/**
 * The override can only ever *shorten* the cap.
 *
 * It ships in the production bundle, so a link could otherwise set it — and a
 * param that lengthens a safety timeout is a way to park someone on this
 * screen. Bounded above by the default, it cannot do anything worse than make
 * the screen give up sooner.
 */
const MAX_HARD_CAP_MS = HARD_CAP_MS;

/** Hebrew labels for the task names the backend reports in `currentTask`. */
const TASK_LABELS: Record<string, string> = {
  students: 'רשימת הילדים',
  notifications: 'עדכונים',
  mailCounts: 'ספירת הודעות',
  mailInbox: 'תיבת הדואר',
  homework: 'שיעורי בית',
  behavior: 'הערות התנהגות',
  achvas: 'הערכות',
  groups: 'קבוצות לימוד',
  lessonsCount: 'מצבת שיעורים',
  messageBoard: 'לוח מודעות',
  userDetails: 'פרטי המשתמש',
  dailyBehave: 'נוכחות יומית',
  outBehave: 'יציאות מהשיעור',
  releases: 'אישורי יציאה',
  schoolActivities: 'פעילויות בית הספר',
  timetable: 'מערכת שעות',
};

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export default function SyncingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showSkip, setShowSkip] = useState(false);
  const [showSlowNotice, setShowSlowNotice] = useState(false);
  const [triggerFailed, setTriggerFailed] = useState(false);
  const refreshTriggeredRef = useRef(false);
  const navigatedRef = useRef(false);
  const sawRunningRef = useRef(false);
  const mountedRef = useRef(true);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [navigated, setNavigated] = useState(false);

  // E2E needs a cap it can reach inside a test timeout, and a NEXT_PUBLIC_*
  // value is inlined at build time so it cannot vary per test in one shared
  // stack. Clamped to [1s, the default], so it can only shorten the cap.
  const hardCapParam = Number(searchParams.get('hardCapMs'));
  // Present when a school was just linked from /more. It changes what this
  // screen is waiting for, what it says, and where the skip button goes.
  const schoolId = searchParams.get('schoolId');
  const hardCapMs =
    Number.isFinite(hardCapParam) && hardCapParam > 0
      ? Math.min(Math.max(hardCapParam, MIN_HARD_CAP_MS), MAX_HARD_CAP_MS)
      : HARD_CAP_MS;

  /** Single-shot: whichever exit fires first wins, the rest become no-ops. */
  const leave = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    setNavigated(true);
    // `replace`, not `push`: with `push` the back button re-mounts this screen
    // and burns the refresh endpoint's throttle budget.
    //
    // A linked school lands on /children rather than on Home: that is the
    // screen where the new children actually appear, and the parent came here
    // from /more having asked for exactly that.
    router.replace(schoolId ? '/children' : '/');
  }, [router, schoolId]);

  const { data } = useQuery({
    // Keyed by school, so a first-login poll and an add-school poll cannot
    // read each other's cached status.
    queryKey: ['sync-status', schoolId ?? 'all'],
    queryFn: () => getSyncStatus(schoolId),
    staleTime: 0,
    enabled: !navigated,
    refetchInterval: (query) => {
      if (query.state.data?.done) return false;
      return POLL_INTERVAL_MS;
    },
  });

  // Exit 2: the refresh request itself. `runManualRefresh` awaits every task
  // before responding, so a resolved POST means the work is done whatever the
  // progress store says.
  // Owns the one timer this effect can create. The effect itself is single-shot
  // via refreshTriggeredRef, so its own cleanup runs long before the timer is
  // created inside the async `.catch` — the timer has to be owned by the
  // component, not by one invocation's closure.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (refreshTriggeredRef.current) return;
    refreshTriggeredRef.current = true;

    triggerSyncRefresh(schoolId)
      .then(() => leave())
      .catch((error: unknown) => {
        switch (statusOf(error)) {
          case 429:
            // Another refresh already owns this connection's envelope; the
            // poll will see it finish. Nothing to tell the user.
            return;
          case 401:
            // apiFetch has already started the redirect to sign-in.
            return;
          case 504:
            // The proxy gave up before the backend did. The refresh is very
            // likely still running, so keep polling — but stop pretending
            // everything is normal.
            slowTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setShowSlowNotice(true);
            }, SLOW_NOTICE_MS);
            return;
          default:
            if (mountedRef.current) setTriggerFailed(true);
        }
      });
  }, [leave, schoolId]);

  // Exit 1: the refresh reported a terminal phase — including `partial` and
  // `stale`, which is the whole point of the fix.
  useEffect(() => {
    if (data?.done) leave();
  }, [data?.done, leave]);

  // The envelope vanished: we watched a refresh run and the next poll says
  // nothing is in flight. It expired or the backend restarted; either way
  // there is nothing left to wait for.
  useEffect(() => {
    if (data?.phase === 'running') {
      sawRunningRef.current = true;
      return;
    }
    if (sawRunningRef.current && data?.phase === 'idle') leave();
  }, [data?.phase, leave]);

  // Exit 3: the hard cap, anchored to mount.
  //
  // `leave` is deliberately read through a ref rather than listed as a
  // dependency: it closes over `router`, and if that object's identity ever
  // changed the effect would re-run and restart the clock from zero — a cap
  // that silently is not a cap.
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  useEffect(() => {
    const timer = setTimeout(() => leaveRef.current(), hardCapMs);
    return () => clearTimeout(timer);
  }, [hardCapMs]);

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), SKIP_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Prefer the envelope's own counters; fall back to the legacy fields so a
  // payload from before this change still renders.
  const total = data?.tasksTotal ?? data?.sourcesTotal ?? 0;
  const completed = data?.tasksSettled ?? data?.sourcesCompleted ?? 0;
  const rawPercent = total > 0 ? (completed / total) * 100 : 0;
  // Clamped below 100 until we are actually done: a full bar that keeps
  // spinning is how this screen looked when it was broken.
  const progressPercent = data?.done ? 100 : Math.min(99, Math.round(rawPercent));
  const currentTaskLabel = data?.currentTask
    ? (TASK_LABELS[data.currentTask] ?? data.currentTask)
    : null;

  const showContinue = triggerFailed || showSlowNotice;

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center space-y-8">
        <div className="space-y-3">
          <h1 data-testid="syncing-heading" className="text-2xl font-bold text-foreground">
            {schoolId ? 'מחברים את בית הספר…' : 'מגדירים את החשבון שלך…'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {schoolId
              ? 'אנחנו מסנכרנים את הנתונים של בית הספר החדש. זה עשוי לקחת כמה רגעים.'
              : 'אנחנו מסנכרנים את הנתונים שלך מבית הספר. זה עשוי לקחת כמה רגעים.'}
          </p>
        </div>

        {/* Spinner */}
        <div className="flex justify-center">
          <div
            className="h-14 w-14 rounded-full border-4 border-primary/20 border-t-primary animate-spin"
            role="progressbar"
            aria-label="טוען..."
          />
        </div>

        {/* Progress bar + text */}
        <div className="space-y-2">
          {total > 0 && (
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
          <p
            data-testid="syncing-progress-text"
            className="text-sm font-medium text-foreground"
          >
            {total > 0
              ? `${completed} / ${total} מקורות הושלמו`
              : 'מאתחל…'}
          </p>
          {currentTaskLabel && (
            <p data-testid="syncing-current-task" className="text-xs text-muted-foreground">
              {`מסנכרנים: ${currentTaskLabel}`}
            </p>
          )}
        </div>

        {showContinue && (
          <div data-testid="syncing-error" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {showSlowNotice && !triggerFailed
                ? 'הסנכרון לוקח יותר זמן מהרגיל. אפשר להמשיך — הנתונים ימשיכו להתעדכן ברקע.'
                : 'לא הצלחנו להשלים את הסנכרון כרגע. אפשר להמשיך — הנתונים ימשיכו להתעדכן ברקע.'}
            </p>
            <button
              data-testid="syncing-continue-button"
              onClick={leave}
              className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
            >
              המשך
            </button>
          </div>
        )}

        {/* Skip button — visible after 10s */}
        {showSkip && (
          <button
            data-testid="syncing-skip-button"
            onClick={leave}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
          >
            דלג על הגדרה
          </button>
        )}
      </div>
    </div>
  );
}
