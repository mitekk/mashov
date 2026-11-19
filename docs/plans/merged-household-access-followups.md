# Follow-ups from the merged-household-access branch

Everything deferred from `feat/merged-household-access` (`8c0939f..HEAD`), which
implemented steps 1–12 of [the plan](merged-household-access.md). See
[ADR-0029](../adr/0029-household-merge-and-login-adoption.md) and
[ADR-0030](../adr/0030-per-connection-data-scoping.md) for the decisions it rests on.

Two whole-branch reviews have run. The first graded nine items Critical or Important;
eight were fixed on the branch, and **B1** was fixed afterwards in `1dcb60e`. The
second (`/code-review high`, 2026-11-19, after **G1** landed) found twelve more, all
recorded here as **R1–R12**.

What is open: **B2** and **B4**, the two operational tasks the plan itself deferred
(**T13**–**T14**), the **G2** coverage gap, and the minors. Every **R** item is done —
**R1**–**R17** — along with **G1**, **B1**, **B3** and N1, all kept as record. With batch 6 closed, the refresh envelope's
`status` means what it says: `partial` exactly when something in the household
actually failed, rather than `success` for a school that threw and `partial` for one
that synced perfectly.

A third review (`/code-review high`, 2026-11-19) ran after **R2** landed. It added
**R13** and **R14** below and sharpened **B3**; everything else it found was already
recorded here. **R1**, **R2**, B3's attachment leak and batch 3 (**R3**, **R5**,
**R6**, **R13**, **N1** and the label-set minor) are done, so **no cross-household
*read* is open any more**.

A fourth review (`/code-review high`, 2026-11-19, run after batch 3 landed) added
**R15–R17**. One of them mattered more than its number suggested: **R16** was a
cross-household *write*, and the reachable path B3's remaining bullet said did not
exist. It is **done** (batch 3.5, `3afde47`), and with it **no cross-household read or
write is open any more** — every remaining item is a degraded signal, a frontend gap or
a pre-existing bug. That sentence has been wrong once already, in the form "no
cross-household read is open": it bounded reads and said nothing about writes. It is
now a claim about both, and the thing that would falsify it is a resolver reached by a
path whose own check is the only thing scoping it.

## Pick-up order

Each batch is one session's work and leaves the tree green on its own. Within a batch
the items share a seam, so splitting them costs more than doing them together.
**Status is the per-item DoD boxes, not a guess** — tick them as you go and this table
stays true.

| # | Items | Status | Why here |
|---|---|---|---|
| 1 | **R1** + **B3** + `updateCachedNewCount()` | **done** | The only finding where one household wrote another's data upstream with their credentials. Included the stamped-branch attachment leak the third review found. B3's last bullet — the stamped branch of `resolveOrFallback` generally — was recorded as having no known reachable path; the fourth review found one, and it closed as **R16** in batch 3.5. |
| 2 | **R2** | **done** | A permanently broken unlink. Fixed with the stamp, the relation-filtered delete, one transaction for the whole unlink, and an index on `mail_message.conversationId`. |
| 3 | **R3**, **R5**, **R6**, **R13** + the label-set minor, and **N1** found while reading | **done** | One missing household predicate across four readers, on the `userId` threading batch 1 established. Closed the last place another household's data reached a screen. The mail scope moved to `common/mail-scope.ts` and the chip labels to `common/school-chips.ts`, so `/children`, `/dashboard`, `/feed` and the inbox now answer from one scoping path and one label resolution instead of four. |
| 3.5 | **R16** + B3's remaining bullet | **done** | One household's release request went upstream under the other's decrypted password — R1's class, not a cleanup. One fix in the stamped branch of `resolveOrFallback` closed both: a foreign stamp is now no stamp, and the fallback under it prefers the caller's connection at the stamped school. `targetFor` took the same optional caller while in there. |
| 4 | **R4** + **R15** | **done** | Same visibility-edge fix as batch 3, in a service with no callers in common. R15 rode along: the same "the writers and the reader disagree about NULL" shape, in the mail counts rather than the freshness read. The freshness card now takes the caller and selects children by the visibility edge; the badge is the caller's `cachedNewCount` sum plus the unattributed rows, added once by `unreadBadge` in `common/mail-scope.ts` — one rule, one home, for the two readers that each had their own copy of it. |
| 5 | **R7**, **R14** + the `MorePageClient` dead term | **done** | The only frontend items. R14 left a parent looking at an empty mailbox with no way forward, which was the worst *experience* open. The chip is now a server-side `?schoolId=` filter — which admits the unattributed rows, so the list follows the same NULL rule as batch 4's badge — the add-school form clears and re-gates on an edited selection, and the bulk-disconnect modal defaults to the plural copy instead of promising a one-school wipe. |
| 6 | **R12** + **R11** + the "connection-scoped refresh fans out over every child" minor | **done** | All three were the refresh envelope lying to the parent — R12 said `success` when a school failed, the minor said `partial` when one succeeded. Closed together, because fixing either alone only makes the others more visible. Three helpers now carry it: `studentScopeForContext` scopes every per-student task to the refreshing connection's children, `reportNoConnectionTarget` opens and fails a run for a connection-scoped refresh with no usable target, and the controller aggregates the envelope worst-wins over `PHASE_RANK`. R11's hole turned out to be in seven tasks, not the four recorded — six connection-loop tasks plus `releases`, the one per-student task missing the `every connection failed` guard. |
| 7 | **R8**, **R9**, **R10**, **R17** | **done** | Four independent small correctness fixes in the auth/link path — each a branch or a status that meant something other than what it said. R17 turned out not to be a two-line reorder: the orphan lookup it would have moved is a cross-household existence oracle, so `assertLinkable` split into a free pre-limit half and a rate-limited one. R10's recorded precedent was wrong and the fix follows `auth.controller`'s envelope rather than the service's bare `Error`. |
| 8 | **B2**, **B4** | open | Pre-existing bugs with no dependency on the above. |
| 8.5 | **G2** | open | A coverage gap, not a behaviour one: the school preference `3afde47` added is proved against the unit spec's in-memory Prisma and not against real Postgres. Needs a two-school seed with its own cleanup, which is why it was not bolted onto batch 3.5. Cheap, and parallel with anything. |
| 9 | **T13**, then **T14** | open | T13 needs real second-school credentials and a full cron cycle; T14 closes the branch out. `.env.example` is reachable again as of the `DB_PORT` commit, so T14's last bullet is no longer blocked. |

