import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FreshnessService } from './freshness.service';
import { SyncRunService } from './sync-run.service';
import { policyForSource } from './source-policy';
import type { SyncExecutionContext, SyncTaskRunResult } from './sync.types';

/** What the caller hands over: one task's `execute`, already bound. */
export type FetchFn = (context: SyncExecutionContext) => Promise<SyncTaskRunResult>;

export interface EnsureFreshOptions {
  /** The connection to fetch as. Without one there is nothing to fetch with. */
  connectionId: string;
  /**
   * Whether the page has nothing to render from the local copy.
   *
   * Resolving `true` waits for the fetch (bounded), because a blank timetable
   * grid is worse than a short wait. `false` returns immediately and lets the
   * next view be fresh, because a stale grid is better than a slow one.
   *
   * A thunk, not a boolean: it costs a `count` query, and it is called only
   * once a fetch has actually been committed to -- on the common path, where
   * the local copy is fresh, that query never runs. If it throws, the local
   * copy is served; this method does not fail the page it is freshening.
   */
  localIsEmpty: () => Promise<boolean>;
  /**
   * The full `sync_run.source` key this read is about, e.g.
   * `grades:<studentGuid>`. Omitted means base-source matching.
   *
   * Without it, freshness is decided across every variant of the source — so
   * for a `perStudent` source one child's successful run answers the question
   * "is *this* child's copy fresh?" and the unlucky sibling's section is
   * pinned empty for the whole TTL (6h for grades, 7 days for the grid). The
   * caller decides whether to pass one by asking the policy table:
   * `policyForSource(source).perStudent`.
   *
   * Omit it when the read genuinely spans students — the dashboard freshens
   * `groups` + `lessons_count` once per connection behind an emptiness probe
   * covering every child, and keying that per student would multiply its
   * fetches by the child count.
   */
  variantKey?: string;
  /**
   * An absolute epoch-ms cap on how long *this request* may block in total.
   *
   * One request freshens several sources across several connections, and each
   * call blocking for its own budget stacks: two connections x two sources at
   * 4s each is a 16s page, past the 15s frontend-proxy ceiling that
   * `sync-run.service.ts` records as the thing that broke `source-health`.
   * Callers mint one of these per request with `deadlineFromNow()` and pass it
   * to every call, so the whole set shares a single budget. The fetches still
   * run -- they just stop being waited on.
   */
  deadline?: number;
}

/**
 * Fetches a slow-moving source on first view, once the local copy has lapsed.
 *
 * The crons for `bells`, `timetable`, `groups`, `lessons_count`,
 * `user_details` and `message_board` are gone. They ran daily or weekly for
 * every household whether or not anyone looked, for data the app's own
 * freshness table already called fresh for a week.
 *
 * ## This is a known-dangerous shape, so it copies a known-good one
 *
 * `MashovSessionService.ensureStudentsAvailable` already does this for the
 * roster, and its comment spells out the hazard: without a TTL gate that a
 * *failing* fetch also satisfies, "every request that reaches here performs a
 * full upstream login — an unbounded login amplifier on the request path."
 * Every element below is there for that reason:
 *
 * - a TTL probe over `sync_run`, scoped to the connection;
 * - an in-flight dedupe map, so a page-load storm is one fetch;
 * - a **failure backoff**: a recorded failed attempt suppresses the next fetch
 *   for `SYNC_ON_READ_RETRY_MINUTES`, so a broken upstream cannot leave the
 *   gate permanently unsatisfied;
 * - a per-process cap on concurrent fetches, so a traffic spike here cannot
 *   become a traffic spike upstream;
 * - a shared per-request deadline, so freshening cannot out-wait the proxy;
 * - and serve-stale on every error, because a page must never fail because
 *   Mashov is down.
 */
@Injectable()
export class SyncOnReadService {
  private readonly logger = new Logger(SyncOnReadService.name);
  private readonly inFlight = new Map<string, ReadPathOperation>();
  private fetchesInFlight = 0;

