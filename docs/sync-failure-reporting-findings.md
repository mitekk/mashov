# Follow-ups to #60 — root cause notes

Investigation record for the two defects found while diagnosing the per-student
freshness bug (#60). Both are "a failing sync does not report as failing".

## Defect 1 — a run closes `success` while its items failed

**Mechanism.** In every per-item task the upsert loop catches per-item errors,
increments a failure counter and continues; the run is then closed
*unconditionally* `'success'`.

`grades.task.ts` (pre-fix line numbers):

- 205-210 — `catch (itemErr)` → `failedCount++`, message collected
- 213 — `closeRun(syncRun.id, 'success', { fetchedCount, updatedCount })`

So a student whose grades all fail to persist gets a `success` run carrying
`fetchedCount: 40, updatedCount: 0`. `getLatestSuccessfulRuns` filters
`status = 'success'`, so that run satisfies the sync-on-read TTL gate: the
section stays empty for the full 6h while `source-health` reads `fresh`. It is
the same end state as the #60 bug, reached by a different route, and it is
invisible on the one page that answers "is syncing working".

Only the *aggregate* return value is derived correctly
(`status: failedCount > 0 ? 'failed' : 'success'`, line 228) — the persisted row
is not.

**Scope.** 13 tasks share the pattern: achvas, behavior, bells, daily-behave,
grades, groups, homework, lessons-count, mail-inbox, message-board, out-behave,
releases, school-activities, timetable. (`mail-counts` closes `success`
deliberately even when its two counts disagree — see its own comment, line 150;
`user-details` and `students` have no per-item loop of this shape.)

**Note on the counter.** `failedCount` in these tasks is *task*-scoped, shared
across students. The per-run close needs a per-run local, or student B's run
inherits student A's failures.

**Why `failed` and not `partial`.** `closeRun` already accepts `'partial'`, but
no task has ever written it to `sync_run`, and `freshness.service.ts:428-446`
picks `latestFailure` on `r.status === 'failed'` only. A `partial` row is
therefore neither a success nor a failure to the reader: a source whose only run
is `partial` would report `never_synced` with a null error — a *new* silent
failure. `failed` needs no reader surgery, carries `lastErrorMessage`, and is
excluded from `getLatestSuccessfulRuns` so the TTL gate correctly stays
unsatisfied. This is the same reasoning `connection-fanout.ts:96-104` records
for choosing `failed` over a new `skipped` status.

## Defect 2 — a failing sync never sets `credentialStaleAt`

**Mechanism.** `credentialStaleAt` is written in exactly one place:
`credential-recovery.service.ts:595`, after a password reset the parent
performed through our own recovery flow. Nothing else ever sets it.

So when a Mashov password goes stale *upstream* — changed at the school,
expired — every sync login fails, and `school-links.service.ts:918`
(`credentialStale: connection.credentialStaleAt !== null`) keeps reporting a
healthy connection. That is what made `school-links` show green throughout the
#60 incident.

**Where it belongs.** `mashov-session.service.ts:597-601`
(`getAuthHeadersForConnection`'s catch) is the single choke point through which
every per-connection login failure passes.

**The gate that matters.** It must NOT fire on transport failures — a stalled
proxy or an HTML error page would otherwise mark every connection's credentials
stale and nag every parent. `isMashovRejection(error)`
(`common/mashov-login/mashov-reason.ts:237`) already answers exactly this: true
only when Mashov itself answered, evidenced by a `Reason` header or a JSON
content type. Its doc comment was written for this class of mistake.

It must also not fire on a **data** 401/403. `mashov-http.client.ts:133` retries
those, and the per-student fanout *relies* on a 403 meaning "this account does
not know this child" — which is normal and not a credential problem. Only a
failure of the login itself counts.

**Reason set.** Mark stale only where re-entering credentials is the remedy:
the `INVALID_CREDENTIALS` fallback (no `Reason`, or one we do not recognise) and
the credential-setup family — `ChangePass`, `SetUsernameAndPass`,
`CreateUsername`. Deliberately excluded: `MfaRequired` (a code, not a
password), `UserSuspended` (a captcha escalation, which re-entry cannot clear),
`SchoolClosed`, `UserInactive`, `UserInactiveInYear`, `NoChildren`,
`NoParentsAccess`, `UseUsername` — all real failures, none of them fixed by
supplying the password again.