Batches 1 through 7 are done: no open item puts one household's data on another's
*screen*, none puts a household's *request* in another's Mashov account, no reader left
answers from the whole table, no frontend item is open, the refresh envelope no longer
misreports what happened, and no status or branch in the auth/link path answers
something other than what it says. **Batch 8 is next** — two pre-existing bugs with no
dependency on anything above. **8.5** (**G2**) is parallel with it.

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

**Status: FIXED** in `885738a` (the `userId` threading, batch 1), `674ff50` (the
attachment leak) and `3afde47` (the stamped branch, with **R16**).

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
- [x] The stamped branch of `resolveOrFallback` ignored `userId`, so
      `targetForStudent` and `targetForConversation` could resolve a foreign stamp
      when their callers' own ownership checks did not bound it. Fixed in `3afde47`
      with **R16**: "stamped outside the caller's connections" is now unstamped, and
      the `userId`-scoped fallback under it prefers the caller's connection at the
      stamped school.
      **This bullet used to say no path like the attachment one was known to remain**,
      on the reasoning that `assertVisible` bounds the conversation callers and a
      shared child's stamp is the other parent's by design (ADR-0031), so it was
      R4/R6's territory rather than a leak. That reasoning held only for *reads*. The
      fourth review found the writes: see **R16**. The shared-child stamp is by design,
      but sending a parent's request upstream under it is not.

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
- [x] The student predicate uses the visibility edge (`connectionStudentWhere`), and
      the aggregation is per household (`userId` threaded in).
      `contentFreshnessForConnection` takes the predicate as an argument rather than
      building it from the stamp, so the two call sites say which question they are
      asking: `connectionStudentWhere(connection.id)` per connection, and
      `visibleStudentWhere` for a signed-in caller with no active connection — that
      branch aggregated the whole table too. `computeFreshness(userId?, snapshot?)`
      takes the caller FIRST, which leaves every no-arg spec call untouched;
      `DashboardService.getFreshness` and `SettingsService.getSourceHealth` pass it,
      the latter keeping its per-connection snapshot, because source health belongs to
      the connection whose crons run while the content card belongs to the household.
      A caller-less read stays global for the crons and the digest (the N1 precedent).
- [x] A test with two households asserts one household's empty connection does not
      change the other's verdict. **3 integration cases** in
      `tests/integration/household-isolation.test.ts`, with their own fixture, their
      own cleanup and the stray-connection parking the file already uses — extended to
      park stray *children* as well, since `connectionStudentWhere` deliberately
      admits an unlinked child and a neighbouring suite's leftover would otherwise
      decide the verdict. One case asserts both halves (household A `current` AND
      household B `no_content`, so the fix is a scope rather than a blanket), and two
      cover the child both parents list, including that moving the routing stamp
      between the two connections changes neither parent's verdict. Red was exactly
      the predicted shape: A read `no_content` in all three.