  constructor(
    private readonly freshness: FreshnessService,
    private readonly syncRunService: SyncRunService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The deadline to share across one request's freshen calls.
   *
   * Minted by the caller rather than defaulted per call, because the budget
   * being shared is the whole point -- see `EnsureFreshOptions.deadline`.
   */
  deadlineFromNow(): number {
    return Date.now() + this.envInt('SYNC_ON_READ_BUDGET_MS', 4_000);
  }

  /**
   * Fetches `source` if its local copy has lapsed. Never throws.
   *
   * Callers `await` this and then read the database as they always did; on any
   * failure, or when the budget or the in-flight cap is spent, it returns
   * having changed nothing and the caller serves what it has.
   */
  async ensureFresh(source: string, fetch: FetchFn, options: EnsureFreshOptions): Promise<void> {
    // The same guard `ensureStudentsAvailable` opens with. Without it every
    // children/settings spec would need an upstream mock.
    if (process.env.NODE_ENV === 'test') return;

    if (!policyForSource(source)) {
      // A source with no policy has no TTL, which would read as "always
      // expired" and fetch on every single view. `source-policy.spec.ts`
      // asserts coverage, so this is a belt-and-braces refusal.
      this.logger.warn(`${source}: no sync policy; not fetching on read`);
      return;
    }

    // Keyed on the variant, not the base source: the marker covers the
    // freshness READ too (below), so a shared key means two children at one
    // school join a single operation and the second inherits the first's
    // decision — the same bug the student-keyed probe exists to fix, by
    // another route.
    const key = `${options.connectionId}::${options.variantKey ?? source}`;

    // ## Why the emptiness probe is part of the decision, not its consequence
    //
    // The probe used to be consulted only once the decision had already
    // committed to fetching, which meant that on a copy that was *fresh but
    // empty* it was never consulted at all -- and "fresh but empty" is a
    // contradiction in which the marker, not the emptiness, is the half that
    // is wrong. It now feeds the TTL: an empty copy is held off only by the
    // retry window.
    //
    // Production, 2026-11-26: unlinking a connection deletes a child's
    // `subject_enrollment` and `timetable_entry` rows
    // (`connection.service.ts:440-441`) and the `sync_run` rows *for that
    // connection id* (:490). Per-student runs written by the scheduled path
    // carry a NULL `householdConnectionId`, so that predicate never matched
    // them and they survived -- and a connectionless run is deliberately
    // admitted into every connection's snapshot (see `recordAttempt`). The
    // child's re-linked account therefore read a seven-day-old success marker
    // for rows that no longer existed, and מקצועות and לוח שיעורים rendered
    // empty for a week with source-health green throughout.
    //
    // The cost is one indexed count per source per view, including views that
    // turn out to be fresh. That is the price of the invariant, and it is the
    // cheaper half of the trade: the alternative is a section that cannot
    // self-heal for as long as its TTL.
    //
    // It runs inside `beginOperation` rather than here, and that placement is
    // not cosmetic: awaiting a count before the `inFlight` lookup below broke
    // the page-load storm collapsing, because three concurrent views each
    // awaited their own count and the first operation finished and
    // deregistered itself before the second resumed, so all three fetched.
    // Pinned by 'still collapses a page-load storm when the emptiness probe
    // is slow'.

    // The in-flight marker covers the freshness READ as well as the fetch.
    // Registering it after the read is a race: three concurrent page loads all
    // clear the TTL check before any of them registers, and all three fetch --
    // which is the amplifier this class exists to prevent.
    const existing = this.inFlight.get(key);
    const operation =
      existing ??
      this.beginOperation(
        key,
        source,
        fetch,
        options.connectionId,
        options.localIsEmpty,
        options.variantKey,
      );

    // Nothing is being fetched -- the copy was fresh, or the cap is spent, or
    // freshness could not be read. There is nothing to wait for.
    if (!(await operation.committed)) return;

    if (!(await operation.localEmpty)) {
      // Nothing to wait for: the page has something to show, and the next view
      // gets the fresh copy.
      return;
    }

    // Bounded. A page must not inherit the full upstream timeout, and must not
    // out-wait this request's shared budget.
    const budgetMs = this.remainingBudgetMs(options.deadline);
    if (budgetMs <= 0) return;
    await Promise.race([operation.done, sleep(budgetMs)]);
  }

  /**
   * Counts the local copy, never throwing.
   *
   * An unreadable count returns `false` — "assume we hold something". Fetching
   * blind on every view because a count failed is the amplifier this class
   * exists to prevent, and it must not be able to turn a servable page into a
   * 500 either.
   */
  private async probeLocalEmpty(
    source: string,
    localIsEmpty: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await localIsEmpty();
    } catch (error) {
      this.logger.warn(
        `${source}: could not tell whether the local copy is empty, serving it: ${describe(error)}`,
      );
      return false;
    }
  }

