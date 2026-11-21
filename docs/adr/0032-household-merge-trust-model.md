# ADR-0032: A Household Merge Is a Confirmed, Password-Proven Move of One Connection

- **Date**: 2026-11-20
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent
- **Amends**: [ADR-0029](0029-household-merge-and-login-adoption.md) — closes its "Known
  defect: the merge half is missing" section and **corrects its reversibility claim**
- **Implements**: **B2** in `docs/plans/merged-household-access-followups.md`
- **Implemented by**: `db7a8b7` (the merge), `a4fb036` (the unlink pointer), the frontend
  confirm step, and `tests/integration/household-merge.test.ts`

## Context and Problem Statement

ADR-0029 decided that a sign-in with school B's credentials is *adopted* into whichever
household already holds B's connection, and that the application cannot know two Mashov
accounts belong to one parent — so signing into B first correctly creates B its own
`AppUser`. It then described a merge transaction for the reverse direction, gave it a column
(`AppUser.mergedIntoUserId`) and a resolver with tests (`AuthService.resolveMergedOwner`),
and **nothing ever wrote the column**.

The consequence was not an edge case. `SchoolLinksService` refused exactly the state the
column existed for: a parent who had signed into B first, then signed into A and tried to add
B, got `409 CONNECTION_ALREADY_LINKED` and no way forward in the app. A parent has no reason
to know which school to sign into first, so this is reachable by ordinary use. The only
remedy was manual — sign into B, unlink, sign into A, re-add — and because
`prepareConnectionDeletion` *hard-deletes* the row, that discards the school's entire dataset,
not merely the read/unread and archive flags ADR-0029 said it would.

Three questions had to be answered: what authorises a merge, how many steps it takes, and
what moves.

## Decision Drivers

- A merge revokes another household's sessions and moves its state. It must not be reachable
  without proof of entitlement, and it must not happen by accident.
- The orphan lookup on `(schoolCode, username)` is an existence oracle across every household
  on the deployment. **R17** deliberately put it behind the per-user rate limit; that must
  survive.
- `AppSessionService.validateSession` answers from `session:<token>` **without consulting the
  database**, so a session revoked in Postgres stays live until the Redis key is deleted.
- The application has no out-of-band channel to a parent. There is no verified email or phone;
  `ParentProfile` holds whatever Mashov reports about the account being claimed.

## Decision

### 1. The school's password is the authorisation, and it is proven first

`assertNoForeignOwner` became `findForeignOwner`, which **returns a verdict instead of
throwing**. The lookup stays exactly where R17 put it — after `assertLinkableFromOwnLinks`
(free, decided from the caller's own rows) and behind `checkRateLimit`. The *decision* between
a merge and a refusal moves to after `validator.validate` has succeeded and the roster has
been checked.

This is the same authorisation adoption already relies on: whoever holds school B's password
reaches household B's data either way. Moving the decision later **strictly reduces** what an
unauthorised caller learns — today's refusal arrives with no password proven at all. A wrong
password answers the generic `INVALID_CREDENTIALS`, never a hint that the account exists
elsewhere.

The alternative — demanding a confirmation code out of band — remains unavailable for the
reason ADR-0029 gave: there is no channel.

### 2. Two calls, because the parent confirms

`POST /school-links` answers `409 MERGE_AVAILABLE` on the first submit. The confirm is the
same `POST` with `confirmMerge: true`, **re-sending the credentials the form still holds**.
That costs one extra upstream login, which the rate limit already bounds, and it avoids
parking a decrypted password or a merge ticket in Redis.

The `409` carries only what a parent needs to recognise what they are about to move: the
school name and the child count — **and both are read from the login the caller just
authenticated**, not from the other household's rows. No email, no phone, no other parent's
name crosses the boundary. The frontend renders it as a confirmation in a parent's words (the
separate sign-in stops working; both schools' children appear here; the school can be unlinked
at any time), not as an error.

### 3. The adoption kill switch covers the merge