- [x] **3 unit cases** in `freshness.service.spec.ts`: the `findMany` where carries the
      caller's `userId` and stays global without one, and a child stamped to the other
      connection but linked to the caller's counts — the case the stamp got wrong. The
      two-school mock now keys its students off the links predicate, because the stamp
      is no longer in that query.

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
`SchoolAutocomplete.tsx:88` calls `onClear?.()`, a no-op here. `SignInPageClient`
passes it; this page does not.

**Description.** Select a school, then edit the text: the input shows the typed text
while `selectedSchool` still holds the old school, so `POST /school-links` goes out
with the wrong `semel` and fails `INVALID_CREDENTIALS` against a school the parent
never picked — the one error message in the table that will read as a lie.

**DoD**
- [x] `AddSchoolPageClient` passes `onClear`.
- [x] `tests/e2e/school-links.spec.ts` covers select-then-edit: the submit button is
      disabled, or the request carries the typed school.

**Done** (batch 5). `onClear` clears `selectedSchool`, and the submit button gates on
`!selectedSchool` as well as `isPending` — the prop alone would have left submit enabled with
nothing selected, since the button was only ever disabled while the mutation was in flight. The
`'יש לבחור בית ספר'` guard in `handleSubmit` stays as defence, now unreachable by click.

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
- [x] The branch is gated on `existingConnBeforeLogin.userId !== (the AppUser for this
      `mashovUserId`)`, or the upsert moves before the early return.
- [x] `auth.service.spec.ts` asserts a second sign-in by the same single-school parent
      refreshes `displayName`, and that a genuine cross-school adoption still does not
      create a second `AppUser`.

**Done** (batch 7). Gated, not reordered: the `appUser.findUnique` already read a few
lines below for `isFirstLogin` moves above the branch and the gate is a plain id
comparison against it, so this is one query rather than two. Moving the whole `upsert`
above the branch was rejected — it would write an `AppUser` row for a household about
to be adopted into a different one, which ADR-0029's model avoids. No merge hop is
needed in the gate: `mergedIntoUserId` is never written anywhere in `backend/`, so the
merged-pointer sub-case is unreachable (see "Not recorded as items"). The cross-school
spec was tightened while in there — it now mocks the credential's `AppUser` as a
*different* household, so it proves the gate instead of relying on an unmocked
`findUnique` answering `undefined`.

