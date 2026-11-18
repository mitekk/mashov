# ADR-0028: Refresh Completion Is an Envelope, Not a Source Threshold

- **Date**: 2026-11-18
- **Status**: Accepted
- **Deciders**: Backend agent, Frontend agent, Planner

## Context and Problem Statement

A first login redirects to `/auth/syncing`, which polled `GET /api/v1/sync/status` and left only
when `done` was true. For at least one real household it never finished. The live endpoint
returned, repeatedly:

```json
{ "done": false, "sourcesCompleted": 15, "sourcesTotal": 16 }
```

`SyncController` hardcoded `TOTAL_SYNC_SOURCES = 16` and derived `done` by counting distinct
`sync_run.source` values with `status='success'` and `endedAt` inside the last 30 minutes.
Nothing made that number reachable:

- **Source keys are dynamic.** Nine tasks write `<name>:<studentGuid>`; `mail_counts` and
  `mail_inbox` write `<name>:<connId>`; `schoolActivities` writes `schoolActivities:<userId>`.
  Only `students`, `notifications`, `achvas` and `user_details` are fixed. The real count scales
  with children and connections. 16 is correct for exactly one child with *every* source
  succeeding.
- **Any failed source makes the target unreachable.** A failed run closes as `'failed'` and never
  enters the count. Production source health showed `groups:<guid>` and `lessons_count:<guid>`
  failing every cycle. One such failure per household parks the bar one short, forever.
- **Feature-flagged tasks open no run at all.** `daily-behave.task.ts` and `out-behave.task.ts`
  return `status:'success'` without calling `openRun` when their flags are false — the repo
  default. Those sources can never be counted.
- **The opposite failure existed too.** With two or more children the real source count exceeds
  16, so `done` tripped while roughly a third of the refresh was still running — and a stale
  success from an unrelated cron inside the 30-minute window could trip it on its own.

Every variant of "tune the constant" reproduces the bug under a different household shape. The
count was never the thing we wanted to know.

## Decision

**The refresh reports its own completion, into a per-connection envelope in Redis.**

Key `sync:refresh:<connectionId>`, written by `RefreshProgressService`:

```ts
{ refreshId, connectionId, phase, startedAt, endedAt, updatedAt,
  tasksTotal, tasksSettled, tasksFailed, currentTask, tasks[] }
```

`phase` is `running | success | partial | failed`. `tasksTotal` is derived from the wired task
list before anything runs — never a literal. Note that it is therefore *household-independent*
(always the task count, 16 today): that a refresh has 16 tasks regardless of how many children
or connections it fans out to is precisely what makes completion decidable, where counting
source keys was not. `SyncService.runManualRefresh` opens the envelope
before the roster task, bumps `tasksSettled`/`tasksFailed`/`tasks[]` as each task settles
(fire-and-forget, so progress streams rather than landing in one update at the end), and closes
it with an **awaited** write so a poll three seconds later cannot race it (single-process — see
Consequences). A `try/catch` closes it `failed` if the orchestration itself throws.

Two details are load-bearing rather than incidental:

- **A heartbeat re-writes the envelope every 60s while any task is outstanding.** Progress
  writes alone do not prove liveness: all fifteen parallel tasks start in the same tick, so one
  slow task can leave the envelope untouched for as long as it runs. Past `STALE_RUNNING_MS`
  that is indistinguishable from a dead backend, and every client would be told the refresh had
  finished while it was still working — the "trips `done` early" half of the original bug, in a
  new costume. The heartbeat is what separates *slow* from *gone*, and it is stopped before the
  terminal write so it cannot resurrect `running`.
- **`currentTask` names the first task still outstanding, not the last one to start.** Every
  parallel task is invoked in the same tick, so "last to start" pins the label to the final
  entry of the list immediately and never moves it — the screen would claim to be syncing the
  timetable for the entire refresh, including after the timetable had finished.

`GET /sync/status` reads only the envelope. It no longer touches `sync_run`, which retires the
`history:` prefix exclusion and the 30-minute window permanently. Its payload is a **superset** of
the old one — `sourcesCompleted` and `sourcesTotal` keep their names and types as aliases of
`tasksSettled` and `tasksTotal` — so old clients and existing test mocks still work.

