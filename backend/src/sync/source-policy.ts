/**
 * One table saying, per sync source: how often it is worth fetching, how long
 * before `/more` calls it stale, and which task sets include it.
 *
 * This replaces two tables that disagreed. `SOURCE_THRESHOLDS` in
 * `freshness.service.ts` said `groups` was fresh for 7 days while its cron ran
 * it daily; `bells`, `timetable`, `releases`, `schoolActivities`,
 * `daily_behave` and `out_behave` were missing from it entirely, so `/more`
 * reported no health for them at all.
 *
 * **No injected dependencies, by design.** `FreshnessService`, the scheduler
 * and the read path all import this, and a provider would force an import edge
 * between modules that must not have one (see `DigestModule`'s note on the
 * process-wide proxy). Pure data plus pure functions over `process.env`, the
 * same discipline `common/student-links.ts` uses.
 *
 * ## Three naming conventions, deliberately both recorded
 *
 * - `source` is the task's own `SOURCE` constant and the `sync_run.source`
 *   base name: snake_case, except `schoolActivities`, the one camelCase
 *   outlier, which must stay as it is because rows already carry it.
 * - `task` is the camelCase name `SyncService.buildTasks` uses.
 *
 * They are different strings for the same thing, and a map keyed on one while
 * read by the other silently matches nothing. Hence both.
 */

export type SyncTaskSet = 'login' | 'digest' | 'mail' | 'roster' | 'full';

export interface SourcePolicy {
  /** The `sync_run.source` base name — the task's own `SOURCE` constant. */
  source: string;
  /** The camelCase name `SyncService.buildTasks` uses. */
  task: string;
  /** How old the local copy must be before anything bothers fetching. */
  syncTtlMinutes: number;
  /**
   * What `/more` reports as stale. Derived from `syncTtlMinutes` unless
   * overridden — see `STALE_FACTOR`.
   */
  staleThresholdMinutes: number;
  /** Which task sets include this source. */
  sets: SyncTaskSet[];
  /** Whether run keys carry a `:<studentGuid>` suffix. */
  perStudent: boolean;
  /**
   * The env var that must be `'true'` for this source to run at all, if any.
   *
   * Recorded as the NAME, not as a resolved boolean, and read per call by
   * `sourceIsEnabled` rather than at module load. `ConfigModule.forRoot`
   * populates `process.env` during Nest's bootstrap, which happens after this
   * module is first imported -- a value frozen at import time could be read
   * before the deployment's own setting had landed.
   */
  enabledWhen?: string;
}

/**
 * How much older than its own sync interval a source may get before `/more`
 * calls it stale.
 *
 * This is the structural reason the two tables cannot drift apart again: a
 * source can no longer be reported stale faster than its schedule could
 * possibly refresh it. Getting this wrong is not cosmetic — `mail_inbox` and
 * `mail_counts` carry a 15-minute threshold today, so moving mail onto a
 * 30-minute tick without this would mark them stale on roughly half of all
 * reads, and `computeFreshness` turns any stale source into a `stale` state
 * that renders in the app-wide `FreshnessBar`. Every user, a permanent amber
 * banner.
 */
const STALE_FACTOR = 2;
const STALE_FLOOR_MINUTES = 60;
// Above `achvas`'s 30-day TTL x2, so the clamp cannot pull a threshold back
// down to its own sync interval and report a source stale the instant it is
// due. `source-policy.spec.ts` asserts threshold > TTL for every source.
const STALE_CEILING_MINUTES = 90 * 24 * 60;

const HOUR = 60;
const DAY = 24 * HOUR;

function derivedStale(syncTtlMinutes: number): number {
  return Math.min(
    STALE_CEILING_MINUTES,
    Math.max(STALE_FLOOR_MINUTES, syncTtlMinutes * STALE_FACTOR),
  );
}

interface PolicyInput {
  source: string;
  task: string;
  syncTtlMinutes: number;
  sets: SyncTaskSet[];
  perStudent?: boolean;
  /** Only where the reported threshold must not follow the sync interval. */
  staleThresholdMinutes?: number;
  /** The env var that must be `'true'` for this source to run at all. */
  enabledWhen?: string;
}

