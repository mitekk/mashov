# Brief — resolve T13's six findings

Worktree: `/Users/mitya/Documents/poc/mashov/.claude/worktrees/batch3-household`,
branch `feat/merged-household-access` (clean and pushed at `4779d20`).

The findings are already written up, with evidence, under **T13** in
`docs/plans/merged-household-access-followups.md` — read that section first. It is the
record of a live two-school run (A = semel 482273, B = semel 484121, one child each) and
it states for each finding what was observed, what the root cause is, and what was *not*
established. Do not re-derive it; do not restate it in a new document.

Nothing below is covered by an existing test. 1195 unit tests and 12 integration suites
pass over all six, and findings 3 and 4 are reachable **only** with two schools linked —
that is why no suite catches them and why each fix needs a two-school fixture.

## The one hazard that outranks the findings

Findings 3 and 4 both come from the branch-wide NULL rule: `sync_run` readers admit
`WHERE ("householdConnectionId" = $1 OR "householdConnectionId" IS NULL)`
(`backend/src/sync/sync-run.service.ts:85-124`) so that an unstamped run still counts as
"ownership unknown" rather than "someone else's". That rule is deliberate and
load-bearing — the same reading governs mail and students, and **R4**, **R15** and
batch 3's readers all depend on it.

So: **do not narrow the NULL rule to fix these.** Narrowing it would make every
cron-written run invisible and silently re-break the freshness card. The defects are not
the rule; they are two places that mix a connection-scoped fact with an unscoped one in
a single row. Fix the mixing.

If you conclude the rule itself must change, stop and write an ADR proposal instead of
changing it — it amends ADR-0031's reading and needs the parent's decision.

## Order, and why

Three batches. Findings 3 and 4 share a root cause and a file, so they go together or
the first fix makes the second harder to see. 5 is independent. 6 is frontend-only and
half-blocked. 1 and 2 are gaps, not defects, and go last — they change what a parent
*sees*, so they are the ones where a wrong guess is cheapest to revert and most visible.

### Batch A — findings 3 and 4 (the source-health card)

**Finding 3.** `FreshnessService.getAllSourceHealth`
(`backend/src/sync/freshness.service.ts:397-449`) derives `status` from the success
*variants* — `variantSuccessKeys` at `:422-429`, matching `k === source` or
`k.startsWith(\`${source}:\`)` — but takes `lastAttemptAt`, `lastErrorMessage` and
`fetchedCount` from `latestRun = allRuns.get(source)` at `:418`, the **unvariant** key.
When an orphan NULL-connection run exists under the bare source name, the row emits
`{ status: 'fresh', lastErrorMessage: <the orphan's error> }` and the frontend faithfully
renders both. Observed live: a green ✓ for תיבת דואר נכנס with "Missing required Mashov
credentials in environment variables" beneath it, from a 16:07 cron tick that ran before
any connection existed. On a shared deployment that one row shows its error to every
household.

The decision to make: `status` and `lastErrorMessage` must come from the **same** set of
runs. Either take the error from the variant that produced the status, or suppress the
error when the status is `fresh`. Prefer the former — a stale-but-failing source should
still explain itself.

**Finding 4.** `SettingsService.studentGuidsIn`
(`backend/src/settings/settings.service.ts:83-98`) derives the guid list from a snapshot
that admits NULL-stamped runs, so an unstamped cron tick that wrote
`behavior:<guid>` and `homework:<guid>` for **both** children puts **both schools'**
guids into one connection's list. `getAllSourceHealth` then emits `<source>:<guid>` for
every per-student source × every guid — but the success lookup is connection-scoped, and
`groups`, `lessons_count` and `message_board` have no NULL-stamped rows (they only run
inside a connection-scoped refresh), so the foreign guid yields `never_synced`.
`normalizeSources` in `frontend/src/components/more/SourceHealthList.tsx:72` then reduces
variants with `selectWorseStatus` (`:62`, `STATUS_PRIORITY` at `:25`) and the row goes
red. `homework` and `behavior` escape only because their unstamped rows cover both guids.