**Residual, recorded rather than fixed** (found by batch 7's own review). One shape still
freezes the name, and it is the adoption path itself: a parent whose `AppUser` was
created from school A's credential, who linked school B from inside that session, and
who from then on always signs in with **B's** password. No `AppUser` exists for B's
`mashovUserId`, so adoption fires on every such sign-in and still returns before the
upsert. Left alone deliberately — refreshing the household's `displayName` from the
*adopted* school's credential is a decision about which credential owns the household's
name, not a bug in the gate, and ADR-0029 does not settle it. Signing in with A's
password refreshes it. Pick this up with **B4**, which is the same question about contact
details.

One thing the review got wrong, recorded so it is not re-found: the adoption kill switch
*is* covered, by `'reproduces the old behaviour exactly when the kill switch is off'`
(`auth.service.spec.ts:949`), which pins the forking behaviour the switch restores.

What the same look did find is worth more. `jest.clearAllMocks()` clears calls but
**not implementations**, and `mockPrisma` is one shared object for the whole file — so
two of the adoption specs were reaching the gate on whatever `appUser.findUnique`
resolution the previously-run test happened to leave behind, and failed with a
`TypeError` when run alone with `-t`. Both now mock it explicitly. Any spec in this file
that depends on a mock it does not set is passing on test order.

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
- [x] `P2002` on that index maps to `409 CONNECTION_ALREADY_LINKED`.
- [x] A test asserts the 409 envelope rather than a 500.

**Done** (batch 7). Narrowed on `meta.target` mentioning `username`, in both the
field-array and constraint-name forms Prisma can return, and anything else rethrows: the
same `update` also writes `encryptedPassword`, `lastLoginAt` and `mashovUniqueId`, so a
blanket `P2002 -> 409` would one day label a different collision "username taken". A
companion test pins that propagation. No `P2002` handling existed anywhere in
`backend/src` before this, so it is the pattern now. `docs/api-contract.md` gained the
409 on both `PUT` rows that reach `updateConnection`.

Scope note: no frontend code calls `PUT /school-links/:id` today — `schoolLinks.ts` has
only `DELETE` — so this is an API-contract and robustness fix, not a 500 a parent can
currently reach from the UI.

### R10 — The link rate limit answers 409 where the rules say 429

**Severity**: low.

**Cause.** `backend/src/school-links/school-links.service.ts:439` — `checkRateLimit`
throws `ConflictException` for `RATE_LIMITED`. `.claude/rules/api.md` specifies 429,
and `AuthService.checkRateLimit` already uses `statusCode: 429`.

**Description.** The frontend maps the `code`, not the status, so the Hebrew message is
right. But any client keying off the status — or a proxy retry policy — sees a conflict
rather than a throttle.

**DoD**
- [x] 429, with the `RATE_LIMITED` code unchanged.
- [x] A test pins the status.

**Done** (batch 7). **The precedent recorded above is wrong as a model.**
`AuthService.checkRateLimit` does reach 429, but as
`Object.assign(new Error(...), { statusCode: 429 })` — a bare `Error` with no envelope,
which `auth.controller.ts:100-114` catches and re-throws as an `HttpException` carrying
one. Copying the *service* shape here would have dropped the `code` the frontend keys on
(`frontend/src/lib/school-link-errors.ts:17`), so the fix follows the controller's
shape, inside the service: `new HttpException({ error: { code: 'RATE_LIMITED', … } },
HttpStatus.TOO_MANY_REQUESTS)`. The code and the Hebrew message are unchanged, so no
frontend change was needed and none was made.

Worth recording why this survived a suite that looks like it covers it:
`tests/e2e/school-links.spec.ts:394` already asserted `status: 429` for `RATE_LIMITED`
— against a **mocked route it fulfils itself**. A table of `{ code, status, hebrew }`
that both seeds the response and asserts on it can only ever prove the frontend's
mapping, never the backend's status.

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
- [x] An empty target list on a connection-scoped run is reported, not silently
      successful — a `skipped` status or a `sync_run` recording why. The `sync_run`
      route was taken: `reportNoConnectionTarget` in
      `backend/src/sync/connection-fanout.ts` opens a run for the requested
      connection, closes it `failed` with the reason, warns, and returns `failed`
      with one failure counted. `skipped` would have had to be threaded through
      `SyncTaskStatus`, `ManualSyncTaskResult`, `RefreshTaskProgress` and the
      frontend's mirror types, and would have put a fourth value into
      `sync_run.status`, which every reader — `getAllSourceHealth`,
      `getLatestSuccessfulRuns`, the retention rule — partitions as
      success/not-success.
- [x] A test covers a targeted refresh of a deactivated connection.
      `connection-fanout.spec.ts` covers the helper; `achvas`, `notifications`,
      `mail-counts` and `mail-inbox`'s own specs each assert that a targeted
      `execute({ connectionId })` against a deactivated connection returns `failed`,
      opens exactly one run, closes it `failed`, and never touches the http client.

**The hole was in seven tasks, not four.** Beyond the `achvas` /
`notifications` / `user-details` / `mail-counts` the cause above names,
`mail-inbox.task.ts` has the identical
`connectionList = useSharedSession ? [null] : connections`, and
`school-activities.task.ts` loops `connections` with no shared-session fallback at
all. All six take the same helper.

Eight of the nine per-student tasks needed nothing: with `connections` empty their
inner `ordered` loop already throws `every connection failed for <guid>` and closes
a failed run per child. **`releases.task.ts` was the exception**, found by the
batch's own review: it had no `answered` flag and no post-loop throw, so `items`
stayed `[]` and it closed the run **`success`** with `fetchedCount: 0` *per child*.
That is worse than the six connection-loop tasks above, which at least left no row
at all — a green `releases:<guid>` is what `FreshnessService.getAllSourceHealth`
reads as a *fresh* `releases` source, so a real outage was undiagnosable in exactly
the window R11 is about. The pre-change `two-school-sync` fixture is independent
evidence: its failed-task list for school B's child was
`['behavior','groups','homework','lessonsCount','messageBoard','timetable']` —
`releases` 403'd for that child too and still was not in it. It now carries the same
guard as the other eight, which closes the global-cron half as well, and
`releases.task.spec.ts` pins both halves plus the case that must NOT fire: a child
who simply filed nothing is still a success, because the account answered.

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
- [x] `status` is `'partial'` if any result is, and the counts are summed. Worst-wins
      over the per-school statuses, reduced with the `PHASE_RANK` already in
      `sync.controller.ts` rather than a second ranking table; `tasks` is `flatMap`
      over the schools, the shape `getStatus` already uses, so the per-task counts
      arrive whole rather than summed into a lossy total; `startedAt` earliest,
      `endedAt` latest, `durationMs` the difference. `ManualSyncStatus` gained
      `'failed'` for a school that threw and has no `partial` to report, mirrored in
      the frontend's `SyncRefreshStatus` — which also finally declares the `schools`
      array the backend has returned since this branch. With one school every field
      is byte-identical to before, so the six e2e MOCK constants and old clients keep
      working.
- [x] `sync.controller.spec.ts` covers one-of-two-failing — `partial` when A is
      `success` and B is `partial`, both schools' tasks in `tasks`, the span across
      both, `schools[1].status === 'failed'` with overall `'failed'` when B throws
      while A succeeds, a rejection when every school throws, and the single-school
      response unchanged.

**A throwing school no longer discards a working one.** The loop now catches per
connection, so `results[index]?.status ?? 'failed'` — unreachable before, because one
school throwing 500d the whole endpoint — is the path that records it. If *every*
connection throws the error is rethrown: a refresh that achieved nothing must stay a
500, or `SyncingPageClient`'s `default:` branch stops reporting a failed trigger.

### Two sub-findings too small for an item of their own

- ~~`frontend/src/app/more/MorePageClient.tsx:42` —
  `isLastSchool = (pendingUnlink && schoolCount <= 1) || schoolCount <= 1` reduces to
  `schoolCount <= 1`, and since the per-row modal only opens when
  `schoolLinks.length > 1` the `pendingUnlink` term is dead.
  The fourth review added the half that is not merely dead code: with
  `schoolCount = schoolLinks?.length ?? 1` on the line above, a two-school household
  that opens the **bulk** disconnect before `['school-links']` resolves — cold cache,
  slow network, or just after `invalidateHouseholdScopedQueries` — is told
  "זה בית הספר היחיד המחובר" and shown the singular button, while two schools will be
  wiped. The default should be the safe branch, or the modal should not open until the
  count is known.~~ **Done** (batch 5). `isLastSchool` is now
  `schoolLinks !== undefined && schoolLinks.length <= 1`: an unresolved cache takes the
  plural branch, because being told "all schools will be deleted" with one school linked
  is merely odd while the reverse understates a destructive action. The term drops with
  it. Copy only — the mutation was `deleteAllSchoolLinks` on both branches.
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
- [x] The school chip is a server-side filter: `fetchConversations` passes `schoolId`
      and the query key includes it, so pagination and counts are over the filtered
      set. (**R1** already made `?schoolId=` 404 on a foreign connection, so the
      param is safe to send.)
- [x] The empty state distinguishes "no mail at all" from "no mail at this school",
      and keeps a way to load more or clear the filter.
- [x] An e2e case selects a school whose mail is not on page 1 and asserts it appears.

**Done** (batch 5). The chip maps its semel to a `HouseholdConnection.id` through `me.schools`
and rides in the query key, so switching chips refetches rather than re-filtering and the
pagination counts are the filtered ones. Server-side, the school predicate is its own third
element of the existing `AND` — never spread into `buildInboxWhere`, because both are `OR`s —
and it admits `householdConnectionId: null` alongside the chosen school, which is what closes
the `?schoolId=` minor below. A school-scoped deep link waits for `me` before fetching, so it
cannot flash another school's mail. With the filter server-side there is no page 2 to reach, so
the filtered empty state carries only its own copy and a clear-filter button.

---

## Fourth review (2026-11-19, after batch 3)

`/code-review high` over `master...HEAD`, run after batch 3 landed. Nine items; five
were already recorded (**R7**, **R14**, **R4**, **R12** and the `MorePageClient` dead
term, whose entry below gains a second half from it), and the three here are new.
The review found nothing wrong with batch 3 itself.

### R15 — The unread badge can never count an unattributed conversation

**Severity**: low. Narrow trigger, but it is the badge/list disagreement this branch
set out to fix, with the opposite sign.

**Cause.** `backend/src/mail/mail.service.ts:1282` `updateCachedNewCount` and
`backend/src/sync/tasks/mail-counts.task.ts:130` both count
`householdConnectionId: conn.id` only, while `householdMailScope` admits
`householdConnectionId: null`. `getSummary` reads `cachedNewCount` whenever
`_count._all > 0`, so for any household with a connection the badge is *only* those
per-connection counts.

**Description.** A NULL-stamped unread conversation is listed by the inbox and by
`recentConversations`, and contributes 0 to the badge. Normally the next inbox walk
stamps it and the numbers meet, so the window is seven minutes — but a conversation
upstream has stopped returning is never re-stamped by any walk, and `MailInboxTask`'s
sweep is scoped to `conn.id` so it cannot clear `isUnread` either. That row then shows
as unread in the list permanently while the badge reports zero. Reachable on any
database where the ownership backfill refused, which is every deployment with more than
one active connection.

Not a regression from batch 3: the asymmetry is batch 1's, and the dashboard's scoped
fallback count (**R13**) is only read when the household has no connections at all, so
it never meets this.

**DoD**
- [x] The two writers and the reader agree about NULL, by one rule: **each
      `cachedNewCount` stays its own connection's mailbox, and the reader adds the
      unattributed rows once, live.** The alternative — writers counting "own stamps
      plus NULL" — double-counts those rows on every household with two connections,
      which is the exact inflation ADR-0030 and `283c053` were about. The rule and its
      reasoning live in `unreadBadge` in `backend/src/common/mail-scope.ts`, beside
      `householdMailScope`, because the identical six lines of arithmetic existed in
      `MailService.getSummary` and `DashboardService.getSummary` and that is how they
      drifted; both now call it. The shared-session `cachedNewCount` write in
      `mail-counts.task.ts` and `mail-inbox.task.ts` is gone: it put one mailbox's
      count on `findFirst({ active: true })`, which was a cross-household write
      already and under the new rule would be counted twice. `localCount` still
      carries the number in the run telemetry.
- [x] A test with an unstamped unread conversation asserts the badge and the list
      agree. `tests/integration/mail-sweep-unattributed.test.ts`'s last case is
      inverted: the badge is `1 + 2 = 3` and the unread list is the same three
      conversations. Red was `Expected: 3, Received: 1`. Two unit cases in
      `mail.service.spec.ts` and one in `dashboard.service.spec.ts` pin the rule on a
      two-connection household (so a double count would show) and pin that the
      no-connection fallback does *not* add them again — its live count is taken over
      a scope that already admits NULL.

### R16 — A release request is sent upstream under the other parent's credentials

**Status: FIXED** in `3afde47`, closing B3's remaining bullet with it.

**Severity**: **high**. One household writing into another's Mashov account with their
decrypted password — the same class as **R1** and B3's attachment leak, and the only
cross-household leak still open.

**Cause.** `backend/src/common/connection-scope/connection-scope.service.ts:198` —
`resolveOrFallback` honours `userId` only on its *fallback* branch; a non-null stamp
resolves to that connection's target whoever is asking. (Its own doc comment says it
"is scoped to the caller when there is one", which is true of the fallback branch
only.) `children.service.ts:713`, `:729` and `:738` —
`createStudentRelease` / `updateStudentRelease` / `deleteStudentRelease` — pass
`await this.scope.targetForStudent(studentGuid, userId)`, and
`targetForStudent` resolves the **student's routing stamp**.

