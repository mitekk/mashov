# Follow-ups from the merged-household-access branch

Everything deferred from `feat/merged-household-access` (`8c0939f..HEAD`), which
implemented steps 1–12 of [the plan](merged-household-access.md). See
[ADR-0029](../adr/0029-household-merge-and-login-adoption.md) and
[ADR-0030](../adr/0030-per-connection-data-scoping.md) for the decisions it rests on.

Two whole-branch reviews have run. The first graded nine items Critical or Important;
eight were fixed on the branch, and **B1** was fixed afterwards in `1dcb60e`. The
second (`/code-review high`, 2026-11-19, after **G1** landed) found twelve more, all
recorded here as **R1–R12**.

What is open: **B2–B4** and **R1–R12**, the two operational tasks the plan itself
deferred (**T13–T14**), and the minors. **G1** and **B1** are done and kept as record.

A third review (`/code-review high`, 2026-11-19) ran after **R2** landed. It added
**R13** and **R14** below and sharpened **B3**; everything else it found was already
recorded here. **R1**, **R2**, B3's attachment leak and batch 3 (**R3**, **R5**,
**R6**, **R13**, **N1** and the label-set minor) are done. **No cross-household read
is open any more**: every remaining item is a degraded signal, a frontend gap or a
pre-existing bug.

## Pick-up order

Each batch is one session's work and leaves the tree green on its own. Within a batch
the items share a seam, so splitting them costs more than doing them together.
**Status is the per-item DoD boxes, not a guess** — tick them as you go and this table
stays true.

| # | Items | Status | Why here |
|---|---|---|---|
| 1 | **R1** + **B3** + `updateCachedNewCount()` | **done**, 1 bullet left | The only finding where one household wrote another's data upstream with their credentials. Included the stamped-branch attachment leak the third review found. B3's remaining bullet — the stamped branch of `resolveOrFallback` generally — has no known reachable path and is not a production gate. |
| 2 | **R2** | **done** | A permanently broken unlink. Fixed with the stamp, the relation-filtered delete, one transaction for the whole unlink, and an index on `mail_message.conversationId`. |
| 3 | **R3**, **R5**, **R6**, **R13** + the label-set minor, and **N1** found while reading | **done** | One missing household predicate across four readers, on the `userId` threading batch 1 established. Closed the last place another household's data reached a screen. The mail scope moved to `common/mail-scope.ts` and the chip labels to `common/school-chips.ts`, so `/children`, `/dashboard`, `/feed` and the inbox now answer from one scoping path and one label resolution instead of four. |
| 4 | **R4** | open | Same visibility-edge fix as batch 3, in a service with no callers in common. Was offered a ride with batch 3 and deliberately left out of it; it is now the next batch. |
| 5 | **R7**, **R14** + the `MorePageClient` dead term | open | The only frontend items. R14 leaves a parent looking at an empty mailbox with no way forward, which is the worst *experience* left open. Needs an e2e run, so it is cheapest on its own. |
| 6 | **R12** + **R11** + the "connection-scoped refresh fans out over every child" minor | open | All three are the refresh envelope lying to the parent — R12 says `success` when a school failed, the minor says `partial` when one succeeded. |
| 7 | **R8**, **R9**, **R10** | open | Three independent small correctness fixes in the auth/link path; one session, three tests. |
| 8 | **B2**, **B4** | open | Pre-existing bugs with no dependency on the above. |
| 9 | **T13**, then **T14** | open | T13 needs real second-school credentials and a full cron cycle; T14 closes the branch out. `.env.example` is reachable again as of the `DB_PORT` commit, so T14's last bullet is no longer blocked. |

Batches 1, 2 and 3 are done, and with batch 3 no open item puts one household's data on
another's screen. **Batch 4 is next.** Batches 4–7 are each self-contained; 7 can run in
parallel with anything.

---

## Bugs

### B1 — A child can belong to only one user, so the second parent to sync evicts the first

**Status: FIXED** in `1dcb60e`, implementing
[ADR-0031](../adr/0031-child-visibility-is-a-set-of-connections.md). The description
below is kept as the record of what was wrong and why.

**Severity**: high. Breaks a stated requirement, and the data loss is visible to a
parent as their children vanishing.

**Cause.** `Student.studentGuid` is globally `@unique`
(`backend/prisma/schema.prisma`), and the child upsert's `update` branch sets
`householdConnectionId` unconditionally in two places —
`school-links.service.ts` (`persistLink`) and `auth.service.ts`
(`persistLoginRoster`). The branch then uses that single value for *two different
jobs*:

1. **Routing** — whose Mashov credentials to use upstream for this child
   (`ConnectionScopeService.targetForStudent`). One value is correct here: any
   connection that lists the child will serve, and a wrong guess self-corrects on the
   next sync.
2. **Visibility** — which users may see this child
   (`ChildrenService.householdStudentWhere` / `ownsStudent`,
   `DashboardService.householdStudentWhere`). One value is **wrong** here, because a
   child can legitimately belong to more than one user.

Conflating the two is the defect.

