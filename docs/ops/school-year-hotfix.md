# Runbook: unfreeze a stale school year in production

**When to use this.** The freshness badge reads fresh, `syncRun` shows success, and yet the
newest homework or behaviour item is months old — or a child's `classCode`/`classNum` is still
last year's. `GET /settings/source-health` reporting `contentFreshness.status = "stale_year"` is
the same signal, stated explicitly.

**Why it happens.** Mashov scopes the whole session to the `year` in the `POST /api/login` body,
and that year comes from `householdConnection.schoolYear`. If it names a year that has ended,
every cron succeeds at fetching data from a finished year. See
[ADR-0024](../adr/0024-school-year-resolution-and-rollover.md).

**Since ADR-0024 this should not recur** — `SchoolYearRolloverTask` advances the connection on a
daily cron and on boot. This runbook stays as the break-glass path for a database that predates
that task, or for a case where auto-detection picks the wrong year.

Mashov names a school year by its **ending** calendar year: `2027` = Sep 2026 – Jun 2027.

---

## 1. Measure before changing anything

Confirm egress first — a blocked egress looks nothing like a stale year but is often blamed for
it:

```bash
docker compose exec backend sh -c \
  'curl -s -o /dev/null -w "%{http_code}\n" https://web.mashov.info/api/schools'
# expect 200
```

Read the years the school actually publishes, and what Mashov says the active one is:

```bash
# max(years) for the family's semel
docker compose exec backend sh -c \
  'curl -s https://web.mashov.info/api/schools' \
  | jq --argjson semel "$SEMEL" '.[] | select(.semel == $semel) | {semel, name, years}'
```

Then one manual login with the candidate year and inspect what comes back —
`accessToken.schoolSettings.schoolYear`, `accessToken.userSchoolYears`, and
`children[].classCode/classNum`. This settles whether `years[]` lags the calendar and whether
Mashov rejects or silently coerces an unavailable year.

## 2. Advance the connection

This is what actually unfreezes the crons: they read `conn.schoolYear`, not the env var.

Columns are camelCase and hostile to unquoted identifiers. **Confirm the casing first:**

```sql
\d household_connection
SELECT id, "schoolCode", "schoolYear", username FROM household_connection;
```

```sql
UPDATE household_connection SET "schoolYear" = 2027 WHERE "schoolCode" = <semel>;
```

## 3. Restart the backend — after the UPDATE, not before

The per-connection Mashov session cache is an in-process `Map`, so the restart has to come
second or it caches a session scoped to the old year.

```bash
docker compose up -d backend
docker compose logs backend | grep "resolved year"
# expect: resolved year=2027 source=schools-api semel=<semel>
```

Setting `MASHOV_YEAR=2027` in the prod `.env` is the override path and is **not** normally
needed — it exists for the case where auto-detection picks the wrong year. If you do set it,
restart after the `UPDATE`, same ordering.

## 4. Refresh the roster

`classCode`/`classNum` only change when `accessToken.children[]` is re-read, which needs a
login. Either:

```bash
curl -X POST .../api/v1/sync/refresh -H "Cookie: mashov_session=<token>"
# the `students` task runs first; expect status: success and 14 tasks
```

or have the parent sign in again. GUIDs are stable across years, so the class fields update in
place — no child is duplicated.

## 5. Verify

```sql
SELECT "schoolCode", "schoolYear" FROM household_connection;              -- 2027
SELECT "fullName", "classCode", "classNum", "isActive" FROM student;      -- class advanced
SELECT max("lessonDate") FROM homework_item WHERE "schoolYear" = 2027;    -- Sep-Nov 2026
```

```bash
curl -s .../api/v1/settings/source-health \
  | jq '.contentFreshness, .overallState, (.sources[]|select(.source=="students"))'
# expect: status "current", overallState "fresh", students "fresh"
```

Then in the browser: the child card shows the right class, recent counts draw only from the
current year, and the freshness badge is recent.

## 6. Rollback

Revert the `UPDATE` (and the env var, if set) to the previous year and restart the backend.
Nothing else is mutated by this procedure.

## What never to delete

If last year's and this year's rows look visibly mixed, clean **only** the two fully
re-derivable tables:

```sql
DELETE FROM subject_enrollment WHERE "schoolYear" = <old year>;
DELETE FROM timetable_entry    WHERE "schoolYear" = <old year>;
```

**Never delete from `homework_item` or `behavior_item`.** Production holds the only copy and past
dates cannot be re-fetched from Mashov.

## Rollover rehearsal (staging)

Proves the fix holds without waiting for August: set a connection's `schoolYear` back to the
previous year and unset any override. `/settings/source-health` should report `stale_year`;
`SchoolYearRolloverTask` should then advance the connection within one run (it also runs on
boot) and the status should return to `current`.