**Description.** Two parents at one school share a child (ADR-0016, ADR-0031); the
child is stamped to whichever of them synced last. `requireStudent` admits the child
for both, correctly, because the visibility edge lists both. But parent A's early-release
request then resolves to parent B's connection and goes out with
`putForTarget` / `deleteForTarget` under B's decrypted Mashov password, into B's
account. Mashov accepts it — same school, same child, well-formed request — so the
`I6` bound ("Mashov rejects it, so the symptom is an empty list rather than a leak")
does not hold here, exactly as it did not hold for the attachment path.

This is B3's remaining bullet with a reachable path, so fixing the stamped branch of
`resolveOrFallback` closes both.

**DoD**
- [x] The stamped branch treats "stamped outside the caller's connections" as unstamped
      and falls through to the `userId`-scoped fallback. The fallback **prefers the
      caller's connection at the stamped school**, which is what makes "the right
      account to write to" true rather than merely likely: without it a two-school
      household resolves to whichever of its own connections was used last, which is
      the wrong school's credential for this child. A stamp on a connection with no
      `userId` is still honoured — the branch-wide "ownership unknown" rule, and what
      every row of a deployment predating linking looks like. The caller-less path
      (crons, digest) keeps the stamp authoritative and its global guess.
- [x] Fixed the doc comment, which overstated the scoping.
- [x] **3 integration cases** in `tests/integration/household-isolation.test.ts`, on
      the existing shared-child fixture with per-connection passwords added: A's
      `create`/`update`/`deleteStudentRelease` for the child stamped to B all resolve
      to A's connection and spend A's password, B's own request still routes through B,
      and the child only B lists is refused before any credential is resolved. Red was
      exactly the predicted shape — all three of A's calls went out as
      `parent-b` / `enc-parent-b`. The two control cases passed before the fix too.
