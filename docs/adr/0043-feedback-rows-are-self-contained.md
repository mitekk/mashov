# ADR-0043: A Feedback Row Is a Self-Contained Snapshot, Not a Set of References

- **Date**: 2026-11-23
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent
- **Relates to**: [ADR-0029](0029-household-merge-and-login-adoption.md) (the merge retires an
  `AppUser`), [ADR-0032](0032-household-merge-trust-model.md) (the unlink clears
  `HouseholdConnection.userId`)
- **Implemented by**: `model Feedback`, `prisma/migrations/20261127000000_feedback`,
  `src/feedback/`, and `tests/integration/feedback.test.ts`

## Context and Problem Statement

The app gave a parent no way to tell us something is wrong. A wrong grade, a missing child or
a broken timetable looks identical from the outside to a Mashov upstream outage, and reports
arrived verbally, without context, or not at all. `POST /api/v1/feedback` is the write-only
channel that fixes that.

A report is worth nothing unless the reader can tell *who* sent it, *where* they were, *which
schools* they had connected and *which build* they ran. The obvious schema for that is
references: `userId`, plus the connection ids, read back by joining at report-reading time.

This deployment is the one place that does not work. Two facts about the household model
collide with it:

- **The merge retires an `AppUser`.** ADR-0029 adopts a sign-in into whichever household
  already holds that school's connection and leaves a `mergedIntoUserId` pointer behind. The
  row survives, but what it says about "the parent" stops being what it said when the report
  was written.
- **The unlink detaches a connection.** ADR-0032's unlink clears `userId` (and
  `prepareConnectionDeletion` hard-deletes in the other direction), so the set of schools a
  `userId` resolves to is a *current* answer, not a historical one.

Both are reachable by ordinary use, and both bite hardest in the two-school household — the
case most worth reading a report about. A reference-only row would become uninterpretable
exactly when it mattered.

## Decision Drivers

- A report must stay readable for as long as it is kept, without depending on rows that other
  features are entitled to move or delete.
- Production's schema comes from `prisma db push --accept-data-loss` on every boot, and the
  committed `migration.sql` is the record that must stay idempotent.
- The short school label is a **set-resolved** rule (`common/school-label.ts`): two schools in
  one cluster share everything up to a `" - …"` qualifier, and a collision reverts both sides
  to their full names. A row that snapshots the raw nullable `displayLabel` would file two
  reports under the same unreadable name.
- `AppUser.displayName` is one credential's per-school string and arrives as the parent's name
  plus ONE of that school's children — `"קורס דמיטרי [מיקה ז8]"`.

## Decision

**Each `feedback` row carries a denormalized copy of the parent and of their schools, and no
foreign key.**

Stored at write time, from the server rather than the client:

- `mashovUserId`, `username`, and `displayName` — the last run through
  `common/parent-name.ts`, so one child's class tag is not persisted into every row of a
  multi-child household.
- `schoolsSnapshot`, a `Json` array of `{ id, schoolCode, schoolName, label, schoolYear }`
  over the household's **active** connections, with `label` resolved over the whole set. The
  connection `id` is kept so a reader can re-join the live row while it still exists —
  denormalization here is about surviving its absence, not about refusing to use it.
- `userAgent` from the request header, truncated to 512 characters, and `appVersion` from the
  server's own `APP_VERSION` when the client sends none.

`userId` stays a plain `String`. There is deliberately **no `@relation`, and no back-relation
on `AppUser`**:

1. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so an FK cannot be written idempotently in
   a migration that `db push` may or may not have already applied. Every migration in this
   repo sidesteps that; the precedent is `MailNotifiedMessage.userId`.
2. An FK would block deleting an `app_user` whose snapshot exists precisely so the report
   outlives it.

## Consequences

**Good**

- A report stays interpretable after a merge, after an unlink, and after the `app_user` row is
  gone entirely.
- The reader needs one `SELECT` and no joins.
- Nothing in the household model has to care that this table exists. The feature adds no edge
  to the sync graph, no Redis dependency, and no cascade.

**Bad**

- The copy can disagree with the live rows, by design. A parent who renames a school sees the
  old label on an old report. That is the point, but it means a reader must not treat
  `schoolsSnapshot` as current.
- The duplication is real duplication: a schema change to the snapshot shape does not migrate
  old rows, so a reader has to tolerate older entries.
- `userId` has no referential integrity. A typo in a hand-written insert would not be caught.

## Retention

**Kept indefinitely, deliberately — and this is the weakest part of the decision.**

Free text, a reply address, a user agent and a page path make `feedback` the most PII-dense
table in the schema. `pagePath` is the sharpest part of that: on the child routes it is
`/children/<guid>`, so the row names a child. That is deliberate and not a cross-household
leak — the guid is the reporting parent's own child, already theirs to see — and without it
a report reading "the timetable is wrong" names no child at all. It does mean a reader of
this table is reading child-linked data, which is the reason the retention question below is
not academic.

There is no deletion path: no nightly cutoff task, no parent-facing
delete, no export. The reasoning for keeping it that way for now is that the table's only
reader is a human running SQL, the volume is bounded by 10 rows per household per hour, and a
report whose context has been aged out is a report that cannot be acted on.

That reasoning expires. If this table outlives its first few months of use, the follow-up is a
nightly cutoff modelled on `SyncRunRetentionTask`, which already does exactly this shape of
delete on `sync_run`. This section is the record that the choice was made rather than
overlooked.

## Also deliberately absent

- **No read path.** No admin UI, no `GET /feedback`. SQL suffices, and a read path is an
  authorization surface over other people's free text.
- **No notification.** Reports accumulate unseen until someone looks. The cheap fix, if it is
  wanted, is a fire-and-forget operator message through the existing Telegram sender behind a
  `FEEDBACK_TELEGRAM_CHAT_ID`, with failures logged and not raised.
- **No reply thread and no email delivery.** `contactEmail` is a way to reach the parent by
  hand, not a channel the app operates.

## Rate limiting

Counted **per user**, as rows in the last hour, not by the global `ThrottlerGuard` — which
keys on IP and would lock out a whole school NAT or both parents of one household. This
follows what `POST /school-links` already does, without Redis: a `feedback.count` over
`@@index([userId, createdAt])` is both cheap and integration-testable, which a decorator is
not. The route keeps `@Throttle` as a crude per-IP backstop.