Note `settings.service.ts:28-35` already records the *leak* — "a caller whose refresh has
run can still see a guid that is not theirs" — and names the real fix as `Student` scoped
to a household, a schema change with its own ADR. **That is not this task.** What is in
scope is the consequence the comment does not name: the foreign guid does not merely
appear, it **decides the row's status**. A guid with no success for this connection is
not evidence that the source never synced; it is evidence the guid is not ours.

The decision to make: either exclude guids the caller's own `student_connection` edges do
not list (the visibility edge is the authority per ADR-0031, and `SettingsService` already
has `userId`), or stop a variant with no run of its own from contributing a status at all.
The first is narrower and does not touch `getAllSourceHealth`; prefer it unless reading
shows it cannot see the edges.

**Tests, each watched red first.** Integration, with a two-connection fixture — this is
the shape no existing suite has. One test per finding, both asserting on the response of
`GET /settings/source-health`:
- a NULL-connection `failed` run under a bare source name, plus connection-scoped
  successes under `<source>:<connId>`, must not produce a `fresh` row carrying an error;
- two connections each with one child, with NULL-stamped `homework`/`behavior` runs for
  both guids and connection-scoped `groups` runs for one, must not report `never_synced`
  for the connection whose `groups` run succeeded.

`tests/integration/connection-scope-school-preference.test.ts` is the closest fixture
precedent (two connections, its own `cleanup()` keyed on a *set* of school codes — the
reason it is a separate file). Follow that pattern; do not add two-connection cases to
`household-isolation.test.ts`, whose `cleanup()` deletes by a single `schoolCode`.

### Batch B — finding 5 (the permanently `partial` refresh)

`backend/src/sync/tasks/school-activities.task.ts:103-108` does
`new Date(item.activityStartDate)` / `new Date(item.endAnswerDate)` and throws
`unparseable activity dates on activity <id>` when either is `NaN`. It fires on activity
3 at school A and activity 13 at school B — both schools, **every** refresh — so the
envelope can never read `success` and **R12**'s honest `partial` is permanently on,
which trains the parent to ignore it.

Every *stored* activity has a parseable `"2026-09-17T00:00:00"`, so the failing ones
carry something else. Establish which before choosing a fix: `new Date(null)` is the
epoch while `new Date(undefined)` is `NaN`, so an absent optional field is the likely
shape — an activity with no response deadline is a legitimate thing for a school to
publish. Log or capture the offending `item` to confirm. If the field is genuinely
optional upstream, the task must store the activity with a null date rather than fail;
one optional field must not fail the whole task.

Whatever you decide, the postcondition is the same and it is the test: a batch containing
one undated activity stores the others and does not fail the task. Keep a real failure
(a malformed non-empty date) still failing — do not replace the throw with a blanket
`catch`.

### Batch C — finding 6 (the unlink modal)

Two halves, and only one is settled.

**Settled, fix it.** `unlinkOneMutation` (`frontend/src/app/more/MorePageClient.tsx:67-86`)
has **no `onError`**. A failed unlink leaves the modal open, the confirm button
re-enabled, and nothing on screen — which is the terminal state the parent was left in
after the retry 404'd. It needs an error path that says something, the way
`AddSchoolPageClient`'s `linkMutation.onError` does
(`frontend/src/app/more/schools/new/AddSchoolPageClient.tsx:69-94`, with its Hebrew
messages in `frontend/src/lib/school-link-errors.ts`). A 404 on a school already gone is
not really an error to report — treat it as success and close.