- [x] **7 unit cases** in `connection-scope.service.spec.ts`, 4 red before the fix,
      including a signed-in user with *no connection at all* resolving to another
      household's decrypted password, and the two-school case the school preference
      exists for.
- [x] Checked `targetForConversation`'s callers, and `targetFor`'s. Both of the
      latter (`MailService.unarchive`, `forEachConnectionSubset`) reach the resolver
      with an id grouped out of their own `visibleConversations` read, which bounds
      them — the same kind of bound that held for the conversation callers right up to
      the one it did not. `targetFor` therefore took the same optional caller and
      refuses a foreign id, so the resolver no longer depends on its callers for this.

### R17 — The link rate limit is spent on refusals it should not reach

**Severity**: low.

**Cause.** `backend/src/school-links/school-links.service.ts:90` — `checkRateLimit(userId)`
runs *before* `assertLinkable(...)`, contradicting the comment two lines below it:
"Checked before reaching upstream: no point spending a Mashov login, **or a
rate-limit slot**, on a school that cannot be added."

**Description.** Five attempts at an already-linked school, or five hits of
`LIMIT_REACHED`, lock the parent out of linking any school for fifteen minutes without
a single upstream call. Both refusals are local and cheap.

**DoD**
- [x] `assertLinkable` runs first, giving the comment its stated behaviour.
- [x] A test asserts a repeated local refusal does not consume the limit.