function policy(input: PolicyInput): SourcePolicy {
  const key = envKey(input.source);
  const syncTtlMinutes = envMinutes(`SYNC_TTL_${key}_MINUTES`, input.syncTtlMinutes);
  // The larger of the explicit value and the one derived from the EFFECTIVE
  // ttl. Both directions of an override have already gone wrong here:
  //
  // - RAISING a TTL while reading the baked-in default left the threshold
  //   behind, so the source reported stale from the moment it was due;
  // - LOWERING a TTL while discarding the explicit value replaced homework's
  //   deliberate 24h threshold with max(60, 2 x 30) = 60 minutes, so any
  //   household not synced for an hour showed amber in the app-wide
  //   `FreshnessBar` -- the permanent banner `STALE_FACTOR` exists to prevent.
  //
  // `max` rather than a cascade of cases: the threshold's only job is to be
  // loose enough that the schedule can always beat it.
  const defaultStale = Math.max(input.staleThresholdMinutes ?? 0, derivedStale(syncTtlMinutes));
  return {
    source: input.source,
    task: input.task,
    syncTtlMinutes,
    staleThresholdMinutes: envMinutes(`SYNC_STALE_${key}_MINUTES`, defaultStale),
    sets: input.sets,
    perStudent: input.perStudent ?? false,
    enabledWhen: input.enabledWhen,
  };
}