| Situation | `phase` | `done` |
|---|---|---|
| No active connection / no envelope | `idle` | `false` |
| Envelope `running`, fresh | `running` | `false` |
| Envelope `running`, `updatedAt` older than 5 minutes | `stale` | **`true`** |
| `success` | `success` | `true` |
| `partial` (≥1 source failed) | `partial` | **`true`** |
| `failed` | `failed` | `true` |
| Redis unreachable | `unknown` | `false` (never a 500) |

The two bold rows are the fix. **A failed source is per-source health, not a reason to trap the
user** — that is what `GET /api/v1/settings/source-health` is for. And a backend killed
mid-refresh releases *every* waiting client through the staleness clock, which no per-client
timeout can do.

The screen gained two more exits so it cannot depend on this endpoint alone: the
`POST /sync/refresh` promise resolving (it awaits every task, so resolution *is* completion), and
a 120s hard cap above the proxy's 90s budget for that request.

## Considered Alternatives

### Raise or compute `TOTAL_SYNC_SOURCES`

Computing the expected key count from children × tasks × connections is possible and still wrong:
a failed source is still excluded from the numerator, so one upstream failure still parks the bar
one short. It also has to predict which feature flags opened a run. The arithmetic is a model of
the refresh; the refresh is right there and can say.

### A `sync_run` row with `source: 'refresh'`

Attractive — durable, queryable, no new storage. Rejected because every `sync_run` reader is keyed
on `source`. A `'refresh'` row would appear in `FreshnessService.getAllSourceHealth`, in
`getLatestSuccessfulRuns`, and in the retention rule's "keep the latest per source", each needing
its own exclusion. That is exactly the scar the `history:` prefix left (ADR-0025), and this ADR
would have added a second one. The envelope is ephemeral UI state with no audit value; it does not
belong in the audit table. Choosing Redis meant no change whatsoever to the *behaviour* of
`freshness.service.ts`, `sync-run.service.ts` or `sync-run-retention.service.ts` — their specs
pass unchanged, which is the evidence that the isolation is real. (The companion `source-health`
scoping in this same change does touch two of those files and adds two `sync_run` indexes; that
is a different fix that happened to ship alongside, not a cost of the envelope.)

### Server-Sent Events instead of polling

The envelope makes SSE easy to add later, but not now.
`frontend/src/app/api/v1/[...path]/route.ts` puts an `AbortSignal.timeout` on every proxied
request, so a stream under the `/api/v1/sync/` prefix would be killed at 90 seconds, and
Cloudflare sits in front with its own ~100s cutoff and buffering. Adding a transport whose failure
mode is "silently stops delivering" to a screen whose entire bug is "waits forever" buys a
three-second latency improvement for real new hang risk. Dropping the poll to 2s with `currentTask`
in the payload buys the perceived responsiveness at zero risk. SSE later needs: an SSE prefix
exemption in the proxy, 15s heartbeat comments, `X-Accel-Buffering: no`, and the poll kept as the
declared fallback — a separate change with its own tests.

## Consequences

**Good**

- `done` is a fact reported by the refresh, not an inference from row counts. The bug class is
  unreachable: a guard test asserts `getStatus` never calls any `prisma.syncRun` method.
- Progress is real and informative — settled/total from the actual task list, plus the task in
  flight as a Hebrew label.
- `partial` and `stale` both release the user. A failed upstream source degrades one card in
  settings instead of blocking onboarding.
- Redis cannot fail a refresh: `write` swallows and logs, and a read failure reports `unknown`
  rather than a 500.
- The audit table and every one of its readers are unchanged.

**Bad / accepted**

- Progress is now lost if Redis is flushed mid-refresh. The envelope's `running` TTL is 15
  minutes, its terminal TTL 10 minutes, and the screen's other two exits cover the loss.
- One more subsystem the status endpoint depends on. Mitigated by `unknown` never being fatal.
- `phase: 'stale'` reports `done` for a refresh we cannot prove finished. That is deliberate:
  releasing a user whose data may be incomplete beats holding one whose data is complete. The
  heartbeat is what keeps this from firing on a merely slow refresh.
- The in-flight dedupe map and the refresh throttle are both per-process, so the "an awaited
  terminal write cannot be raced" guarantee holds for one replica only. Two replicas can write
  the same envelope key; scaling out needs a Redis lock, and the code says so at the map.
- A terminal write that Redis itself rejects is swallowed, leaving the envelope `running` until
  the staleness clock. Bounded in practice by the frontend's 120s cap.

## Related

- ADR-0025 — the `history:` prefix exclusion whose shape this decision refuses to repeat.
- `docs/api-contract.md` — the phase table as a contract.