**Done** (batch 7), as a split rather than the literal reorder this DoD asked for.
`assertLinkable`'s orphan `findUnique` is an existence oracle on
`(schoolCode, username)` across **every household on the deployment**; in front of the
limit, an authenticated caller could probe it without bound to enumerate parent
usernames school by school. So the method splits in two, and the ordering lives at the
call site where it is legible:

- `assertLinkableFromOwnLinks` — the `findMany` on the caller's own active rows plus
  `CONNECTION_ALREADY_LINKED`, `SCHOOL_ALREADY_LINKED` and `LIMIT_REACHED`. Every
  refusal here is decided from rows the caller already owns, so it tells them nothing
  and costs nothing. Runs **before** `checkRateLimit`.
- `assertNoForeignOwner` — the orphan lookup and its refusal. Stays **behind** the
  limit.

Two methods rather than one with an ordering comment, so neither can be called in the
wrong place by accident. Two tests, not one: a repeated local refusal does not consume
the limit, *and* a foreign-owner refusal still does — the second is what keeps a future
"simplification" back into a single pre-limit call from passing.

### Not recorded as items

The review also flagged `auth.service.ts:288` — `resolveMergedOwner` is dead, because
`mergedIntoUserId` is never written anywhere in `backend/`, and the state it documents
("this user's only connection was absorbed into another household") is itself
unreachable: `SchoolLinksService.assertLinkable:312` refuses linking in both directions
with `CONNECTION_ALREADY_LINKED`, so a parent who signed in separately with two
schools' credentials before this feature keeps two `AppUser`s and has no merge path.
Left here as a note rather than an item because it is a *missing* migration path for a
pre-feature account shape, which is **T13**'s territory to confirm against real data
before anything is built for it.

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

### G2 — The school preference in `resolveOrFallback` is proved only against the fake

**Severity**: coverage, not behaviour. The assertion is real — the unit spec's
`makePrisma.matches()` filters on `schoolCode` as of `3afde47`, so the case would fail
if the preference were dropped — but it is in-memory only.

**Description.** `3afde47`'s fallback **prefers the caller's active connection at the
stamped school** before the generic `lastLoginAt desc` pick, which is what makes B3's
own postcondition ("lands on the caller's connection at the same school") true in a
two-school household rather than only in a one-school one. That preference has a unit
case and no integration case. The three integration cases added with **R16** are
one-school, so they would still pass with the preference removed.

Left out of batch 3.5 deliberately rather than bolted onto a closed item: an
integration version needs a second `schoolCode` and its own nested seed and cleanup,
because `household-isolation`'s shared `cleanup()` deletes connections by
`schoolCode: SEMEL` alone and would leave the second school's rows behind.

**DoD**
- [ ] An integration case on real Postgres: one household with connections at two
      schools, a child stamped to the *other* parent at school A, and A's resolve
      landing on the caller's school-A connection rather than their more recently used
      school-B one. Its own seed and cleanup, scoped to both school codes.

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
- ~~**A `?schoolId=` view excludes unattributed conversations.** The household scope's
  `OR [own, null]` ANDed with `{ householdConnectionId: schoolId }` can match no NULL
  row, so an unattributed conversation is in the unfiltered list and in no per-school
  one. No frontend caller is affected — `InboxPageClient` filters by school client-side
  and never sends `schoolId` — so it is API-surface only. **Correction (third review):**
  that client-side filter has a consequence of its own, recorded as **R14**, and sending
  `schoolId` is part of R14's fix, so the two have to be resolved together.~~ **Done**
  (batch 5, with R14). The school predicate is now `OR [schoolId, null]`, so the chip
  shows the unattributed rows rather than hiding them, and the integration case that
  pinned the exclusion asserts the inclusion instead.
- **Opening a conversation can leave one connection's `cachedNewCount` stale for up to
  five minutes.** Hydrating on open recomputes `isUnread` and no count, which is
  pre-existing; what changed in batch 1 is that the user's next mail action elsewhere
  no longer repairs it, because the refresh now writes only the connections that action
  touched. `MailCountsTask` settles it within five minutes. The fix is one call to
  `updateCachedNewCount` with the hydrated conversation's stamp.
