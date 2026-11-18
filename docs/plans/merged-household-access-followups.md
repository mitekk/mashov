# Follow-ups from the merged-household-access branch

Everything deferred from `feat/merged-household-access` (`8c0939f..HEAD`), which
implemented steps 1–12 of [the plan](merged-household-access.md). See
[ADR-0029](../adr/0029-household-merge-and-login-adoption.md) and
[ADR-0030](../adr/0030-per-connection-data-scoping.md) for the decisions it rests on.

The whole-branch review graded nine items Critical or Important; eight were fixed on
the branch. What is left is below: four bugs (**B1–B4**), the two operational tasks
the plan itself deferred (**T13–T14**), one test-infrastructure gap (**G1**), and the
minors.

**Read B1 first.** It is the one that breaks a stated requirement, and B2 and B4 are
cheaper to fix once its design question is settled.

---

## Bugs

### B1 — A child can belong to only one user, so the second parent to sync evicts the first

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

**What this needs before it can be fixed**: a decision on how a child relates to
users. Three shapes, with what each costs:

| Shape | Cost |
|---|---|
| Keep one stamp for routing, add a separate many-to-many for visibility (e.g. `student_connection`) | One new table and a changed predicate in four read paths. Leaves `householdConnectionId` meaning exactly "who to ask upstream", which is what it is good at. |
| Derive visibility instead of storing it — a user sees a child if any of their connections' last login roster listed them | No new table; needs the roster retained per connection, which it is not today. |
| Introduce a real `Household` above `AppUser`, with several users sharing one connection set | The shape ADR-0016 implies, and the largest change: `userId` is the universal scoping key, so this touches every `*.service.ts` signature and invalidates the reasoning in ADR-0015/0019/0020. |

**DoD**
- [ ] A decision is recorded as an ADR (amending ADR-0030's "two known defects").
- [ ] Two users with separate Mashov accounts at one school both see the shared
      children, simultaneously, with no sync ordering dependence.
- [ ] Each user's read/unread and archive state stays independent (ADR-0016), asserted
      by test rather than by inspection.
- [ ] A sync cycle for either user leaves the other user's view unchanged — asserted
      by running both users' `refreshAll` in sequence and in both orders.
- [ ] `targetForStudent` still resolves to a connection that can actually serve the
      child, and the `homework.task` owner-first optimisation still makes exactly one
      upstream call for a child whose owner answers.
- [ ] An integration test covers it with the two-household fixture from **G1**.

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
- [ ] `targetFor*` accept an optional `userId` and the fallback is scoped to it when
      present.
- [ ] Callers that have a `userId` pass it: `ChildrenService` (all nine newly-guarded
      routes already hold one), `MailService.getConversationDetail` and the attachment
      path.
- [ ] A test asserts an unstamped row belonging to user A never resolves to user B's
      connection.
- [ ] The no-`userId` path (digest, crons) keeps today's global fallback, with a test
      pinning that.

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

**DoD**
- [ ] An integration fixture with **two `AppUser`s**, each with its own connection, in
      `tests/integration/` (`tsconfig.integration.json` already exists).
- [ ] A fixture with a student at `householdConnectionId: null` **carrying
      current-year rows**, which is what C2 needed and no test had.
- [ ] A fixture with a `mail_conversation` at `householdConnectionId: null` that
      upstream no longer returns — the shape the sweep exists for.
- [ ] A test that enumerates the `children.controller.ts` routes taking a
      `studentGuid` and asserts each 404s for a foreign child, so route ten cannot
      ship unguarded.
- [ ] The cross-contamination test the plan asked for: seed two connections, two
      students and two mailboxes, run `refreshAll` for both, assert zero contamination
      in `student`, `mail_conversation`, `cachedNewCount` and the swept unread set.

---

## Minors

- `behavior-classifier.service.ts` — bare `catch { return false }` turns any DB error
  into "this absence is not justifiable". The default is defensible; swallowing the
  error unlogged is not.
- `children.service.ts` `getLessonPlans` / `getLessonHistory` — `catch { return {
  data: [] } }` with no log, so a 403 from a wrong-target resolution (**B3**) is
  indistinguishable from a school that has no lesson plans.
- Label-set inconsistency: `ChildrenService.resolveSchoolLabels` resolves over the
  household's whole connection set, `common/student-school-map.ts` only over the
  connections present in the list. Two schools whose short labels collide therefore
  show the collision-expanded full name on `/children` and the short colliding label
  on a page listing only one of them.
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
- `docker-compose.yml` hardcodes `5432:5432` for `db`, so `npm run test:e2e` cannot
  start on a machine with anything else on that port. Parameterising the host port
  (`${DB_PORT:-5432}:5432`) costs nothing; the e2e containers reach the db over the
  compose network and do not need the publish at all.
- `SessionModule` (`backend/src/session/session.module.ts`) is dead and not
  instantiable — it declares `MashovHttpClient`, whose only constructor argument is
  `MashovSessionService`, which that module neither provides nor imports. Nothing
  imports it and nothing injects `SessionService`. It now carries a comment saying so;
  deleting it is the actual fix.