function envKey(source: string): string {
  // `schoolActivities` -> `SCHOOL_ACTIVITIES`; `mail_inbox` -> `MAIL_INBOX`.
  return source.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  // A typo must not silently become an aggressive schedule.
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * `notifications` is deliberately absent. Nothing read the `NotificationEvent`
 * table it wrote — no page, no digest, no Telegram — and it held the tightest
 * cron in the app. Listing it here with no writer would make
 * `getAllSourceHealth` emit a permanent `never_synced` row on `/more`.
 */
export const SOURCE_POLICY: SourcePolicy[] = [
  // The roster. Changes about once a year (`students.task.ts` says so), yet ran
  // every 30 minutes, and each run is a full upstream login.
  policy({ source: 'students', task: 'students', syncTtlMinutes: DAY, sets: ['login', 'roster', 'full'] }),

  // Fast-moving, and what the digest reports on. The TTL is well inside the
  // digest's own 6h staleness trip-wire, which the "digest-lead tick stays
  // inside the digest staleness trip-wire" suite in
  // `notification-window.task.spec.ts` pins against the real constant.
  // The reported threshold stays at today's 24h rather than following the TTL:
  // a parent should not see amber because nobody opened the app for an hour.
  policy({ source: 'homework', task: 'homework', syncTtlMinutes: 45, staleThresholdMinutes: DAY, sets: ['login', 'digest', 'full'], perStudent: true }),
  policy({ source: 'behavior', task: 'behavior', syncTtlMinutes: 45, staleThresholdMinutes: DAY, sets: ['login', 'digest', 'full'], perStudent: true }),

  // Mail. The heaviest source: two paged walks (inbox + archive) per run.
  policy({ source: 'mail_inbox', task: 'mailInbox', syncTtlMinutes: 15, sets: ['login', 'mail', 'full'] }),
  policy({ source: 'mail_counts', task: 'mailCounts', syncTtlMinutes: 15, sets: ['login', 'mail', 'full'] }),

  // The behaviour-code taxonomy. Not a page read: `BehaviorClassifierService`
  // consumes it at sync time to classify behaviour rows. Effectively a
  // school-year constant, so a long TTL makes it a no-op almost always — which
  // is why it can sit in the same sets as `behavior` with no task-to-task
  // dependency edge, and `buildTasks` has none of those.
  policy({ source: 'achvas', task: 'achvas', syncTtlMinutes: 30 * DAY, sets: ['login', 'digest', 'full'] }),

  // Digest-only: the pages that show these read live from Mashov
  // (`children.service.ts`), not from the tables these fill.
  policy({ source: 'releases', task: 'releases', syncTtlMinutes: 45, staleThresholdMinutes: DAY, sets: ['digest', 'full'] }),
  policy({ source: 'schoolActivities', task: 'schoolActivities', syncTtlMinutes: 12 * HOUR, staleThresholdMinutes: DAY, sets: ['digest', 'full'] }),

  // Grades: a page tab AND a digest input, since the digest reports a newly
  // entered mark. It is not on a cron of its own -- it arrived with a `*/12`
  // one, which is 120 requests per child per day for assessments a teacher
  // posts a few times a term -- but it has to be in the `digest` set: the
  // notification window's lead task is what fetches ahead of the evening
  // runs, and without it a new mark would land only on a login or a manual
  // refresh. The digest windows `enteredAt`, so "days late" means "never".
  // The 6h TTL is what keeps the cost down; the reported threshold stays at
  // the 24h it shipped with.
  //
  // Deliberately NOT added to SYNC_SOURCES_BEHIND_THE_DIGEST: a failed grades
  // fetch must not turn a real behaviour report into `skipped_stale`.
  policy({ source: 'grades', task: 'grades', syncTtlMinutes: 6 * HOUR, staleThresholdMinutes: DAY, sets: ['digest', 'full'], perStudent: true }),

  // Notices: a page tab AND a digest input.
  policy({ source: 'message_board', task: 'messageBoard', syncTtlMinutes: 12 * HOUR, staleThresholdMinutes: DAY, sets: ['digest', 'full'], perStudent: true }),

  // The weekly grid and the bell times. Near-static, but they must stay in the
  // `digest` set: `DigestDismissalService.gateFor` reads `timetable_entry` and
  // `bell_schedule` to find the child's last lesson, and returns OPEN (no
  // gate) when there are no rows. Demote these to read-only-on-view and a
  // household that never opens the timetable tab loses the ADR-0040 dismissal
  // gate entirely — digests would fire at 11:00, mid school day. At a 7-day
  // TTL the cost is ~2 GETs per student per week.
  policy({ source: 'timetable', task: 'timetable', syncTtlMinutes: 7 * DAY, sets: ['digest', 'full'], perStudent: true }),
  policy({ source: 'bells', task: 'bells', syncTtlMinutes: 7 * DAY, sets: ['digest', 'full'] }),

  // Slow-moving page data, fetched on first view once its TTL lapses.
  policy({ source: 'groups', task: 'groups', syncTtlMinutes: 7 * DAY, sets: ['full'], perStudent: true }),
  policy({ source: 'lessons_count', task: 'lessonsCount', syncTtlMinutes: 7 * DAY, sets: ['full'], perStudent: true }),
  policy({ source: 'user_details', task: 'userDetails', syncTtlMinutes: 7 * DAY, sets: ['full'] }),

  // Feature-flagged off by default, and gated inside their own `execute`.
  //
  // `enabledWhen` repeats that gate as data because the task's own check is
  // invisible to everything else: with the flag off, `execute` returns before
  // opening a `sync_run`, so nothing is ever written for these sources and
  // `/more` reported a permanent `לא סונכרן` for a feed that was never meant
  // to run. That is the same trap the `notifications` note above describes --
  // a source listed here with no writer -- reached through a flag rather than
  // a deletion. Both write into `behavior_item`, which the enabled `behavior`
  // task already fills, so hiding them costs the user no data.
  policy({ source: 'daily_behave', task: 'dailyBehave', syncTtlMinutes: 12 * HOUR, sets: ['full'], enabledWhen: 'FEATURE_DAILY_BEHAVE' }),
  policy({ source: 'out_behave', task: 'outBehave', syncTtlMinutes: 12 * HOUR, sets: ['full'], enabledWhen: 'FEATURE_OUT_BEHAVE' }),
];

const BY_SOURCE = new Map(SOURCE_POLICY.map((p) => [p.source, p]));
const BY_TASK = new Map(SOURCE_POLICY.map((p) => [p.task, p]));

export function policyForSource(source: string): SourcePolicy | undefined {
  return BY_SOURCE.get(source);
}

export function policyForTask(task: string): SourcePolicy | undefined {
  return BY_TASK.get(task);
}

/**
 * Whether this deployment runs this source at all.
 *
 * Read per call, never cached: see `enabledWhen`. An ungated source is always
 * enabled, so the common case needs no env read.
 */
export function sourceIsEnabled(policy: SourcePolicy): boolean {
  return !policy.enabledWhen || process.env[policy.enabledWhen] === 'true';
}

/**
 * The sources this deployment actually syncs — what `/more` should report on.
 *
 * `SOURCE_POLICY` stays the full catalogue: it is what `buildTasks` schedules
 * (each flagged-off task self-gates and no-ops), and what the TTL and
 * threshold invariants are asserted over. Only the health readback narrows,
 * because only it makes a promise to the user about every row it prints.
 */
export function enabledSourcePolicies(): SourcePolicy[] {
  return SOURCE_POLICY.filter(sourceIsEnabled);
}

export function sourcesForSet(set: SyncTaskSet): SourcePolicy[] {
  return SOURCE_POLICY.filter((p) => p.sets.includes(set));
}

export function syncTtlMsFor(source: string): number | undefined {
  const found = BY_SOURCE.get(source);
  return found ? found.syncTtlMinutes * 60_000 : undefined;
}

/**
 * The sources whose run keys carry a `:<studentGuid>` suffix.
 *
 * Re-exported in the shape `FreshnessService` and `SettingsService` already
 * consume, so neither has to change to adopt this table. Two copies of this
 * list would drift and silently stop reporting a source.
 */
export const PER_STUDENT_SOURCES: readonly string[] = SOURCE_POLICY.filter(
  (p) => p.perStudent,
).map((p) => p.source);