`MASHOV_ENABLE_SCHOOL_LINK_ADOPTION=false` is documented as the single switch for turning
this trust model off. The merge is a strictly *more* invasive form of it, so it is gated on
the same flag — `common/adoption-flag.ts`, now shared by `AuthService.login` and
`SchoolLinksService.createLink`. A switch covering only sign-in would go inert for exactly
the households that had already merged, since `mergedIntoUserId` routes their next sign-in
regardless. With the flag off, a foreign-owned connection gets the old
`409 CONNECTION_ALREADY_LINKED` and no offer.

### 4. Only a genuine orphan is merged

`AppUser.mergedIntoUserId` is documented as "this AppUser's **only** connection was absorbed".
So the merge is offered only when the foreign owner holds no other active connection. A
household actively using two schools is not an orphan: pulling one school out of it would
revoke a live household's sessions and leave the pointer naming a household that still exists.
That state keeps `409 CONNECTION_ALREADY_LINKED`; the parent can unlink from the other side.

Both this and the connection's ownership are **re-asserted inside the transaction**, because the
verdict is reached before an upstream login that takes seconds: the re-point is an
`updateMany` keyed on the owner it was decided against, and 0 rows aborts rather than
quietly stealing a connection that changed hands.

This distinction is observable only *after* the caller has proved that school's password, at
which point adoption already grants them the whole household — so it is not a new oracle.

### 5. What moves, and what does not

Everything keyed on `householdConnectionId` or `studentGuid` — mail, notifications, students,
releases, homework, behaviour, sync runs, the parent profile — travels with the re-parented
connection and is not touched. What is keyed on `userId` moves, in one `$transaction`:

| Table | Action | Why |
|-------|--------|-----|
| `HouseholdConnection` | re-parent with `userId`, `linkedByUserId`, `linkedAt` | the audit trail ADR-0029 requires |
| `AppUser` (orphan) | `mergedIntoUserId` = surviving household | makes the retired row interpretable |
| `AppSession` (orphan) | every unrevoked row revoked | §5 |
| `DigestRecipient` | plain `updateMany` re-point | the unique key is `[studentGuid, channel, address]` and **omits `userId`**, so the same tuple cannot exist under both households — a skip-on-conflict branch here would be dead code |
| `SchoolActivity` | re-point, **scoped to the travelling connection** | not named in B2; found in flight. `userId` is required with no AppUser relation, so these consent rows would strand on an AppUser nobody can sign into. Scoping to the connection makes it collision-free against `[userId, householdConnectionId, schoolYear, activityId]` — A cannot hold a row stamped to a connection it never owned. A row stamped to *no* connection is left behind, not because it would collide (`householdConnectionId` is nullable and Postgres treats NULLs as distinct, so `(A, NULL, year, id)` rows coexist) but because `activityId` is a per-school counter: an unstamped row names no school and no particular activity, and re-pointing it would put an unattributable consent request in the merged household's list |
| `UserItemState` | `createMany({ skipDuplicates: true })` | **copied, not moved**, and the surviving household's value wins on conflict. A merge that 500s halfway on a unique violation is worse than one that keeps A's preference |

The orphan `AppUser` row **survives**: `AppSession.userId` is a required relation with no
`onDelete`, so Postgres restricts the delete — and keeping it is what ADR-0029 intends anyway.

### 6. The Redis session mirror is deleted both before and after the transaction

`validateSession` returns `payload.userId` straight from the cache without a database read,
and the payload carries no `revokedAt` while it rolls its own TTL. So the DB revoke alone
leaves the orphan browsing a household whose every page has quietly emptied.

The keys are therefore deleted **twice**, and the order is the decision:

- **Before** the transaction — self-healing if it rolls back, because the next request
  re-validates against a still-live row and repopulates the cache.
- **After** it, over the token list read before it, closing the race where a request between
  the first delete and the commit repopulated the cache from the not-yet-revoked row.
- **After** it, also via `AppSessionService.revokeAllSessionsForUser`, which catches a session
  minted *during* the merge — one the pre-read list cannot know about.

