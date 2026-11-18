# ADR-0030: Every Per-School Read and Write Is Scoped to Its Connection

- **Date**: 2026-11-18
- **Status**: Accepted
- **Deciders**: Backend agent, Planner

## Context and Problem Statement

ADR-0029 makes one `AppUser` hold N school connections. That is only safe if every read and
write can say which school a row belongs to. Before this change, several could not — and each
gap was invisible on a single-school deployment and wrong the moment a second school existed.

The gaps, concretely:

- **The mail reconciliation sweep refused to run.** `MailInboxTask` skipped its orphan sweep
  whenever more than one connection was active, with the comment "N active connections share one
  unscoped mail table". That gate was correct at the time — `conversationId` is a global UUID and
  the table was the union of every mailbox, so connection A's sweep would clear unread on B's
  rows every seven minutes and back again. The consequence was that linking a second school
  silently reintroduced the inflated badge the sweep exists to prevent (production: 39 local
  against 16 upstream, 23 stale orphans).
- **Half the read paths used the process-global env-credential session.** Conversation detail,
  attachment downloads, mark-unread, archive, unarchive, lesson plans, releases and school
  activities all authenticated as whatever single account `MASHOV_SEMEL` / `USERNAME` /
  `PASSWORD` names — a 403 on the other school's child at best, and for the household-scoped
  endpoints a confident answer about the wrong school.
- **One year scoped every read.** `currentSchoolYearFor()` picks one connection's `schoolYear`
  and applies it to the whole household. Two schools on different years — which happens every
  September — hides one school's children outright.
- **Four unique keys collided.** Mashov's numeric ids are per-school counters; only its UUIDs are
  global. `notification_event.upstreamNotificationId`, `school_activity.activityId` (literally
  `1` in the captured payload) and `behavior_type_reference.code` each made one school's row
  overwrite the other's. The last is the worst: `BehaviorClassifierService` answers "is this
  absence justifiable" from that table, so a child's unexcused absence could quietly become an
  excused one.
- **Unlink was global.** `mailConversation.deleteMany({})` with no `where` at all, plus
  `student.findMany({ isActive: true })` — every child in the database.

## Decision

**`ConnectionTarget` is the unit of upstream work.** `{ id, schoolCode, schoolYear, username,
password, schoolName }`, resolved by `ConnectionScopeService` and handed to the transport.
`MashovHttpClient` gained `getForTarget`, `getResponseForTarget`, `putForTarget` and
`deleteForTarget` — there was previously no per-connection PUT, DELETE or raw-response path at
all, which is *why* every mutation and attachment download still used the env session.

The transport does **not** take a `studentGuid`. Resolving ownership is a schema concern, and a
`getForStudent(url, guid)` would drag Prisma and the `Student` model into the layer that performs
the request.

**NULL means "ownership unknown", never "no owner".** An unstamped row falls back to the
household's most recently used connection and is included in household-scoped reads. The
alternative — refusing it — takes a single-school deployment that has not re-synced since the
migration from working to empty. Every upsert's `update` branch re-stamps, so the window closes
within one sync cycle.

**The sweep is re-enabled, scoped, and gated.** `lastFetchedAt < runStartedAt` is a sound orphan
test *because the row sets are disjoint* — that is the entire purpose of the column. The
connection-count gate is replaced by two narrower permanent ones: a shared-session run skips when
stamped rows exist, and a connection-scoped run skips while any row is unstamped. The
`pageCount === 0` guard stays: a 2xx empty walk is still indistinguishable from a referer-gated
or expired session, and that gate is the production-incident guard. `MAIL_SWEEP_ENABLED=false`
freezes the badge without a rollback.

**Years are per connection.** The honest shape for a student-keyed table is an OR of
(student-set, year) pairs; each school contributes its own children at its own year. A flat
`schoolYear IN (2026, 2027)` is *not* equivalent — it would admit school A's rows at school B's
year, which is how last year's data reads as current the moment one school rolls over.

**Fan-out is owner-first.** The stamped owner is tried first and a success on a non-owner
re-stamps. Ordering, never filtering: a stale stamp — a child who moved school — must stay
recoverable.

**The env session is kept, demoted and fenced.** It is load-bearing for boot, for
`ensureStudentsAvailable` and for every task's `useSharedSession` branch, which is the only path
on a fresh deploy and in the integration tests. But no user-facing read service may touch it, and
`src/session/env-session-fence.spec.ts` enforces that by injecting a client whose env methods
throw. Full removal is gated on dropping `MASHOV_SEMEL` / `USERNAME` / `PASSWORD` from `ops/`.

