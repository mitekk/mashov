# ADR-0046: The App Holds No Mashov Account of Its Own

- **Date**: 2026-11-25
- **Status**: Accepted
- **Deciders**: Backend agent
- **Supersedes in part**: [ADR-0030](0030-per-connection-data-scoping.md)

## Context and Problem Statement

ADR-0030 scoped every per-school read and write to its connection, but kept a
process-global "shared session" authenticated by `MASHOV_SEMEL` /
`MASHOV_USERNAME` / `MASHOV_PASSWORD`. It was demoted and fenced off from
user-facing reads, and ADR-0030 named its own removal gate: "dropping
`MASHOV_SEMEL` / `USERNAME` / `PASSWORD` from `ops/`".

This app is becoming a public resource. A deployment serving many households
must not hold one real person's school credentials, and must never be able to
answer about one household using another's login. 14 of the 18 sync tasks still
fell back to that account whenever no connection was in scope, so the fence
protected the read path but not the sync path.

## Decision

Delete the trio and the shared session entirely. Every outbound Mashov call is
now one of exactly three things:

1. unauthenticated (`GET /api/schools`, the public school list),
2. authenticated with credentials the user just supplied (login, validate,
   recovery), or
3. authenticated with a `HouseholdConnection`'s own decrypted credentials.

`MASHOV_BASE_URL` and `MASHOV_YEAR` stay. Neither is a credential —
`MASHOV_YEAR` is the history-window start per [ADR-0025](0025-school-year-history-window.md).

### Zero connections reports success, and writes no `sync_run`

A task whose connection list is empty returns `success` with zero counts and
opens no run (`skipNoConnections` in `sync/connection-fanout.ts`). This
deliberately contradicts the reasoning in its sibling
`reportNoConnectionTarget`, which exists so that a *targeted* refresh of an
unusable connection is never silently green. The two are different cases:

- `reportNoConnectionTarget` has a **requester** who named a connection.
  Silence there is a user-visible lie, so it writes a `failed` run keyed
  `${source}:${connectionId}`.
- `skipNoConnections` fires only when the caller named no connection and
  `household_connection` has no active, user-owned row — the empty-deployment
  state. There is no requester and no student any connection can claim.
  Nothing was skipped; there is nothing.

A run here could only be keyed on the **bare** source name, and
`FreshnessService.getAllSourceHealth` records what that caused before ("T13
finding 3"): the branch-wide NULL rule admits a connectionless run into *every*
connection's snapshot, so a bare `failed` row put "Missing required Mashov
credentials…" beneath a green row for every household on a shared deployment.
The reader was since fixed to take status and attempt from one variant-key set,
but the row would still be a failure attributed to nobody and shown to
everybody. On an empty deployment each source now reads `never_synced`, which
is exactly what it is.

### `sync_run.source` is always connection-suffixed

The five connection-loop tasks previously wrote a bare `source` on the shared
path. They now always write `${SOURCE}:${conn.id}` (achvas: `:${schoolCode}`).
No task writes a bare source key any more.

### `ensureStudentsAvailable` is a no-op without a connection

Its only remaining env dependency was `ensureAuthenticated(true)`. It now
returns early, before the TTL probe, logging at debug. A throw was rejected:
both callers (`ChildrenService.getChildren`, `DashboardService.getDashboard`)
are page reads, and a user mid-setup — or one whose only connection was just
deactivated — would get a 500 dashboard instead of an empty one. An existing
spec already asserts this path "swallows an upstream failure rather than
breaking the page load".

It records no `sync_run` either. That row exists to stop a *failing upstream
refresh* re-firing on every request; with no upstream call there is nothing to
amplify, and writing one would create an owner-less `students` row that
satisfies the TTL gate on behalf of connections that do not exist.

### A failed fan-out carries its cause

With the per-connection loop now the only fetch path, `every connection failed
for <guid>` became the whole error — the real reason was stranded in a
per-connection warn line, and `/more` showed an error with no diagnosis in it.
The thrown message now appends each connection's failure reason.

### The fence spec is retired, not reduced

`env-session-fence.spec.ts` injected a client whose four env methods throw and
asserted no user-facing service called them. Those methods no longer exist, so
TypeScript enforces the same invariant at compile time — strictly stronger than
a runtime `afterEach`. Keeping a reduced form would mean casting a double for
methods absent from the type, leaving a spec that is permanently green and
permanently uninformative. `ChildrenService` and `MailService` specs already
assert positively against the `*ForTarget` family.

## Consequences

**Good.** No operator credential to leak, rotate, or mistake for a user's. The
sync path gains the scoping guarantee the read path got in ADR-0030. An
explicit `schoolYear` is now always honourable: the shared session had no
per-year identity and 8 tasks had to refuse the combination outright, and those
guards are gone. ~400 lines of dead code deleted (`session.service.ts`,
`session.module.ts`, the four `MashovHttpClient` env methods, nine
`MashovSessionService` members).

**Bad.** Rows written by the retired shared session — `householdConnectionId:
null`, and `behaviorTypeReference.schoolCode = 0` — now have no writer and are
refreshed by nobody. **Their readers must stay**: `unreadBadge` still counts
unattributed mail, the unattributed-mail sweep still owns those rows, and
`BehaviorClassifierService` still falls back to school code 0. A data migration
to backfill or remove them is a separate, reversible decision.

The per-connection orphan sweep in `mail-inbox` no longer scopes to NULL, so
legacy unowned conversations are never swept. They are still counted.

**Operator-facing break, by design.** Anyone running this with only env
credentials and no household connection loses all sync on upgrade. They must
link a household through the in-app auth surface. No test can cover for a
missing migration note.

**Rate limiting.** N households now mean N logins rather than one shared
session, which ADR-0030's risk table listed as a mitigation. This was already
true for every *linked* household; the change only removes the unlinked
fallback. It argues for reducing background sync, which is the sibling work.