  /**
   * Decides and, if due, fetches — as a single promise under one key, so
   * concurrent callers join the whole decision rather than racing it.
   *
   * `committed` resolves at the moment the decision is made, before the fetch
   * is awaited, so a caller learns whether to wait without waiting.
   *
   * `localIsEmpty` is an input to the decision rather than a consequence of
   * it: an empty copy collapses the TTL to the retry window, so a stale
   * success marker cannot hold an empty section shut for days. See the block
   * comment in `ensureFresh`.
   */
  private beginOperation(
    key: string,
    source: string,
    fetch: FetchFn,
    connectionId: string,
    localIsEmpty: () => Promise<boolean>,
    variantKey?: string,
  ): ReadPathOperation {
    let settle!: (committed: boolean) => void;
    const committed = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    // Started here, awaited below. One probe per operation, shared by every
    // caller that joins it.
    const localEmpty = this.probeLocalEmpty(source, localIsEmpty);

    const done = (async () => {
      try {
        const policy = policyForSource(source);
        if (!policy) return;

        // An empty copy is held off only by the retry window, never by the
        // full TTL. Still bounded: upstream legitimately answers nothing for
        // some children, and that must not become a fetch per page view.
        const ttlMinutes = (await localEmpty)
          ? Math.min(policy.syncTtlMinutes, this.retryMinutes(policy.syncTtlMinutes))
          : policy.syncTtlMinutes;

        let fresh: boolean;
        try {
          fresh = await this.isFresh(source, ttlMinutes, connectionId, variantKey);
        } catch (error) {
          // Cannot tell: do nothing rather than fetch blind on every request.
          this.logger.warn(
            `${source}: could not read freshness, serving local copy: ${describe(error)}`,
          );
          return;
        }
        if (fresh) return;

        const maxInFlight = this.envInt('SYNC_ON_READ_MAX_INFLIGHT', 4);
        if (this.fetchesInFlight >= maxInFlight) {
          this.logger.warn(
            `${source}: ${this.fetchesInFlight} read-path fetches already in flight; ` +
              `serving local copy`,
          );
          return;
        }

        settle(true);
        await this.runFetch(source, fetch, connectionId, variantKey);
      } finally {
        // A no-op once `settle(true)` has run. Every early return lands here,
        // so no caller can wait on a decision that was never made.
        settle(false);
        this.inFlight.delete(key);
      }
    })();

    const operation: ReadPathOperation = { done, committed, localEmpty };
    this.inFlight.set(key, operation);
    return operation;
  }

  private async runFetch(
    source: string,
    fetch: FetchFn,
    connectionId: string,
    variantKey?: string,
  ): Promise<void> {
    this.fetchesInFlight += 1;

    try {
      const result = await fetch({ connectionId });
      // The task opens its own `sync_run` rows, which is what the TTL probe
      // reads. A task that reported failure without opening one would leave
      // the gate unsatisfied, so record a sentinel in that case.
      if (result.status === 'failed') {
        await this.recordAttempt(
          source,
          connectionId,
          result.errorMessages.join('; '),
          variantKey,
        );
      }
    } catch (error) {
      const message = describe(error);
      this.logger.warn(`${source}: read-path fetch failed, serving local copy: ${message}`);
      await this.recordAttempt(source, connectionId, message, variantKey);
    } finally {
      this.fetchesInFlight -= 1;
    }
  }

  /**
   * Whether anything should be fetched for this source right now.
   *
   * Two gates, not one:
   *
   * - a **successful** run inside `ttlMinutes` means the copy is current;
   * - failing that, any *attempt* inside the retry window means leave it alone.
   *
   * The second gate is the amplifier guard, and it has to be separate.
   * `recordAttempt` writes its sentinel with status `failed`, so it never
   * appears in `successRuns` — reading only those would mean a down upstream
   * satisfies nothing and *every* request to `/children`, `/timetable`,
   * `/subjects`, `/notices` and `/profile` performs a fresh upstream login,
   * bounded only by the in-flight cap. It is also why the window is short: a
   * failure must not strand a source for the whole TTL (7 days, for the grid),
   * so one blip costs minutes, not a week.
   *
   * ## What counts as "this source"
   *
   * With no `variantKey`, matching follows the variant-key rule, so a
   * `homework:<guid>` or `mail_inbox:<connId>` run counts for its base source.
   * That is right for a caller whose read spans students, and wrong for one
   * that does not: a `perStudent` source writes `${SOURCE}:${studentGuid}`, so
   * base-plus-any-variant matching let one child's successful run declare
   * *another* child's copy fresh. With a `variantKey`, that key must match
   * **exactly**. Per-student tasks always write the guid-suffixed key, so exact
   * matching is complete rather than partial.
   *
   * No run at all is never fresh, which is what makes a first view fetch.
   */
  private async isFresh(
    source: string,
    ttlMinutes: number,
    connectionId: string,
    variantKey?: string,
  ): Promise<boolean> {
    const { successRuns, allRuns } = await this.freshness.loadSyncRuns(connectionId);
    const now = Date.now();

    if (newestRunAt(successRuns, source, variantKey) >= now - ttlMinutes * 60_000) return true;

    return newestRunAt(allRuns, source, variantKey) >= now - this.retryMinutes(ttlMinutes) * 60_000;
  }