**Not settled, do not guess.** Why the *successful* 204 did not close the modal is
unresolved. The backend log shows `DELETE /api/v1/school-links/<B>` → **204** ("Unlinked
1 school(s); 1 remain"), then nine seconds later the same DELETE → **ERROR**; the only
control that sends that request is the confirm button inside a modal still holding
`pendingUnlink`, so `setPendingUnlink(null)` at the end of `onSuccess` never ran. Every
statement above it was read and none can throw: `ChildrenResponse.data` is a real array
(`frontend/src/types/api.ts:129`), `writeSelectedChildGuidToStorage` wraps storage in
`try/catch` (`frontend/src/hooks/useSelectedChild.tsx`), and `apiFetch` returns `{}` for
a 204 with an empty body rather than throwing on `JSON.parse`
(`frontend/src/api/client.ts:66-71`).

So this half needs **reproduction before diagnosis**, and reproduction needs a second
school linked — which the completed unlink has undone. Two routes: an e2e that mocks
`DELETE` → 204 over a two-school `seed()` and asserts the modal closes (cheap, and the
suite is already route-mocked — see `tests/e2e/school-links.spec.ts`), or the parent
re-links school B with real credentials. **Try the e2e first.** If it closes the modal,
say so and leave the live behaviour as an open question rather than inventing a cause.

### Batch D — findings 1 and 2 (the two gaps)

**Finding 1.** School B's `schoolName` is NULL because B's Mashov login omits
`schoolSettings.schoolName`, and `auth.service.ts:260,319,334` write
`schoolName: schoolSettings?.schoolName` straight through. The `?? String(schoolCode)`
fallbacks then make the chip and the contact card read `484121`. B's real name
(`חטיבת נעורים בראשית - צור יצחק (חטב)`) is in the public list `GET /api/v1/auth/schools`
already serves (`auth.controller.ts:35`, `auth.service.ts:84`) — the sign-in form loads
it to populate the picker. So the name is available and unused.

The decision: fall back to the public list's name when the login omits it, at write time
(so one lookup fixes every reader) rather than in each `??`. Check whether that list is
cached before adding a per-login upstream call. Keep `String(schoolCode)` as the last
resort — a semel is a worse label than a name but better than blank.

**Finding 2.** `/inbox?school=X` filters the list but not the header badge, because
`MailService.getSummary` (`backend/src/mail/mail.service.ts:100`) takes only `userId`.
This is a **UX gap, not a correctness bug**, and the nav badge must stay
household-global — a parent filtered to one school still needs to know the other has
mail. So do not scope the badge. The fix is to make the two numbers legibly different:
say on screen that the filter is active and what it is hiding. This one is a judgment
call about copy; propose it before building it.

## Constraints

- **TDD, every test watched fail first.** `.claude/rules/testing.md` is not optional
  here, and for findings 3 and 4 the failing test *is* the finding — both are invisible
  to the existing suites, so a test that passes before the fix means you have reproduced
  the wrong thing.
- Findings 3, 4 and 6 are degraded-signal defects, not leaks. Do not let a fix narrow a
  household read: `tests/integration/household-isolation.test.ts` is the guard, and it
  must stay green.
- **Push only after asking** — shared branch.
- `.env` and `.env.example` are denied by the session's permission settings; if an entry
  is needed, draft it and hand the parent a `!` command.
- The compose override used for a live run is a scratchpad file, never committed.
- One commit per finding (or per batch where they share a seam), each leaving the tree
  green, each ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Record each resolution under its finding in **T13**'s findings list in
  `docs/plans/merged-household-access-followups.md` — amend the existing entry, do not
  append a second account of the same thing. The opening and closing paragraphs of that
  file both claim these three defects are open; update them when they are not.

## Verification

```bash
cd /Users/mitya/Documents/poc/mashov/.claude/worktrees/batch3-household
(cd backend && npx jest src/sync src/settings src/mail src/auth)
npm run test:unit
npm run lint
npm run typecheck:backend
(cd frontend && npx tsc --noEmit)
docker compose -f docker-compose.yml -f <override>.yml \
  --profile test up --build --abort-on-container-exit --exit-code-from integration integration
npx playwright test
```

Carried hazards: do **not** pass `--testPathIgnorePatterns=worktrees/` to jest (it matches
this worktree's own path and silently runs zero tests); there is no root `npm run
typecheck`; jest path patterns are repo-relative from `backend/`; and
`jest.clearAllMocks()` clears calls but not implementations, so set what you depend on
and check new specs in isolation with `-t`.
