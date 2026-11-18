# ADR-0029: One Household, N Schools, and Adoption at Sign-In

- **Date**: 2026-11-18
- **Status**: Accepted
- **Deciders**: Planner, Backend agent, Frontend agent

## Context and Problem Statement

A parent has children at two schools. Mashov issues a **separate account per school** — a
different username, a different password, and a different `credential.userId` — so today the
only way to see the second school's children is to sign out and sign back in with the other
account.

The schema was already shaped for this: `HouseholdConnection` is 1:N on `AppUser` with its own
`schoolCode`, `schoolYear` and encrypted password. The relation was unreachable through sign-in:

- `AppUser.mashovUserId` is `@unique` and set from the per-school `credential.userId`
  (`auth.service.ts`), so signing in with school B created a **second** `AppUser`, a second
  `AppSession`, and attached B's connection to that new user.
- So a parent could link school B from inside their session, sign out, sign back in with B's
  password, and land in an empty app with no route back to their own children. Linking a second
  school without this fix is a trap, not a feature.

Two further decisions were forced by the first:

- `README.md` already promises "a single, aggregated briefing across all your children", Home is
  already a cross-child feed, and every data table is keyed by `studentGuid` with no school
  column. So: **merged, not switched** — no "active school" mode at any layer.
- `docs/prd/PRD-current.md` has claimed since Phase 2 that this is "a secure, multi-tenant system
  where multiple parents … view only their own children's data". It was not. `Student` had no
  user or school column, and `ChildrenService.getChildren()` returned every active student row
  with no ownership check at all.

## Decision

**`AppUser` *is* the household.** One `AppUser`, N connections. `AppSession.userId` and
`request.user = { userId }` are unchanged.

**Not a `Household` entity above `AppUser`.** `userId` is the application's universal scoping
key — `UserItemState.userId`, `DigestRecipient.userId`, every `*.service.ts` signature. Moving
the session subject would rewrite the meaning of `userId` in every read/unread, archive and
digest path, for a deployment with one household, and would invalidate ADR-0015, ADR-0019 and
ADR-0020. This does not close that door: a later `Household` is a 1:1 backfill from this
invariant.

**Ownership is stamped per row.** `householdConnectionId` on `student`, `mail_conversation`,
`mail_message`, `notification_event`, `school_activity` and `parent_profile`; `schoolCode` on
`behavior_type_reference`, which is school-level rather than per-connection. Permanently
nullable: the shared env-credential session legitimately writes unowned rows, NULL means
"ownership unknown, re-stamp on the next roster refresh", and a required column cannot be added
to the populated production tables at all.

**Adoption at sign-in.** After Mashov has validated `(semel, username, password)` — and only
then — if that `(schoolCode, username)` names a connection already owned by an `AppUser`, the
session attaches to **that** household and no second `AppUser` is created. `isFirstLogin` is
`false`, which is correct: the data is already there.

A first-ever sign-in for an account nobody has linked still gets its own household. That is
deliberate and must stay: the application cannot know that two Mashov accounts belong to one
parent. Merging is always initiated from inside an authenticated session.

## Trust model

Adoption cannot be reached without the school's password: Mashov validates before the branch is
taken. The residual exposure is the reverse direction — once school B is linked into household X,
B's *legitimate* owner signing in later lands in X.

This is accepted, and mitigated rather than prevented:

- `HouseholdConnection.linkedByUserId` and `linkedAt` record who asserted "this account is mine".
- The school list is permanently visible on `/more`, so a household cannot hold a school the
  parent cannot see.
- Unlink sets `conn.userId = null` and keeps the row, so a later sign-in with B re-forms its own
  household. The reversal needs no support intervention.
- `MASHOV_ENABLE_SCHOOL_LINK_ADOPTION=false` restores the pre-merge behaviour entirely.

The alternative — demanding a confirmation code out of band — has no channel. The application has
no verified email or phone for a parent; `ParentProfile` holds whatever Mashov reports, which is
the same account being claimed.

## Deferred: merging two pre-existing households

The transaction this ADR's reversibility story implies — re-parent the
connection, set `mergedIntoUserId`, revoke the orphan's `AppSession`s and their
Redis mirrors, re-point `DigestRecipient`, copy non-conflicting `UserItemState`
— **is not implemented.** `AppUser.mergedIntoUserId`, and the one-hop resolver
in `AuthService` that reads it, exist and are tested; nothing writes the column.

The consequence is a real dead end. A parent who signs into school B *first*
gets their own household (which this ADR says is correct — the app cannot know
two Mashov accounts are one parent). If they later sign into school A and try
to add B, `POST /school-links` answers `409 CONNECTION_ALREADY_LINKED`, because
B's connection already has a `userId`. There is no in-app remedy.

The workaround until it is implemented: sign into B, unlink it from that
household (`DELETE /school-links`, which sets `conn.userId = null` and keeps the
row), then sign into A and add B. That works, and it loses B's locally-held
read/unread and archive flags, which live on the orphan `AppUser`.

When it is implemented, `ConnectionService.deleteOneConnection` must also clear
`mergedIntoUserId`, or this ADR's claim that "unlink … so a later B login
re-forms its own household" stays false — `resolveMergedOwner` would keep
dragging B's next sign-in into the old household.

## Consequences

**Good.** Either school's credentials reach the same merged household. Isolation is real for the
first time: reads are scoped to the caller's connections and `/children/:studentGuid` 404s on a
foreign child. The per-student sync fan-out tries the owning school first, which turns N upstream
calls per child into one. Four classes of silent wrong-data bug — colliding notification ids,
colliding consent activities, a behaviour taxonomy answering "is this absence justifiable" from
the wrong school, and a mail badge reporting the union of both mailboxes once per school — are
fixed before a second school can be linked.

**Bad.** Whoever holds either school's password reaches the whole household. Two accounts at the
*same* school are refused (`409 SCHOOL_ALREADY_LINKED`): the schema permits it, but it would
duplicate every child and break the one-chip-per-school model. A household is capped at four
active connections, bounding the sync fan-out against a rate-limited upstream.

**Known limitation.** `Student.studentGuid` is globally `@unique`, so **a child can belong to
only one linked school.** True in practice — a child is enrolled at one school — but a composite
`studentGuid` key across six tables is the price of expressing otherwise, and it is not paid
here.

**Deprecated for one release.** `me.connectedSchool` and `DashboardResponse.school` both encode
"the household has one school" and are populated from the first element of the new list.
`PUT /connection` and `DELETE /connection` are aliases over the same service methods as
`/school-links`.

## Alternatives considered

- **A `Household` entity above `AppUser`.** Rejected: it rewrites the meaning of `userId`
  everywhere for no benefit a 1:N relation does not already give, and invalidates three ADRs.
- **An "active school" switcher.** Rejected: it contradicts what the product already is, and a
  parent with children at two schools wants one briefing, not two.
- **Linking without adoption.** Rejected: it is the trap described above. The two halves are one
  change.
- **Refusing adoption and merging two existing households instead.** Kept as the `mergedIntoUserId`
  path for a household that already exists, but it cannot be the primary mechanism — a parent
  signing in with B before ever linking it has no household to merge into.