  /**
   * How long a *failed* attempt, or an empty local copy, holds off the next
   * fetch.
   *
   * Clamped to the TTL so a source whose TTL is shorter than the retry window
   * cannot be held back longer than its own schedule.
   */
  private retryMinutes(ttlMinutes: number): number {
    return Math.min(ttlMinutes, this.envInt('SYNC_ON_READ_RETRY_MINUTES', 15));
  }

  /**
   * Records a failed attempt so the retry window above is satisfied.
   *
   * **It writes the key the probe reads**, which is the whole point: a
   * student-keyed probe would never see a `${source}:${connectionId}` sentinel,
   * so a failing source would re-fetch on every view — the exact amplifier.
   *
   * Suffixed either way, never bare: `FreshnessService.getAllSourceHealth`
   * reads the bare key for the source's own health, and a connectionless row
   * is admitted into every connection's snapshot — so a bare failure would be
   * shown to every household on a shared deployment.
   *
   * Its own failure is swallowed: progress bookkeeping must never be able to
   * fail the page it is bookkeeping for.
   */
  private async recordAttempt(
    source: string,
    connectionId: string,
    errorMessage: string,
    variantKey?: string,
  ): Promise<void> {
    try {
      const run = await this.syncRunService.openRun(
        variantKey ?? `${source}:${connectionId}`,
        connectionId,
      );
      await this.syncRunService.closeRun(run.id, 'failed', {
        errorMessage: errorMessage || 'read-path fetch failed with no detail',
      });
    } catch (error) {
      this.logger.warn(`${source}: could not record the read-path attempt: ${describe(error)}`);
    }
  }

  private remainingBudgetMs(deadline?: number): number {
    const budgetMs = this.envInt('SYNC_ON_READ_BUDGET_MS', 4_000);
    if (deadline === undefined) return budgetMs;
    return Math.min(budgetMs, deadline - Date.now());
  }

  private envInt(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}

interface ReadPathOperation {
  /** Resolves when the fetch, if one was committed to, has finished. */
  done: Promise<void>;
  /** Resolves the moment the decision is made: is anything being fetched? */
  committed: Promise<boolean>;
  /**
   * Whether the local copy was empty when this operation started.
   *
   * Part of the operation rather than re-probed per caller, so a caller that
   * joins an in-flight operation inherits the decision instead of racing it —
   * and so `ensureFresh` has nothing to await before consulting `inFlight`,
   * which is what keeps a page-load storm collapsing into one fetch.
   */
  localEmpty: Promise<boolean>;
}

/**
 * When this source last ran. `-Infinity` when never, so every comparison
 * against a cutoff is false without a null branch.
 *
 * With a `variantKey`, only that exact key counts — the caller is asking about
 * one student, and a sibling's run is not an answer. Without one, every variant
 * of `source` counts, which is right for a read that spans students.
 */
function newestRunAt(
  runs: Map<string, { endedAt?: Date | null; startedAt?: Date | null }>,
  source: string,
  variantKey?: string,
): number {
  let newest = -Infinity;
  for (const [runKey, run] of runs) {
    if (variantKey !== undefined) {
      if (runKey !== variantKey) continue;
    } else if (runKey !== source && !runKey.startsWith(`${source}:`)) continue;
    // `startedAt` as the fallback so a row still running counts: another
    // worker is already on it, and a second fetch would be the amplifier.
    const at = run.endedAt ?? run.startedAt;
    if (!at) continue;
    const time = new Date(at).getTime();
    if (time > newest) newest = time;
  }
  return newest;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