**Description.** Two parents, each with their own Mashov account at the same school,
both listing the same children — the shape **ADR-0016** requires ("two parents in the
same household must be able to independently track what they have read") and **PRD
open question 2** describes ("each user creates their own connection"). Today:

- Parent A signs in; the children stamp to A's connection; A sees them.
- Parent B signs in; the same `studentGuid` rows re-stamp to B's connection.
- A's `/children` is now empty, `GET /children/:guid` 404s for A, and A's
  `UserItemState` read/archive flags become unreachable — the rows survive, but
  nothing can reach the child they belong to.
- It then flips back the next time A syncs. The children oscillate between the two
  parents, one sync cycle at a time.

`UserItemState` itself is unaffected (keyed per `AppUser`), so no read state is
*lost* — it is only made unreachable while the other parent holds the stamp.

**Shape — decided.** [ADR-0031](../adr/0031-child-visibility-is-a-set-of-connections.md):
visibility becomes a `student_connection` many-to-many edge; `householdConnectionId` keeps
routing only. The two alternatives and why they lost are in that ADR — in short, "derive it
from the retained roster" is the same table with a name that invites pruning a parent's
access away, and a `Household` above `AppUser` does not fix the defect at all, because two
parents who have not merged still collide on one global `Student` row.

The work, in the order it has to happen:

1. `student_connection` (`studentGuid`, `householdConnectionId`, `firstSeenAt`,
   `lastSeenInRosterAt`), `@@id` on the pair, indexed on the connection. Additive, so
   push-safe; backfill one row per currently stamped child.
2. The three roster writers upsert a link beside the stamp they already write:
   `MashovSessionService.persistRoster`, `AuthService.persistLoginRoster`,
   `SchoolLinksService.persistLink`.
3. Four read predicates move from "the stamp is one of mine" to "a link to one of mine
   exists": `ChildrenService.householdStudentWhere`, `ChildrenService.ownsStudent`,
   `DashboardService.householdStudentWhere`, and the guid→year map in `school-year.scope.ts`.
   No-link children stay readable by any caller, exactly as `ownsStudent` documents today.
4. **`ConnectionService.deleteOneConnection` — the risky one.** It deletes the link row, and
   the `Student` plus its per-child rows **only when no link remains**. A shared child
   survives one parent unlinking. Done wrong this deletes the other parent's children and
   their whole history, which is the same failure class the branch already fixed once for the
   `NULL`-stamp predicate.
5. Leave `targetForStudent`, `orderConnectionsForStudent` and `stampOwnershipIfChanged`
   alone. The owner-first optimisation is routing, and routing is not what was broken.

**DoD**
- [x] A decision is recorded as an ADR (amending ADR-0030's "two known defects") —
      [ADR-0031](../adr/0031-child-visibility-is-a-set-of-connections.md).
- [x] Unlinking one of two connections that share a child leaves the child, its homework,
      behaviour, releases and digest rows intact for the other parent — asserted by test
      (`connection.service.spec.ts`, and against a real database in
      `tests/integration/household-isolation.test.ts`).
- [x] Two users with separate Mashov accounts at one school both see the shared
      children, simultaneously, with no sync ordering dependence.
- [x] Each user's read/unread and archive state stays independent (ADR-0016), asserted
      by test rather than by inspection.
- [x] A sync cycle for either user leaves the other user's view unchanged — asserted by
      moving the routing stamp in both directions and re-reading both users' visible
      sets. **Not** by running the real `refreshAll` twice: that needs the two-household
      sync fixture still open under **G1**, and the stamp is the only thing a sync
      changes about ownership.
- [x] `targetForStudent` still resolves to a connection that can actually serve the
      child, and the `homework.task` owner-first optimisation still makes exactly one
      upstream call for a child whose owner answers — both read the routing column,
      which this change deliberately left alone.
- [x] An integration test covers it with a two-household fixture
      (`tests/integration/household-isolation.test.ts`, 8 cases against real Postgres).

---

### B2 — Adding school B from school A's session dead-ends when B was signed into first

**Severity**: high. A legitimate flow with no in-app remedy.

**Cause.** `AppUser.mergedIntoUserId` and `AuthService.resolveMergedOwner` (the
one-hop resolver, with tests) were both added; **nothing writes the column**. The
household-merge transaction described in the plan's §1 — re-parent the connection,
set `mergedIntoUserId`, revoke the orphan's `AppSession`s *and* their Redis
`session:<token>` mirrors, re-point `DigestRecipient`, copy non-conflicting
`UserItemState` — was never implemented.
`SchoolLinksService.assertLinkable` therefore rejects exactly the state it was for.

**Description.** A parent signs into school B first (correct per ADR-0029: the app
cannot know two Mashov accounts are one parent, so B gets its own `AppUser`). Later
they sign into school A and try to add B from `/more/schools/new`.
`POST /api/v1/school-links` answers `409 CONNECTION_ALREADY_LINKED` because B's
connection already carries a `userId`. The parent has no way forward in the app, and
nothing explains why — a school they can plainly sign into cannot be added.

A parent has no reason to know which school to sign into first, so this is reachable
by ordinary use, not by misuse.

**Manual workaround today**: sign into B, `DELETE /api/v1/school-links` to release the
connection (which sets `userId = null` and keeps the row), then sign into A and add B.
It works, and it discards B's read/unread and archive flags, which live on the orphan
`AppUser`.

**DoD**
- [ ] `POST /school-links` for a connection owned by *another* `AppUser` offers a
      merge rather than a flat 409, after proving the caller holds that school's
      password (the same authorisation adoption already relies on).
- [ ] The merge runs in one transaction: connection re-parented with
      `linkedByUserId`/`linkedAt`, `mergedIntoUserId` set on the orphan,
      **every orphan `AppSession` revoked including its Redis mirror**,
      `DigestRecipient` re-pointed, non-conflicting `UserItemState` copied and
      conflicts skipped.
- [ ] A live orphan session cannot survive the merge into a state where every page
      silently empties — asserted by test.
- [ ] `ConnectionService.deleteOneConnection` clears `mergedIntoUserId`, so unlinking
      genuinely lets a later B sign-in re-form its own household. Without this,
      ADR-0029's reversibility claim stays false.
- [ ] `resolveMergedOwner`'s existing one-hop/cycle/self-pointer tests still pass
      unchanged.
- [ ] An e2e case covers sign-in-to-B-first → add-B-from-A → both schools' children
      visible in one session.

---

### B3 — The unstamped-row fallback resolves to any user's credentials

**Severity**: medium. Bounded by Mashov rejecting the request, not by this code.

**Cause.** `ConnectionScopeService.resolveOrFallback`
(`backend/src/common/connection-scope/connection-scope.service.ts`) falls back to
`findFirst({ where: { active: true }, orderBy: { lastLoginAt: 'desc' } })` with no
`userId` predicate. Its callers — `targetForStudent`, `targetForConversation`,
`targetForMessage` — do not take one either.

**Description.** With more than one user, an unattributed row (`householdConnectionId
IS NULL`) belonging to user A can resolve to user B's connection, and A's request is
then sent upstream under B's decrypted Mashov password. Mashov rejects it in almost
every case, so the visible symptom is an empty list rather than another family's data
— but one user's credentials are being spent on another's request, and for a mail
mutation (`markUnread`, `archive`, `unarchive`) the upstream write lands in whichever
account the fallback picked.

Unstamped rows exist whenever the ownership backfill refused, which it does on any
database with more than one active connection
(`20261120010000_connection_scoping/migration.sql`).

**DoD**
- [x] `targetFor*` accept an optional `userId` and the fallback is scoped to it when
      present.
- [x] Callers that have a `userId` pass it: `ChildrenService` (every per-child route
      already holds one — **25** of them take a `studentGuid`, enumerated by
      `tests/integration/children-route-guard.test.ts`; the "nine" this item used to
      say was the count an earlier review named, not the route count),
      `MailService.getConversationDetail` and the attachment path.
- [x] A test asserts an unstamped row belonging to user A never resolves to user B's
      connection.
- [x] The no-`userId` path (digest, crons) keeps today's global fallback, with a test
      pinning that.

**Scope correction (third review, 2026-11-19).** The `userId` threading above fixed the
**fallback** branch of `resolveOrFallback` (`:215`). The **stamped** branch (`:202-207`)
still ignores `userId` entirely: a non-null stamp resolves to that connection's target
whoever is asking. ADR-0030 records that as the deliberate `I6` ruling, on the stated
bound that "Mashov rejects it in almost every case, so the symptom is an empty list
rather than a leak". That bound does not hold on one path:

`MailService.downloadAttachment:340` resolves `targetForMessage`, which reads the
**message's** stamp, while the only ownership check it passed is `assertVisible` on the
**conversation** — and `canSee:639` admits a NULL-stamped conversation for every
caller. So an unstamped conversation whose message rows are stamped to household A
lets household B download that attachment under A's decrypted Mashov password. The
`.catch()` fallback to `targetForConversation` fires only when the message row is
missing, never when it is foreign-stamped. Mashov accepts this one, because the
credentials and the message genuinely belong together — the request is well-formed and
the file comes back. That shape exists on any database where the ownership backfill
refused, which is every deployment with more than one active connection.

- [x] `downloadMessageAttachment` checks the message's stamp against the caller before
      resolving, the second of the two options — `canSee` on
      `message.householdConnectionId`, so NULL stays admitted and the 404 reuses the
      genuinely-missing-message phrasing. Fixed in `674ff50`. The row the check reads is
      kept in step with the one the attachment came from, since the retry's hydration
      can re-stamp it.
      **3 integration cases** in `tests/integration/household-isolation.test.ts` against
      real Postgres with the real `ConnectionScopeService` and a spy http client: B's
      download of a message stamped to A under an unstamped conversation 404s with *no
      upstream call*, A is still served, and an unstamped message is still served to
      either household. Red before the fix was worse than predicted — the call
      **resolved**, i.e. B got the file. Plus 2 unit cases, verified red by deleting the
      guard (the foreign-stamp case failed, the other 73 stayed green).
- [ ] The stamped branch of `resolveOrFallback` itself still ignores `userId`, so
      `targetForStudent` and `targetForConversation` can still resolve a foreign stamp
      when their callers' own ownership checks do not bound it. No path like the
      attachment one is known to remain — `assertVisible` bounds the conversation
      callers, and a shared child's stamp is the other parent's *by design* (ADR-0031),
      which is R4/R6's territory rather than a leak. Recorded as the remaining general
      case: the fix is to treat "stamped outside the caller's connections" as unstamped
      and fall through to the `userId`-scoped fallback, which for a shared child lands
      on the caller's own connection at the same school.

---

### B4 — `/more` shows contact details from whichever school created the account

**Severity**: low, but it is a wrong value in a screen a parent may act on.

**Cause.** `SettingsService.getProfile` looks `ParentProfile` up by the calling
`AppUser`'s own `mashovUserId`. That id comes from the credential that *created* the
`AppUser` — the first school signed into. `ParentProfile.upstreamUserId` is a
per-school id, so a two-school household has two rows, and `user-details.task` keeps
both current.

**Description.** A parent who updates their phone number at school B still sees
school A's value on `/more`, with nothing indicating which school it came from. I
originally graded this cosmetic; it is not, because the number shown is the one the
parent will assume the school has.

**DoD**
- [ ] `/more` either lists a profile per school, or labels which school the shown
      details came from.
- [ ] `GET /settings/profile` returns per-school profiles, or accepts a connection id.
- [ ] A test covers a two-school household with differing contact details on each.

---

## Bugs the second review found (2026-11-19)

`/code-review high` over `master...HEAD`, run after **G1** landed. Twelve items, none
of them already recorded in this file. Every file:line below is as of `8f40e99`.

**R1, R3, R5 and R6 are one finding seen from four angles**: the per-household scoping
this branch introduced was wired into `MailService.getSummary` and the sync tasks, and
never into the mail read/mutate paths, the feed, or the per-child school labels. Fix
them as one pass, not four. **R1 also subsumes most of B3's second DoD bullet** —
threading `userId` into `MailService` is the same edit — so do B3 with it.

### R1 — Every mail path except the badge is unscoped, and `?schoolId=` is unchecked

**Severity**: high. The only finding on this branch where one household reads *and
writes* another's data with the other's credentials.

**Cause.** `backend/src/mail/mail.service.ts:153` — `getConversations` never receives a
`userId` from `mail.controller.ts` and applies no `householdMailScope`. Same for
`getConversationDetail` (`:219`), `markConversationsRead` (`:785`), `markUnread`
(`:838`), `archive` (`:881`), `unarchive` (`:902`) and the attachment download. The
branch added `householdMailScope` and wired it into `getSummary` only.

**Description.** On a box with two households:

- `GET /mail/conversations` returns every household's mail while `/mail/summary` counts
  only the caller's — the badge and the list disagree on the same screen, which is the
  class of bug `283c053` was about.
- The new `?schoolId=` query param goes straight into `buildInboxWhere` with no
  ownership check, so `GET /mail/conversations?schoolId=<another household's connection
  id>` returns that household's inbox. `/school-links` and `/sync/*` both 404 on a
  foreign `schoolId`; this does not.
- `PUT /mail/conversations/archive` with a foreign `conversationId` archives it locally
  and, via `groupConversationsByConnection` → `targetFor`, **upstream with that
  household's Mashov credentials**.

**DoD**
- [x] Every `MailService` method that reads or mutates conversations takes the caller's
      `userId` and applies `householdMailScope`, the controller passes it, and
      `?schoolId=` 404s on a connection the caller does not own.
- [x] A test seeds two households and asserts the list, the detail, archive/unarchive
      and `markUnread` all refuse the other household's `conversationId`, and that a
      foreign `?schoolId=` 404s. `tests/integration/household-isolation.test.ts` is the
      natural home; `mail-sweep-unattributed.test.ts` already has a two-mailbox fixture
      to copy.
- [x] B3's `userId`-threading bullet is ticked by the same change.

### R2 — Unlinking a school 500s for any parent who has ever opened a conversation

**Severity**: high. A permanently broken `DELETE /school-links/:id`, recoverable only
by hand in the database.

**Cause.** `backend/src/connection/connection.service.ts:283` deletes `mailMessage` by
`householdConnectionId: connection.id`, then `mailConversation` by the same key,
relying on the stamps being in sync — the comment above it notes the FK and the
required order. But `MailService.fetchAndStoreConversationDetail`
(`mail.service.ts:486`) upserts `mailMessage` rows with **no `householdConnectionId`
at all**.

**Description.** Every message the inbox-list payload did not carry — i.e. the body of
every conversation the parent has actually opened — stays NULL-stamped while its
conversation is stamped. `mailConversation.deleteMany` then violates
`mail_message_conversationId_fkey`, the whole `$transaction` aborts, and the unlink
500s. It is not transient: it fails identically on every retry.

**Status: FIXED** in `fc85cf8` (the stamp) and `b6565a9` (the delete predicate).

**DoD**
- [x] The detail fetch stamps `householdConnectionId` on the messages it writes.
      `hydrateConversationFromUpstream` / `persistUpstreamConversationDetail` now take
      the conversation's own stamp — not the resolved upstream target, because keeping
      the message and conversation stamps identical is exactly the invariant the unlink
      was written against — and the `mailMessage.upsert` carries it into `create`
      always and into `update` only when the conversation is stamped, so an
      unstamped conversation cannot un-stamp a message a sync walk had already
      attributed correctly — the same rule as the walk's own re-stamp in
      `sync/tasks/mail-inbox.task.ts:393`. The `update` branch is a consistency
      rule and **not** a self-heal for rows written before the fix, which is how
      the DoD put it: `getConversationDetail` hydrates only when no stored
      message has a renderable body, and every row the old detail fetch wrote has
      one, so a legacy NULL-stamped row re-enters this upsert only through the
      attachment-download fallbacks. What reaches those rows is the sync walk
      (for conversations upstream still returns) and the delete predicate below.
      All four call sites already passed the whole `mailConversation` row, so none
      changed. **And** the unlink no longer depends on the stamp:
      the delete matches `conversation: { householdConnectionId } OR
      householdConnectionId`, still ahead of `mailConversation.deleteMany` for the FK.
      (It first used a pre-read of conversation ids and an `IN` list; `c82ebc1`
      replaced that with the relation filter — see the Minors below for why.) Both halves are needed and neither
      substitutes for the other — stamping reaches future and re-fetched rows, and
      nothing reaches the already-NULL ones but the predicate.
- [x] A test opens a conversation detail, then unlinks that school.
      `tests/integration/household-isolation.test.ts`, **2 cases** against real
      Postgres in the `Two mailboxes, two households` describe: one drives
      `getConversationDetail` through the real hydration path (spy `getForTarget`
      returning a one-message detail payload), asserts the written `mailMessage`
      carries the conversation's connection, then unlinks and asserts the
      conversation and its messages are gone; the second inserts a NULL-stamped
      message under the same conversation directly — the exact shape of a row written
      before this fix — and asserts the unlink still succeeds and removes it, which is
      the half that stays red if only the stamping lands. Verified red at `fc85cf8^`,
      and the two reds are different, one per half: the hydration case fails on the
      message stamp being `null`, which it asserts before it unlinks, and the
      NULL-stamped case fails on `Foreign key constraint violated:
      mail_message_conversationId_fkey` out of the aborted `$transaction`. Both cases
      also assert the blast radius — B's conversation and message, and the
      unattributed conversation and its message, all still present after A unlinks —
      because `conversationId IN (…)` is wider than the stamp predicate it replaced
      and nothing else in the suite would fail if it widened further. Verified red by
      dropping the `householdConnectionId` filter from the pre-read: both cases failed
      on B's and the unattributed rows being gone, and nothing else did.
      Unit cases pin the two edits where
      the unit suite catches a regression cheaply: three in `mail.service.spec.ts`
      (`create` carries the stamp, `update` carries it, an unstamped conversation
      writes no `householdConnectionId` into `update`) and one in
      `connection.service.spec.ts` (the predicate reaches this connection's
      conversations and still runs before `mailConversation.deleteMany`).
      On "asserts 204": the assertion is at service level, where `deleteConnection`
      resolving `{ ok: true }` is the whole of it — `school-links.controller.ts:133`
      is a static `@HttpCode(HttpStatus.NO_CONTENT)` on a handler that does nothing
      but await this service, so standing up the HTTP harness adds no information.

### R3 — `/dashboard` and `/feed` render other households' mail

**Severity**: high (same gap as R1, read-only).

**Cause.** `backend/src/dashboard/dashboard.service.ts:190` — `getFeed` scopes its
`student` read with `householdStudentWhere` and its homework/behaviour reads through
`historyScopeForStudents`, but `mailConversation.findMany` has **no `where` at all**.
`backend/src/feed/feed.service.ts:78` has only an `archived` filter, and its
`student.findMany` (`:60`) is unscoped too, unlike the dashboard's.

**Description.** Other households' mail subjects and sender-name previews appear as
feed items on `/home`, each with `schoolId: null` so the school chip filter leaves them
visible.

**DoD**
- [x] Both feed readers scope conversations by `householdMailScope` and students by the
      visibility edge. The scope moved out of `MailService` into
      `common/mail-scope.ts` first, verbatim, so there is one definition of it rather
      than a second copy to miss again. The dashboard resolves it once in
      `getDashboard` and passes it into both private readers, so the query count is
      unchanged. Both mail predicates are an `AND` array, not a merged object: the
      scope is an `OR`, so a spread lets one predicate overwrite the other.
- [x] A test asserts household A's `/dashboard` and `/feed` contain no item sourced
      from B's mailbox or B's children.
      In `tests/integration/household-isolation.test.ts`, on the shared-children
      fixture extended with one unread conversation per connection.
      Note on the student half: every feed *item* is already year-scoped by child, so
      the unscoped roster could not put a foreign child's homework in the feed — what
      it did reach was the school map built from those rows, which is **R5**. The
      honest red for it is the `where` assertion in `feed.service.spec.ts`, and the
      integration case is a guard.

### R4 — The freshness card reads every household in the database

**Severity**: medium. Degrades a signal the parent is told to trust.

**Cause.** `backend/src/sync/freshness.service.ts:142` — `computeContentFreshness`
reads *every* active connection with no `userId` and reports the worst verdict, while
`contentFreshnessForConnection` selects that connection's children by the **routing
stamp** (`householdConnectionId: connection.id`) rather than the visibility edge.

**Description.** This is the B1 shape surviving in one more place. Two parents at one
school share a child; the child is stamped to whichever connection synced last, so the
other connection resolves `studentGuids: []` → `no_content`, which
`worstContentFreshness` ranks above `current` and degrades the *whole* dashboard's
freshness card. Separately, any unrelated household linking a fresh school drags every
household's card to `no_content`.

**DoD**
- [ ] The student predicate uses the visibility edge (`connectionStudentWhere`), and
      the aggregation is per household (`userId` threaded in).
- [ ] A test with two households asserts one household's empty connection does not
      change the other's verdict.

### R5 — `resolvedFor` can hand a caller another household's connection id and label

**Severity**: medium.

**Cause.** `backend/src/common/student-school-map.ts:53` — `resolvedFor` falls back to
`links[0]` and prefers the stamp whenever it is *among the links*, with no filter to
the caller's own connections; `byId` is then built from
`householdConnection.findMany({ where: { id: { in: connectionIds } } })`, also
unfiltered.

**Description.** For a child both parents at one school list, parent B's `/dashboard`
and `/feed` get `schoolId` = parent A's connection UUID and `schoolShortLabel` = A's
parent-chosen `displayLabel`. That leaks A's id and label, and because
`HomePageClient.semelOf` / `InboxPageClient.semelOf` resolve `schoolId` against
`me.schools`, the lookup misses and the child's school chip can never match it.

**DoD**
- [x] `buildStudentSchoolMap` takes the caller's connection ids and intersects before
      choosing — a third optional `userId` argument rather than a second helper. The
      stamp wins only when it is in the filtered set, else the first of it; a child
      whose links are all somebody else's gets no badge rather than a foreign id; and
      the pre-backfill fallback to the stamp survives only when the stamp is one the
      caller owns. `byId` therefore cannot hold anything but the caller's connections.
      Without a `userId` the behaviour is unchanged, verbatim, and
      `student-school-map.spec.ts` pins that too — including that the unscoped path
      asks for no connections of its own.
- [x] A test asserts the shared child's `schoolId` is always one of the caller's own
      connections, in both the dashboard's `children[]` and the feed items, and that
      moving the routing stamp back and forth moves neither parent's answer.

### R6 — `/children` derives school fields from the stamp while `/home` uses the edge

**Severity**: medium.

**Cause.** `backend/src/children/children.service.ts:141` — `getChildren` derives
`schoolId` / `schoolName` / `schoolShortLabel` / `semel` from
`student.householdConnectionId` keyed against `resolveSchoolLabels(userId)` (the
caller's connections only), while `DashboardService` and `FeedService` go through
`buildStudentSchoolMap` and the visibility edge.

**Description.** For a child stamped to the other parent's connection, `/children`
emits a `schoolId` the caller does not own with `schoolName` / `schoolShortLabel` /
`semel` all `null`. So the `SchoolBadge` disappears on `/children` while `/home` shows
one, and `MorePageClient`'s unlink flow (`child.schoolId === link.id`,
`MorePageClient.tsx:60`) fails to clear the selected child it is about to delete. It
also contradicts `docs/api-contract.md:66`, which lists these as the per-child school
fields.

**DoD**
- [x] `/children` resolves school fields through the same helper the feed uses, so the
      two endpoints cannot disagree. All four fields come from
      `buildStudentSchoolMap`, whose `StudentSchool` already carries every one of
      them; the private `resolveSchoolLabels` is deleted. `docs/api-contract.md` gains
      one sentence saying `schoolId` is always one of the caller's own connections.
- [x] A test asserts the same child's `schoolId` and `schoolShortLabel` match across
      `/children`, `/dashboard` and `/feed`, with `schoolName` and `semel` non-null —
      where the id was foreign and the three labels were all `null`.
- [x] The label-set inconsistency in **Minors** is fixed in the same batch, in the
      commit after this one: new `common/school-chips.ts` resolves the labels once over
      the caller's whole active connection set, and `buildStudentSchoolMap`,
      `/children` through it, and `MailService.getConversations` all read from it.
      Fixing R6 alone would have made the three readers agree on the *narrower*
      answer, which is why the two were one batch.

### R7 — The add-school form can submit a school the input is no longer showing

**Severity**: medium. A parent gets a credentials error naming a school they did not
choose.

**Cause.** `frontend/src/app/more/schools/new/AddSchoolPageClient.tsx:106` renders
`SchoolAutocomplete` without `onClear`. Its own prop doc says the prop exists because
"editing the text after picking a school would leave the selection in place and submit
a school the input is no longer showing"; the mismatch branch at
`SchoolAutocomplete.tsx:174` calls `onClear?.()`, a no-op here. `SignInPageClient`
passes it; this page does not.

**Description.** Select a school, then edit the text: the input shows the typed text
while `selectedSchool` still holds the old school, so `POST /school-links` goes out
with the wrong `semel` and fails `INVALID_CREDENTIALS` against a school the parent
never picked — the one error message in the table that will read as a lie.

**DoD**
- [ ] `AddSchoolPageClient` passes `onClear`.
- [ ] `tests/e2e/school-links.spec.ts` covers select-then-edit: the submit button is
      disabled, or the request carries the typed school.

### R8 — A returning sign-in takes the adoption branch, so `displayName` never updates

**Severity**: medium. A wrong name served indefinitely.

**Cause.** `backend/src/auth/auth.service.ts:234` — the adoption branch triggers on
`existingConnBeforeLogin?.userId` being set, which is true for **every** returning
sign-in, not just a cross-school one. It returns before the `appUser.upsert` at `:262`,
whose `update: { username, displayName }` is the only place `AppUser.displayName` is
refreshed from `credential.displayName`.

**Description.** After the very first login, a parent's display name is frozen.
`GET /auth/me` serves the original one forever, including after the school corrects it.

**DoD**
- [ ] The branch is gated on `existingConnBeforeLogin.userId !== (the AppUser for this
      `mashovUserId`)`, or the upsert moves before the early return.
- [ ] `auth.service.spec.ts` asserts a second sign-in by the same single-school parent
      refreshes `displayName`, and that a genuine cross-school adoption still does not
      create a second `AppUser`.

### R9 — `PUT /school-links/:id` 500s on the unique index this branch added

**Severity**: medium.

**Cause.** `backend/src/connection/connection.service.ts:167` — `updateConnection`
writes `username: newUsername` with no handling for
`@@unique([schoolCode, username])`, which this branch introduced.

**Description.** A `username` that already exists at that school — the other parent's
account, or an orphan row left by an earlier unlink — raises Prisma `P2002` out of an
unguarded `update`, so the request 500s instead of returning the
`409 / CONNECTION_ALREADY_LINKED` envelope `.claude/rules/api.md` requires. Before the
index it silently succeeded.

**DoD**
- [ ] `P2002` on that index maps to `409 CONNECTION_ALREADY_LINKED`.
- [ ] A test asserts the 409 envelope rather than a 500.

### R10 — The link rate limit answers 409 where the rules say 429

**Severity**: low.

**Cause.** `backend/src/school-links/school-links.service.ts:439` — `checkRateLimit`
throws `ConflictException` for `RATE_LIMITED`. `.claude/rules/api.md` specifies 429,
and `AuthService.checkRateLimit` already uses `statusCode: 429`.

**Description.** The frontend maps the `code`, not the status, so the Hebrew message is
right. But any client keying off the status — or a proxy retry policy — sees a conflict
rather than a throttle.

**DoD**
- [ ] 429, with the `RATE_LIMITED` code unchanged.
- [ ] A test pins the status.

### R11 — A targeted refresh of an inactive connection reports a clean sync and no run

**Severity**: low, but it is a silent success that makes a real failure undiagnosable.

**Cause.** `backend/src/sync/tasks/achvas.task.ts:75` (identically
`notifications.task.ts:70`, `user-details.task.ts:59`, `mail-counts.task.ts`):
`useSharedSession` is `!context.connectionId && <no connections>`, so it is `false`
when `context.connectionId` is set — but `connectionList` / `targets` is then `[]` if
that connection is inactive or has `userId: null`.

**Description.** The loop body never runs: no `syncRun` is opened, nothing is fetched,
and the task returns `status: 'success'` with every count zero. A targeted refresh of a
just-deactivated connection therefore reports a clean sync and leaves no trace in
`sync_run`. The pre-branch code fell through to the shared env session and opened a run
either way.

**DoD**
- [ ] An empty target list on a connection-scoped run is reported, not silently
      successful — a `skipped` status or a `sync_run` recording why.
- [ ] A test covers a targeted refresh of a deactivated connection.

### R12 — `POST /sync/refresh` returns only the first school's envelope

**Severity**: medium. A failed school reported to the parent as a clean sync.

**Cause.** `backend/src/sync/sync.controller.ts:126` runs one `refreshAll` per
connection, then returns `{ ...results[0], schools }`. Every legacy field — `status`,
`tasks`, `tasksFailed`, the counts — describes the **first** connection only.

**Description.** For a two-school household where A succeeds and B fails outright, the
endpoint answers `status: 'success'` with A's task list, and `/more`'s refresh button
reports a clean sync. `GET /sync/status` already aggregates correctly with `PHASE_RANK`.

Note the interaction with the **Minors** entry about a connection-scoped refresh
fanning out over every child: that one makes a *successful* school report `partial`,
this one makes a *failed* school report `success`. Fixing R12 alone would make the
first more visible, so do them together.

**DoD**
- [ ] `status` is `'partial'` if any result is, and the counts are summed.
- [ ] `sync.controller.spec.ts` covers one-of-two-failing.

### Two sub-findings too small for an item of their own

- `frontend/src/components/.../MorePageClient.tsx:42` —
  `isLastSchool = (pendingUnlink && schoolCount <= 1) || schoolCount <= 1` reduces to
  `schoolCount <= 1`, and since the per-row modal only opens when
  `schoolLinks.length > 1` the `pendingUnlink` term is dead.
- ~~`MailService.updateCachedNewCount()` called with **no argument** iterates every
  active connection in the database, writing to other households' rows on each of the
  caller's mail actions. The values it writes are per-connection and correct, so this
  is write amplification and a cross-tenant write, not wrong data. Natural to fix
  inside R1.~~ **Done** — the parameter is now required and each mutation passes the
  distinct stamps of the rows it touched.

---

## Bugs the third review found (2026-11-19)

`/code-review high` over `master...HEAD`, run after **R2** and its minors landed. Nine
items; six were already recorded here (**R3** twice, **R6**, **R7**, **R8**, **B2**),
one sharpened **B3**'s stated bound (recorded there), and the two below are new. The
review also checked the **R2** unlink work specifically — delete ordering, the
relation-filtered message delete, both exclusion sets, FK safety — and found it sound.

### R13 — The dashboard badge falls back to the global unread count

**Severity**: low. Narrow trigger, but it is another household's number on the screen.

**Cause.** `backend/src/dashboard/dashboard.service.ts:116` — `localNewConversations`
counts `mailConversation` with `isUnread: true` and no household predicate at all.
`MailService.getSummary:97` is the same shape and *was* fixed in batch 1, where it
spreads `ownScope`; this second copy was missed. The value is used at `:156`, and only
when `household._count._all === 0`.

**Description.** A signed-in user with no active connection — between unlinking and
re-linking, or mid-onboarding — gets every other household's unread conversations as
their own badge count. The `_count._all === 0` guard is what keeps it narrow: a user
with a connection reads the summed `cachedNewCount` instead and never reaches this
branch.

**DoD**
- [x] The count takes the same `householdMailScope` as `MailService.getSummary` —
      literally the same function now, from `common/mail-scope.ts`.
- [x] A test with two households asserts the no-connection user's badge is 0, not the
      other household's count, that it still counts an unattributed conversation (so
      the fix is a real scope rather than a hardcoded zero), and that each parent with
      a connection still reads their own `cachedNewCount`.

### N1 — The deprecated school card reads every household in the database

**Severity**: low. Narrow, deprecated field, but another household's name on the screen.

Found while reading for batch 3, and fixed in it.

**Cause.** `backend/src/dashboard/dashboard.service.ts` — `getSchoolInfo()` read
`householdConnection.findFirst({ where: { active: true } })` with no `userId`, ordered
by `lastLoginAt` desc.

**Description.** A single-school parent could be shown whichever household had logged
in most recently: another household's `schoolName` and `schoolYear` in
`DashboardResponse.school`. The field is deprecated and due for deletion in **T14**,
but it was a cross-household read on the screen today, so it was not left for then.

**DoD**
- [x] `getSchoolInfo` takes the caller, keeping the caller-less path as it was.
- [x] A test with a second household at a differently named school, made the most
      recent login, asserts the caller sees their own school.

### R14 — Filtering the inbox by school can make that school's mail unreachable

**Severity**: medium. The parent is shown an empty mailbox and has no way forward.

**Cause.** `frontend/src/app/inbox/InboxPageClient.tsx:82-88` filters `allConversations`
by school **client-side**, over a `useInfiniteQuery` of 20 rows per page
(`useMail.ts:26`). `GET /mail/conversations` has accepted `?schoolId=` since this
branch, and `fetchConversations` never sends it. The empty branch at `:315` renders
`EmptyState` *instead of* `ConversationList`, which is what carries `hasMore` and the
load-more control.

**Description.** If page 1 holds only school A's conversations, selecting school B
renders "תיבת הדואר ריקה" — the mailbox-is-empty copy, which does not mention the
filter — with no way to load page 2. School B's mail is not merely unfiltered, it is
unreachable without clearing the chip. The pagination counts shown elsewhere are
computed on the unfiltered totals too.

**DoD**
- [ ] The school chip is a server-side filter: `fetchConversations` passes `schoolId`
      and the query key includes it, so pagination and counts are over the filtered
      set. (**R1** already made `?schoolId=` 404 on a foreign connection, so the
      param is safe to send.)
- [ ] The empty state distinguishes "no mail at all" from "no mail at this school",
      and keeps a way to load more or clear the filter.
- [ ] An e2e case selects a school whose mail is not on page 1 and asserts it appears.

---

## Operational tasks the plan deferred

### T13 — Link the second school against the real stack

Step 13 of the plan. Needs real second-school Mashov credentials and a full cron
cycle, so it cannot be done unattended.

**Gate before starting**: `SELECT count(*) FROM student WHERE "householdConnectionId"
IS NULL` must be `0` after a full cron cycle. Until it is, the mail sweep's
shared-session gate and the ownership backfill both behave differently, and **B1**'s
collision is harder to distinguish from a stamping lag.

**DoD** — all of the plan's own verification list:
- [ ] `/children` lists children from both schools, each with its school chip, and the
      chip row appears only now that there are two.
- [ ] The inbox badge equals the **sum** of both schools' Mashov `unreadConversations`
      — the metric `283c053` was measured on, so a regression shows here first.
- [ ] The mail task logs `swept=N` per connection rather than "sweep skipped".
- [ ] `SELECT "householdConnectionId", count(*) FROM mail_conversation GROUP BY 1`
      shows both connections.
- [ ] A behaviour event at school B shows school B's Hebrew label and its own
      `justifiable`.
- [ ] `?school=<semel>` filters, deep-links, and an unknown value shows everything.
- [ ] Unlinking school B leaves A's children, mail and read state intact, and does not
      sign the parent out.
- [ ] Signing out and back in with **either** school's credentials lands on the same
      merged household.

### T14 — Cleanup and the PRD

Step 14. The ADRs (0029, 0030) and `docs/api-contract.md` are **done**. What remains:

- [ ] Drop `me.connectedSchool` and `DashboardResponse.school`, both marked deprecated
      "for one release".
- [ ] Delete `backend/src/connection/connection.controller.ts` and
      `frontend/src/api/connection.ts`, whose `PUT`/`DELETE /connection` are
      documented aliases over the same service methods as `/school-links`.
- [ ] Update the PRD's Phase 2 multi-tenancy claim and open question 2 **via the
      `/prd` skill** — `.claude/rules/prd.md` forbids editing `PRD-current.md` by
      hand. Question 2's answer is now partly wrong: it says "each user creates their
      own connection", which **B1** breaks.
- [ ] Add `MAIL_SWEEP_ENABLED` and `MASHOV_ENABLE_SCHOOL_LINK_ADOPTION` to
      `.env.example`. Both are in `README.md` and `docker-compose.yml`; `.env.example`
      was unreachable in the implementing session. Both default to on, so nothing
      breaks without them.

---

## Test infrastructure

### G1 — There is no two-user fixture, and that is why the review found what it found

**Cause.** Every test on the branch exercises one `AppUser`. 1014 unit tests and 157
e2e passed while nine routes had no ownership guard at all, because nothing asserted
the *general* property — the isolation specs named `getChildren` and
`getChildWorkspace` individually.

**Status: DONE.** Started by `1dcb60e`, which needed the two-user fixture to prove
**B1**, and finished by the route-enumeration suite, the unattributed-mail fixture,
the unlinked child's rows and the two-sync cross-contamination test. Four findings
came out of the work rather than out of review; they are the Minors below.

**DoD**
- [x] An integration fixture with **two `AppUser`s**, each with its own connection, in
      `tests/integration/household-isolation.test.ts`: two users, two connections at one
      school, four children (one each, one shared by both, one nobody lists).
- [x] A fixture with a child **no connection lists** — the successor to
      `householdConnectionId: null`, and the case `canSeeStudent` has to admit.
- [x] That child carrying **current-year rows**, which is what C2 needed. The
      `household-isolation` fixture now gives the unlinked child a current-year homework
      row and a pre-migration (`schoolYear = 0`) one, and four cases assert both halves
      of the shape together: the child is in the list **and** their rows are in
      `yearScopeForStudents`, the per-child fallback year lands on a year their rows were
      written at, `historyScopeForStudents` admits them so the archive is not empty
      either, and the other parent is admitted on the same terms. Asserting the two
      halves in one case is deliberate — a scope admitting nothing still satisfies "the
      child is visible", and one admitting everything still satisfies "the rows are
      there". Verified red by deleting the unstamped branch from `yearScopeForStudents`.
      The "every year the household is on" half needs ONE user with two schools, which
      that fixture is not, so it lives in `tests/integration/two-school-sync.test.ts`
      together with the per-child consequence recorded as a Minor below.
- [x] A fixture with a `mail_conversation` at `householdConnectionId: null` that
      upstream no longer returns — the shape the sweep exists for.
      `tests/integration/mail-sweep-unattributed.test.ts`, **5 cases** against real
      Postgres: a live conversation, a stale orphan stamped to each of two
      connections, an unattributed stale orphan, and an unattributed one the parent
      marked unread by hand. What it establishes is that the unattributed orphan is
      **permanently unread on any deployment that has stamped mail at all** — a
      connection-scoped run cannot match it (no value equals SQL NULL, which is
      three-valued logic rather than a decision of the task's), the shared-session
      run that does own it is gated off while stamped rows exist, and no walk can
      ever re-stamp it because re-stamping happens in an upsert's `update` branch
      and upstream has stopped returning it. The sweep clears it only on a
      no-stamped-mail deployment, which that case covers, and leaves
      `locallyMarkedUnreadAt` alone there. Verified red by dropping
      `householdConnectionId` from the sweep's `where`: three of the five failed,
      including the other connection's orphan being cleared. The consequence a
      parent sees is recorded as a Minor below.
- [x] A test that enumerates the `children.controller.ts` routes taking a
      `studentGuid` and asserts each 404s for a foreign child, so route ten cannot
      ship unguarded — `tests/integration/children-route-guard.test.ts`, **25 routes,
      51 cases**. The list is read out of Nest's own `PATH_METADATA`, so a new
      `:studentGuid` route joins the suite the moment it is written; the counts are
      cross-checked against the controller source, so a metadata read that ever
      returns a partial list fails the suite instead of silently covering nothing.
      Each route is called twice against real Postgres — as the other parent, which
      must raise exactly `Student not found: <guid>`, and as the child's own parent,
      which must not, so the suite cannot be satisfied by a service that 404s
      unconditionally. Verified red by removing `requireStudent` from `getTimetable`:
      one case failed with "resolved without raising", the other 50 stayed green.
      `digest.controller.ts` also takes a `studentGuid`, but in a query or body and
      under ADR-0026's own rule — deliberately out of scope.
- [x] The cross-contamination test the plan asked for —
      `tests/integration/two-school-sync.test.ts`, **16 cases**. One household, two
      schools **on different years** (2027 and 2026), two children, two mailboxes, then
      `SyncService.refreshAll` per connection: the wired `SyncModule`, all sixteen tasks,
      real Postgres, real Redis. Only the two transports are fakes — `MashovHttpClient`
      and the private axios instance `MashovSessionService` logs in with, patched so the
      roster is persisted by the real `persistRoster`, which is the code that stamps the
      child and writes the link; stubbing `refreshRosterForConnection` would have skipped
      exactly what B1 was about. The fake upstream answers **403** for a child outside the
      asking account, as Mashov does. Asserted: each child stays stamped, linked and
      active through the other school's refresh; every mail row and message carries the
      mailbox it came from; each run sweeps only its own stale conversation; each
      connection's `cachedNewCount` is its own and the household badge is their **sum**;
      `mail_counts` records its own mailbox's `localCount`, not the union; each child's
      homework is labelled with its own school's year; and the three per-school keys two
      schools would collide on hold — `(householdConnectionId, upstreamNotificationId)`,
      `(schoolCode, code)` for the achva taxonomy that answers "is this absence
      justifiable?", and one `parent_profile` per school. The env-credential session is
      fenced: the fake's shared `get` throws, and nothing reached it. Verified red three
      ways: removing the presence sweep's "every connection must have refreshed" guard
      (B's child deactivated by A's refresh, 3 cases), unscoping `mail_counts`'
      `localUnreadCount` (the union, 1 case), and deleting the unstamped branch from
      `yearScopeForStudents` (1 case). The two refreshes run twice in the steady-state
      group on purpose: `mail_counts` and `mail_inbox` run in one `Promise.all`, so on a
      first pass the count is taken either side of that mailbox's sweep, and the exact
      form of the assertion was flaky until the second pass removed the race.

---

## Minors

- **Either household may mutate an unattributed conversation, and the other sees the
  write.** Batch 1 admits `householdConnectionId: null` on a mail *mutation* for the
  same reason every read on this branch admits it — NULL means "ownership unknown", and
  refusing it would make a row the parent can see and cannot act on. The consequence
  the read case does not have: on a box with more than one active connection, where the
  ownership backfill refused and unstamped rows therefore exist, A archiving an
  unattributed row clears it from B's inbox too, and `markUnread` writes a
  `locallyMarkedUnreadAt` the sweep then honours. Upstream stays safe — the call goes
  out under the acting household's own account. A live row is stamped by the next walk
  within seven minutes, so the window is a row upstream has stopped returning, the same
  shape as the entry below. Narrowing it means admitting NULL on a mutation only while
  the database holds at most one active connection; recorded rather than done, because
  it is the branch-wide NULL rule and not a mail decision. Stated in `canSee`'s comment
  in `backend/src/mail/mail.service.ts`.
- **A `?schoolId=` view excludes unattributed conversations.** The household scope's
  `OR [own, null]` ANDed with `{ householdConnectionId: schoolId }` can match no NULL
  row, so an unattributed conversation is in the unfiltered list and in no per-school
  one. Same family as the entry below. No frontend caller is affected —
  `InboxPageClient` filters by school client-side and never sends `schoolId` — so it is
  API-surface only. Pinned as current behaviour in
  `tests/integration/household-isolation.test.ts`. **Correction (third review):** that
  client-side filter has a consequence of its own, recorded as **R14** — it can make a
  school's mail unreachable rather than merely unfiltered. Sending `schoolId` is part of
  R14's fix, so the exclusion above stops being API-surface-only at that point and the
  two have to be resolved together.
- **Opening a conversation can leave one connection's `cachedNewCount` stale for up to
  five minutes.** Hydrating on open recomputes `isUnread` and no count, which is
  pre-existing; what changed in batch 1 is that the user's next mail action elsewhere
  no longer repairs it, because the refresh now writes only the connections that action
  touched. `MailCountsTask` settles it within five minutes. The fix is one call to
  `updateCachedNewCount` with the hydrated conversation's stamp.
- An **unattributed unread conversation is in no badge and in every list.** Each
  `cachedNewCount` is scoped to its own connection and the badge sums those rows,
  so a `mail_conversation` at `householdConnectionId: null` is counted nowhere —
  while `MailService.householdMailScope` admits NULL as "ownership unknown", so the
  same `/mail/summary` response lists it as unread. Asserted as current behaviour in
  `tests/integration/mail-sweep-unattributed.test.ts`. It is only reachable for a row
  upstream has stopped returning (a live one gets stamped on the next walk), and the
  sweep cannot clear it for the reasons in G1, so the honest fixes are either to count
  NULL rows into the shared-session row's `cachedNewCount` or to stop admitting them
  into the read scope once the backfill is known to have run. Not urgent — it needs a
  pre-ownership row that outlived its upstream — but it is a badge that disagrees with
  the list on the same screen, which is the class of bug `283c053` was about.
- **A connection-scoped refresh fans out over every child in the database.** Each
  per-student task reads `student.findMany({ where: { isActive: true } })` — not the
  refreshing connection's children — so `POST /sync/refresh` for school A asks A's
  account for school B's children and collects a 403 for each, across seven
  per-student tasks. Nothing wrong is written, but the refresh of a school that worked
  perfectly reports **`partial`**, which is what `/auth/syncing` shows the parent, and
  each foreign child leaves a failed `sync_run` that `FreshnessService` then reads as
  source ill-health. Asserted as current behaviour in
  `tests/integration/two-school-sync.test.ts`. The fix is one `where` per task:
  restrict the student list to the children the refreshing connection lists
  (`visibleStudentWhere`-style, via `student_connection`), which also removes the
  wasted upstream calls the owner-first ordering was added to avoid.
- **An unlinked child's per-child reads resolve to one year, while the list admits
  every year.** `yearScopeForStudents` gives a child with no links every year the
  household is on, because nothing records which school wrote their rows — but
  `currentSchoolYearForStudent` falls back to the household's highest year, so in a
  household spanning 2027 and 2026 the rows written at 2026 are in the cross-child list
  and absent from the child's own workspace. The same "card there, workspace empty"
  shape the cross-child scope was fixed for, surviving in the per-child path. Asserted
  in `tests/integration/two-school-sync.test.ts`. Only reachable while a child is
  unlinked, which the backfill leaves them on a two-connection database until the next
  roster refresh; the honest fix is for the per-child reads to accept the household's
  year set for an unlinked child rather than one year.
- `behavior-classifier.service.ts` — bare `catch { return false }` turns any DB error
  into "this absence is not justifiable". The default is defensible; swallowing the
  error unlogged is not.
- `children.service.ts` `getLessonPlans` / `getLessonHistory` — `catch { return {
  data: [] } }` with no log, so a 403 from a wrong-target resolution (**B3**) is
  indistinguishable from a school that has no lesson plans.
- ~~Label-set inconsistency: `ChildrenService.resolveSchoolLabels` resolves over the
  household's whole connection set, `common/student-school-map.ts` only over the
  connections present in the list. Two schools whose short labels collide therefore
  show the collision-expanded full name on `/children` and the short colliding label
  on a page listing only one of them.~~ **Fixed in batch 3**, with **R6** — it was the
  same seam, and there was a third reader with it (`MailService.getConversations`,
  which resolved over the connections present in the page). All three now read
  `common/school-chips.ts`, which resolves the labels once over the caller's whole
  active connection set. `common/school-label.ts` stays pure.
- The e2e suite is flaky under full parallel load on a dev machine: two full runs
  during batch 3 failed 3 and then 4 tests, a *different* set each time, all of them
  `expect(locator).toBeVisible` timeouts on a page that had not finished rendering.
  Every one of them passes when its own spec file runs alone, and batch 3 touched no
  frontend code. Worth knowing before reading a local red as a regression; unmeasured
  whether CI's runners show it too.
- `npm run test:integration` was collecting the *other git worktrees'* copies of
  `tests/integration/**` — `.worktrees/feat-attachment-viewer` is on an older commit,
  so five of its suites failed to run and the gate was red for reasons that had
  nothing to do with this branch. Fixed in passing: the compose command now passes
  `--testPathIgnorePatterns=worktrees/`. Worth knowing because it was invisible
  until a worktree went stale, and `npm run test:unit` runs from `backend/` so it
  was never affected.
- `sync-run.service.ts` — the docstring justifying why a scoped source-health read
  keeps `householdConnectionId IS NULL` rows says "every `@Cron` entrypoint calls
  `execute()` with no context". That is no longer true for `mail_inbox` and
  `mail_counts`, which pass `conn.id`. The behaviour is still right; the stated
  reason is stale.
- `POST /sync/refresh` runs up to four `refreshAll` dispatches **sequentially**
  (concurrency 1, deliberately). Worth confirming against the 15 s proxy budget that
  `getSourceHealth` has already blown once; `PROXY_SLOW_TIMEOUT_MS` is 90 s for
  `/sync/*`, so it is probably fine, but it is unmeasured.
- `frontend/src/api/client.ts` skips the sign-in redirect for a 401 whose body code is
  `INVALID_CREDENTIALS`, so that the add-school form can report a wrong *school*
  password inline. It means any endpoint that ever answers 401 with that code stops
  redirecting on a genuinely expired session. A comment on
  `MashovCredentialValidatorService` noting the code is load-bearing for the
  frontend's 401 handling would keep the two from drifting.
- ~~`docker-compose.yml` hardcodes `5432:5432` for `db`, so `npm run test:e2e` cannot
  start on a machine with anything else on that port. Parameterising the host port
  (`${DB_PORT:-5432}:5432`) costs nothing; the e2e containers reach the db over the
  compose network and do not need the publish at all.~~ **Done** — `${DB_PORT:-5432}:5432`,
  documented in `README.md` and `.env.example`. `DB_PORT=5433 npm run test:integration`
  is what the integration gate for batch 1 was run with, and `DB_PORT=5433 npm run
  test:e2e` the e2e suite (171 tests).
- `tests/e2e/school-links.spec.ts:389` ("a successful link goes to the syncing screen
  for that school") is **flaky**: it failed once on `syncing-heading` not being found
  after `waitForURL` had already succeeded, then passed on an identical re-run. The page
  renders the heading behind its first `['sync-status']` fetch, so the assertion is
  racing that. Needs a `waitFor` on the page's loaded state rather than a bare
  `toHaveText`.
- The integration suite was **red on this branch** until `1dcb60e` and nobody noticed,
  because the branch's verification ran unit + e2e only. Three independent causes, all
  now fixed: `ChildrenService` had gained a sixth constructor argument;
  `@@unique([schoolCode, username])` made the duplicate-connection fixture impossible to
  INSERT (it now drops the index for the duration of the test, which is honest — the
  duplicates it covers were written before the index existed); and six `api.test.ts`
  cases still mocked the env-session `get`/`put` that the household work moved off.
  Worth adding `npm run test:integration` to whatever gate runs before a merge.
- The test services' `ENCRYPTION_KEY` in `docker-compose.yml` was
  `test-encryption-key-32-chars-long!`, which is not hex, so `EncryptionService` threw
  on every call. Nothing had noticed because nothing in the integration tests decrypted
  a stored password until one needed a real `ConnectionTarget`. Now a valid 64-hex key.
- `SessionModule` (`backend/src/session/session.module.ts`) is dead and not
  instantiable — it declares `MashovHttpClient`, whose only constructor argument is
  `MashovSessionService`, which that module neither provides nor imports. Nothing
  imports it and nothing injects `SessionService`. It now carries a comment saying so;
  deleting it is the actual fix.
- Found while fixing **R2**, all in `ConnectionService.deleteOneConnection`, and
  **all four now fixed** in `c82ebc1` and `2bfd7de` rather than deferred. What they
  were, and what the fix was:
  - `conversationIds` was read OUTSIDE the `$transaction`, so a conversation created
    between the read and the delete would be deleted while a NULL-stamped message
    under it was not. Traced before fixing: that needed the shared-session mail walk,
    which runs only when the household has no active connection, so the worst case was
    one retriable 500 rather than R2's permanent one, with no orphan and no partial
    state.
  - That `in` list was unbounded, and `mail-inbox.task.ts` never deletes a mail row,
    so it only grew. Past roughly 65k conversations in one household the `DELETE …
    WHERE conversationId IN (…)` exceeds Postgres's 16-bit bind-parameter limit and
    the unlink breaks permanently — R2's exact failure class at a higher threshold.
    Both are gone: the predicate is now the relation filter
    `conversation: { householdConnectionId: connection.id }`, which is one statement,
    evaluated inside the transaction, with no id list. Verified red against real
    Postgres by deleting that arm — the NULL-stamped case failed again on
    `mail_message_conversationId_fkey`, the other 278 stayed green.
  - `mail_message."conversationId"` had no index (`schema.prisma` declared only
    `@@index([householdConnectionId])`, and Postgres does not index a foreign key's
    referencing column), so both the delete arm and the FK check behind
    `mailConversation.deleteMany` sequential-scanned `mail_message` under lock, as did
    every conversation open. Now `@@index([conversationId])` plus
    `20261123000000_mail_message_conversation_index`, written `IF NOT EXISTS` so it
    survives the `prisma db push` boot.
  - `deleteConnection` looped `deleteOneConnection` with one `$transaction` each, so a
    failure on the second school left the first unlinked and still returned a 500 —
    the parent pressed "disconnect all", saw an error, and could not tell that half of
    it had happened. Now one transaction for every school, with sessions evicted after
    the commit. That required widening both exclusion sets from "every connection but
    this one" to "every connection in this unlink": the sequential loop was only
    correct because the earlier school's rows were already deleted by the time it
    read, and read up front, a child both unlinked schools list would have looked
    shared to each and survived as an orphan with `isActive: true`. Two unit cases pin
    each exclusion set; six were red before the change.
- Also found fixing **R2**: a conversation that is unattributed (`householdConnectionId
  IS NULL`) and whose messages are therefore written NULL-stamped too survives every
  unlink, both rows, and stays visible to every household. Deliberate — keeping the
  message stamp equal to the conversation's is the invariant the unlink rests on, and
  the sync walk re-stamps such rows while upstream still returns them — but it means
  the only thing that ever clears them is `mail-sweep-unattributed`, under the
  conditions **G1** records. Left as it is deliberately, and the only one of the
  review's minors not folded in: the alternative is for one household's unlink to
  delete a conversation every other household can still see, which is worse than
  leaving it.