The second and third are **both** needed, and the first review of this code caught why:
`revokeAllSessionsForUser` deletes keys only for sessions its own `revokedAt: null` query
returns, and the transaction has already revoked every one of them, so for those it finds
nothing and clears nothing. Relying on it alone left the window wide open — a request that
re-validated mid-transaction saw a row whose uncommitted `revokedAt` was invisible to it,
repopulated `session:<token>` with a rolling 300s TTL, and kept the orphan's session alive
indefinitely against a household that owned nothing. `tests/integration/household-merge.test.ts`
replays exactly that, by writing the key back from inside the transaction.

`revokeAllSessionsForUser` issues its own prisma calls, so it is **not** enlistable in the
transaction; the DB revoke happens inside, that method runs after the commit.

### 7. Sign-in after a merge goes through adoption, not through the pointer

Worth stating because it is easy to assume otherwise. After a merge, connection B carries
`userId = A` and B's own `AppUser` still exists. On a B sign-in, `existingUser` is B's
`AppUser`, `ownsConnection` is false (`A !== B`), so the **adoption** branch fires and the
session lands on household A without consulting `mergedIntoUserId` at all.
`resolveMergedOwner` matters only when connection B no longer exists — which is reachable,
because unlink deletes the row. The column is written because it makes the orphan's state
interpretable and because ADR-0029's reversibility story depends on clearing it, not because
sign-in reads it on the common path.

## Correction to ADR-0029

ADR-0029 states: *"Unlink sets `conn.userId = null` and keeps the row, so a later sign-in with
B re-forms its own household."* **Both halves were wrong.**

`prepareConnectionDeletion` ends with `householdConnection.delete`, so unlink deletes the
connection and its children, mail, notifications, releases, activities, profile and digest
rows. And the "re-forms its own household" half needed `mergedIntoUserId` cleared, or
`resolveMergedOwner` would drag B's next sign-in back into the old household forever. It now
is — scoped precisely:

```
appUser.updateMany({
  where: { mergedIntoUserId: userId,
           mashovUserId: { in: <upstreamUserIds of the connections being deleted> } },
  data:  { mergedIntoUserId: null },
})
```

The orphan's `AppUser.mashovUserId` equals the merged connection's `upstreamUserId`. Clearing
by `mergedIntoUserId` alone would, for a household holding schools A and B with B merged in,
release B's orphan when the parent unlinked **A** — while B's connection was still sitting
here, so a B sign-in would correctly adopt back into it and the released pointer would be a
lie. The ids are read before the transaction, because the transaction deletes the rows they
come from, and a connection with a null `upstreamUserId` identifies no orphan.

ADR-0029 also names `ConnectionService.deleteOneConnection`. No such method exists; it means
`deleteConnection`.

## Consequences

**Good.** The legitimate flow ADR-0029 blocked now has an in-app route, and it is reversible
for the first time. Whoever holds either school's password reaches the same household,
consistently in both directions. The `409` discloses strictly less about other households than
the refusal it replaces, because no refusal is issued before a password is proven.

**Bad.** The merge is irreversible in the sense that matters to the *other* parent: their
sessions end, and they learn why only by signing in again and finding both schools. The
mitigations are ADR-0029's unchanged — `linkedByUserId`/`linkedAt` record who asserted the
claim, and the school list is permanently visible on `/more`. Re-sending credentials on
confirm means a second upstream login per merge.

**Known limitations.**

- A foreign owner with more than one active school still dead-ends, by design (§3). The
  workaround is the manual one, and it now costs that school's dataset (§Correction).
- `SchoolActivity` rows stamped to no connection stay with the retired `AppUser`. They name no
  school, so re-pointing them risks a collision with the surviving household's own unstamped
  row for the same `(schoolYear, activityId)` and buys nothing.
- B2's e2e proves the **UI contract** — offer, confirm, resubmit with the flag — and not a
  real sign-in. The whole suite is route-mocked (`tests/e2e/auth.setup.ts` writes a bypass
  cookie and every spec intercepts `**/api/v1/**`), so the DoD's literal "sign in to B first,
  add B from A" is not reachable in that harness. The real end-to-end lives in
  `tests/integration/household-merge.test.ts`, against real Postgres and real Redis.