- ~~An **unattributed unread conversation is in no badge and in every list.**~~
  **FIXED** in batch 4, as **R15** above. Neither of the two fixes this entry proposed
  is the one taken: counting NULL into a `cachedNewCount` row would be counted once
  per connection by the summing badge, and narrowing the read scope would hide a row
  the parent can see today. The badge instead stops being a pure sum and adds the
  unattributed rows once, on read (`unreadBadge`), so the list did not have to change
  at all. The record of what was wrong: each `cachedNewCount` is scoped to its own
  connection and the badge summed those rows, so a `mail_conversation` at
  `householdConnectionId: null` was counted nowhere — while the household mail scope
  admits NULL as "ownership unknown", so the same `/mail/summary` response listed it as
  unread. It was only reachable for a row upstream has stopped returning (a live one
  gets stamped on the next walk), and the sweep cannot clear it for the reasons in G1,
  so it was permanent rather than a seven-minute window — a badge disagreeing with the
  list on the same screen, which is the class of bug `283c053` was about.
  `tests/integration/mail-sweep-unattributed.test.ts` asserted it as current behaviour
  and now asserts the two agree.
- ~~**A connection-scoped refresh fans out over every child in the database.** Each
  per-student task reads `student.findMany({ where: { isActive: true } })` — not the
  refreshing connection's children — so `POST /sync/refresh` for school A asks A's
  account for school B's children and collects a 403 for each, across seven
  per-student tasks. Nothing wrong is written, but the refresh of a school that worked
  perfectly reports **`partial`**, which is what `/auth/syncing` shows the parent, and
  each foreign child leaves a failed `sync_run` that `FreshnessService` then reads as
  source ill-health.~~ **Done** (batch 6, with R11 and R12). The fix is the one
  proposed: `studentScopeForContext` in `backend/src/sync/connection-fanout.ts` is now
  the single `where` all nine per-student tasks use, scoped via `student_connection` by
  the existing `connectionStudentWhere` — the ADR-0031 visibility edge the
  `inactiveChildren` sweeps already use, so a child no connection lists is still
  admitted, which must stay or a deployment whose ownership backfill has not run would
  stop fetching for every child. The global `@Cron` path passes no `connectionId` and
  keeps every active child, unchanged. `tests/integration/two-school-sync.test.ts`
  asserted this as current behaviour and now asserts the inverse: A's run never
  mentions B's child, reports `success` with no failed task, and leaves no failed
  `sync_run` for B's child; the foreign request count went from one per own-child
  request to zero. Its `seed()` now parks the *unlinked* stray children the fixture
  did not create — the suite runs last against a DB nine earlier suites have written
  to, and the unlinked-child edge would otherwise make `success` hostage to another
  suite's leftovers; a stray that IS linked is already excluded by the predicate and
  is left alone.

  **The caveat, since the fix is conditional.** The wasted-403 symptom is gone for
  **linked** children only. A child with no `student_connection` rows is still
  admitted, so a connection-scoped refresh still asks about them, still collects a
  403 per per-student task, and still reports **`partial`** for a school that synced
  perfectly — until the next roster sync links them. That is the ADR-0031 trade-off
  and not a residual bug: excluding unlinked children would stop fetching for every
  child on a deployment whose ownership backfill has not run, which is far worse than
  a wasted call. It is asserted rather than assumed — the
  `'an unlinked child is still fetched for, at the cost of a partial'` group in
  `tests/integration/two-school-sync.test.ts` pins all of it, including that a linked
  foreign child is still excluded. The permanent close for the residue is the
  ownership backfill reaching every child, not a change here.
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
- `tests/e2e/school-links.spec.ts` ("a successful link goes to the syncing screen
  for that school") is **failing**: it failed once on `syncing-heading` not being found
  after `waitForURL` had already succeeded, then passed on an identical re-run. The page
  renders the heading behind its first `['sync-status']` fetch, so the assertion is
  racing that. Needs a `waitFor` on the page's loaded state rather than a bare
  `toHaveText`. **Correction (batch 5):** it is not load flake. Batch 5 failed
  it in three runs and passed it in two, and two of the failures were with
  `school-links.spec.ts` running **alone** — so "passes on a re-run" and "passes under
  no parallel load" are both wrong as diagnoses. One of the failures was in a run made
  *before* that batch touched any source, with the spec file's own diff insert-only, so
  it is not batch 5's doing either. Roughly a 60% failure rate, cause still unconfirmed.
  Not chased in batch 5, which it did not block; it needs an owner of its own.
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