## Consequences

**Good.** Two schools can be linked without silent cross-contamination. The mail badge is the sum
of both mailboxes rather than the union counted twice. A behaviour event is classified by its own
school's policy. Unlink deletes one school's data and leaves the other's — and now also deletes
`studentRelease`, `schoolActivity` and the `student` rows themselves, all three of which leaked
before. A stamped child costs one upstream call per task instead of N.

**Bad.** Every per-school table carries an extra nullable `TEXT`, and `mail_message` carries it
denormalised from its conversation — bought deliberately, for a join-free `deleteMany` on unlink
and a direct connection resolve from a bare `messageId` during an attachment download.

**Operationally sharp.** Production boots with `prisma db push`, not `migrate deploy`, so the
backfill is wired into the Dockerfile chain explicitly and `boot-migrations.spec.ts` enforces
that for any migration carrying a data statement. One migration runs **before** push — the
duplicate-connection collapse — because push creates `@@unique([schoolCode, username])` from
`schema.prisma` before any migration SQL executes, and migration `20261117000000` deactivated
rather than deleted the duplicates it found. The backfill refuses rather than guesses: with two
or more active connections there is no way to know which owns a given row, and a wrong guess is
permanent while NULL is re-stamped within a cycle.

**Two long index names are pinned with `map()`.** Prisma's generated names for the composite keys
are 67 and 70 characters, past Postgres's 63-byte identifier limit, so they would be silently
truncated and `db push` would drift from the committed migration — the same trap
`digest_reported_item_dedup_key` already documents.

## Two known defects, both recorded as follow-ups

**A child can be owned by only one connection, so the second parent to sync evicts the
first.** `Student.studentGuid` is globally `@unique`, and the child upsert's `update`
branch sets `householdConnectionId` unconditionally. Any two Mashov accounts that both
list the same child therefore collide: whichever syncs second takes ownership, and the
first user's `householdStudentWhere` stops matching, so the child disappears from
their `/children` and every per-child route 404s.

This is not an exotic case. **ADR-0016** states as a live requirement that "two
parents in the same household must be able to independently track what they have
read", and **PRD open question 2** says two parents sharing one Mashov credential is
unsupported because "each user creates their own connection" — i.e. the supported
shape is two `AppUser`s, two connections, one school, the same children. That is
exactly the shape this breaks.

The root cause is that `householdConnectionId` was made to carry two different jobs:

1. **Routing** — whose credentials to use upstream for this child. One value is fine;
   any connection that lists the child will do, and a wrong guess self-corrects.
2. **Visibility** — which users may see this child. One value is *wrong*; this has to
   be a set, because a child can legitimately belong to several users.

Conflating them is the defect. Recorded as **B1** in
`docs/plans/merged-household-access-followups.md`, and **resolved by
[ADR-0031](0031-child-visibility-is-a-set-of-connections.md)**, which splits the two jobs:
visibility becomes a `student_connection` edge and this column keeps routing only. That
decision is taken; the implementation is still open under B1.

**The unstamped fallback is global.** `ConnectionScopeService.resolveOrFallback`
resolves an unattributed row with `findFirst({ active: true })` and no `userId`, so
with several users one family's unstamped conversation can resolve to another's
credentials. Mashov rejects it in almost every case, so the visible symptom is an
empty list rather than someone else's data — but one user's credentials are spent on
another's request, and for a mail mutation the upstream write lands in whichever
account the fallback picked. Recorded as **B3**.

## Alternatives considered

- **Reaching ownership through the conversation relation instead of a column on `mail_message`.**
  Prisma can express the join, but the column buys a join-free `deleteMany`, a direct resolve
  from a bare `messageId`, and symmetry with the conversation row the same upsert loop already
  writes. One `TEXT` per message, written by code already in that loop.
- **Keying `behavior_type_reference` by connection.** Rejected: the taxonomy is school-level, and
  two parents at one school must not duplicate it.
- **Making `householdConnectionId` required.** Rejected: `prisma db push` cannot add a required
  column to the populated production tables, and the shared-session path legitimately writes
  unowned rows.
- **A partial unique index (`WHERE active`) on `(schoolCode, username)`.** Rejected: Prisma
  cannot express a partial index, so the next `db push` would drop it and the constraint would
  disappear with no error anywhere.
