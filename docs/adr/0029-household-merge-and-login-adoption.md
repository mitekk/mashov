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

## What "household" means here, and what it does not

The word predates this ADR and was never defined as an entity. Every earlier use is a
scale adjective — "a household deployment" (ADR-0001), "the household operator"
(ADR-0002), "< 1 ms on the household scale" (ADR-0015) — and `HouseholdConnection`
carries it in a model name with no doc comment.

Two places do give it entity weight, and **both mean a household holds more than one
user**:

- **ADR-0016**: "Phase 2 introduces parent authentication, making household-global
  state incorrect: two parents in the same household must be able to independently
  track what they have read." This is a live requirement, not history.
- **PRD open question 2**: two parents sharing one Mashov credential is unsupported;
  "each user creates their own connection". The supported shape is therefore two
  `AppUser`s, two connections, one school, **the same children**.

So this ADR does **not** redefine "household". What it actually does is scope every
read and write to the signed-in **user** — `AppSession.userId` — and call that scope
a household because, for a single-parent deployment, the two coincide. Where they do
not coincide the scoping is wrong, and item **B1** in
`docs/plans/merged-household-access-followups.md` records the bug that results.

A real `Household` entity above `AppUser`, with several users sharing one set of
connections and children, is the shape ADR-0016 implies. It is not built here.

## Decision

**One `AppUser`, N connections.** `AppSession.userId` and `request.user = { userId }`
are unchanged, and every scoping predicate this work adds keys on that `userId`.

**Why no `Household` entity was introduced *in this change*.** `userId` is the application's universal scoping
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

## Known defect: the merge half is missing, and the flow it blocks is legitimate

The transaction this ADR's reversibility story implies — re-parent the connection, set
`mergedIntoUserId`, revoke the orphan's `AppSession`s *and* their Redis mirrors,
re-point `DigestRecipient`, copy non-conflicting `UserItemState` — **is not
implemented.** `AppUser.mergedIntoUserId` and the one-hop resolver in `AuthService`
that reads it exist and are tested; nothing writes the column.

Signing into school B first and later adding B from school A's session is a
**legitimate flow**, not an edge case: a parent has no reason to know which school to
sign into first. It currently dead-ends on `409 CONNECTION_ALREADY_LINKED`, because
B's connection already carries a `userId`, and there is no in-app remedy.

Recorded as **B2** in `docs/plans/merged-household-access-followups.md`. The manual
workaround until it is fixed — sign into B, `DELETE /school-links` to release it, then
sign into A and add it — works, but discards B's read/unread and archive flags, which
live on the orphan `AppUser`.

Whatever implements it must also clear `mergedIntoUserId` in
`ConnectionService.deleteOneConnection`, or this ADR's claim that unlinking lets a
later B login re-form its own household stays false: `resolveMergedOwner` would keep
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
