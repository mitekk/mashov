# Testing the daily digest locally

The digest reports **today's** school data, so there is nothing to look at
unless today's rows exist. Two things make a local test awkward:

- A real sync needs Mashov credentials and the residential proxy (ADR-0023),
  and even with both, a genuinely quiet school day proves nothing.
- `tests/integration` runs `prisma db push --force-reset`, so any data you had
  in the local database is gone after an integration run.

So local testing uses a synthetic child whose rows deliberately hit every
branch of the report. `backend/scripts/seed-digest-local.sql` creates it,
along with the `app_session` row needed to reach the manual-run endpoint
behind the global `AppSessionGuard`.

Everything it writes is prefixed `local-digest`. **Never run it against
production** — it inserts a usable session token.

## 1. Bring the stack up

```bash
docker compose -f docker-compose.yml build backend
docker compose up -d
```

Pass `-f docker-compose.yml` explicitly on the build. A plain
`docker compose build backend` also loads `docker-compose.override.yml`,
which sets `target: builder` — you get the builder stage, whose command is
the base image's bare `node`, and the container exits 0 with no logs.

If `db` fails to bind port 5432, something else on the host holds it. Either
stop that, or start the database without publishing the port — the backend
reaches it over the compose network either way:

```bash
cat > /tmp/no-db-port.yml <<'YAML'
services:
  db:
    ports: !override []
YAML
docker compose -f docker-compose.yml -f /tmp/no-db-port.yml up -d
```

## 2. Seed today's data

```bash
docker compose exec -T db psql -U postgres -d mashov -v ON_ERROR_STOP=1 \
  -f /dev/stdin < backend/scripts/seed-digest-local.sql
```

It prints a row count and is re-runnable: it clears its own ledger rows
first, so the same items report again on every run.

What it creates, and why each row is there:

| Row | Purpose |
|---|---|
| `app_user` + `app_session` | The session token `local-digest-token`. Every digest endpoint is authenticated, and a run is scoped to the caller's own recipient rows. |
| `student` | First name `יונתן`, family name `לוי` — the family name exists so you can confirm it never reaches the model or the message. |
| `digest_recipient` | Channel `telegram`, placeholder address. A dry run routes every send through `LogSender` regardless of channel. |
| `behavior_item` (today) | A lateness event with a free-text Hebrew `remark`. |
| `homework_item` (today) | Plain text, no deadline language — the "newly assigned" path. |
| `homework_item` (5 days ago) | Text naming a deadline (`עד מחר`). Five days puts it outside the 3-day new window and inside the 14-day due window, so it arrives purely as a due-tomorrow candidate. |
| `timetable_entry` | Puts that group's next lesson on tomorrow, so the fallback estimate has something to resolve to when no API key is set. |
| `student_release` | An early release the parent filed for tomorrow at 11:30, with their own remark. The remark is rendered in the message and never sent to the model. |
| `school_activity` | An unanswered consent form due in three days. Household-scoped, so it hangs off the user, not the child. |
| `sync_run` × 4 | Fresh successes under the per-child source names (`homework:<guid>`, `releases:<guid>`, `schoolActivities:<userId>`). Without them a quiet day is reported as `skipped_stale` rather than quiet. |

## 3. Dry run

`DIGEST_DRY_RUN` defaults to `true`, so this renders and logs without
sending. `DIGEST_ENABLED` only gates the cron — the manual endpoint runs
either way.

```bash
curl -s -X POST http://localhost:3001/api/v1/digest/runs \
  -H 'Content-Type: application/json' \
  -H 'Cookie: mashov_session=local-digest-token' \
  -d '{"dryRun":true}'
```

Expect `{"status":"dry_run","itemCount":5,"recipientCount":1,"usedLlm":false}`.
`usedLlm: false` is correct with no `ANTHROPIC_API_KEY` — the deterministic
Hebrew fallback ran.

Read the message it rendered:

```bash
docker compose exec -T db psql -U postgres -d mashov -At \
  -c "select \"messageText\" from digest_delivery
      where \"studentGuid\"='local-digest-guid'
      order by \"runAt\" desc limit 1;"
```

Check, specifically:

- the deadline line reads `צפי הגשה`, never `תאריך הגשה` — that label is now
  the only thing marking the date as derived (ADR-0027);
- every section says what actually happened, since there is no item list under
  the prose to fall back on;
- no family name, no GUID, no teacher name anywhere in the text;
- dates render `DD/MM/YYYY`.

A dry run deliberately **releases** its claims, so running it again produces
the same message. That is what keeps a dry run from silencing the first real
send.

> **An integration run wipes this.** `tests/integration` runs
> `prisma db push --force-reset`, which drops and recreates the database — so the
> chat id the wizard bound below is gone afterwards and the seed restores the
> placeholder. Re-run the wizard after any integration run.

## 4. Real Telegram send

**Use the wizard, not psql.** Reading your own chat id out of `getUpdates` and
`UPDATE digest_recipient` by hand is exactly the procedure ADR-0033 replaced —
and a chat id set by hand is the unverified-recipient problem ADR-0026 flagged,
since a typo is indistinguishable from a correct id until a stranger receives a
child's behaviour record.

Get a bot token from `@BotFather`, put `TELEGRAM_BOT_TOKEN=...` and
`DIGEST_DRY_RUN=false` in your `.env`, and restart:

```bash
docker compose up -d backend frontend
```

Then, in the app: `עוד` → `עדכונים בטלגרם` → pick the children → tap the button
→ press **START** in Telegram.

Three things to confirm while you are there, none of which a test covers:

- the wizard advances to its last step **by itself**, with no "I pressed it"
  button — that is the long poller having seen the START;
- the confirmation message arrives in the real Telegram client;
- the Hebrew renders right-to-left correctly, with the bullets and the date on
  the correct side. This is the one thing a log cannot show you.

Press START a second time: you should get a friendly "already connected" reply
and **no** duplicate recipient rows.

The seeded child is the one to pick. `backend/scripts/seed-digest-local.sql`
leaves `digest_recipient` with a placeholder address; the wizard overwrites it
with your real chat id through the upsert on
`@@unique([studentGuid, channel, address])`, so pick the seeded child in step 2
rather than editing the row.

Now re-seed (to clear the ledger) and run the digest itself:

```bash
docker compose exec -T db psql -U postgres -d mashov -v ON_ERROR_STOP=1 \
  -f /dev/stdin < backend/scripts/seed-digest-local.sql
curl -s -X POST http://localhost:3001/api/v1/digest/runs \
  -H 'Content-Type: application/json' \
  -H 'Cookie: mashov_session=local-digest-token' -d '{}'
```

Two more checks worth making back in `עוד`: toggle one child off and re-run —
that child must drop out of the results — and `ניתוק`, after which the
`digest_recipient` rows and the link codes are both gone.

If you have no bot token, the wizard says so on step 2 rather than offering a
dead `t.me/undefined` link. If `DIGEST_ENABLED` is false, its last step says
sending is turned off on this server rather than promising briefings.

This is the only way to check the one thing a log cannot show you: that the
Hebrew renders right-to-left correctly in the actual Telegram client, with
the bullets and the date on the correct side.

Then run it **again without re-seeding**. The second run must report
`skipped_empty` and send nothing — that is the dedup ledger working. Change
the homework text in the database and run once more: it should re-report,
because the content hash changed.

## 5. Real model output

Set `ANTHROPIC_API_KEY` and restart. Now `usedLlm: true`, the prose is
written by Opus, and `deadlineResolutions` does the deadline extraction
instead of the timetable estimate. Worth confirming:

- the prose is natural Hebrew, not translated-sounding;
- the model's count matches the bullets (if narrowing dropped an item, the
  headline and deadline line fall back to the deterministic ones);
- `digest_reported_item.resolvedDueDate` records a deferral when the model
  dates an item to a day other than tomorrow.

## Teardown

```bash
docker compose exec -T db psql -U postgres -d mashov <<'SQL'
DELETE FROM digest_reported_item WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM digest_delivery WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM digest_recipient WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM homework_item WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM behavior_item WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM timetable_entry WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM student WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM school_activity WHERE "userId" = 'local-digest-user';
DELETE FROM student_release WHERE "studentGuid" = 'local-digest-guid';
DELETE FROM sync_run WHERE source LIKE '%local-digest-guid' OR source LIKE '%local-digest-user';
DELETE FROM app_session WHERE "userId" = 'local-digest-user';
DELETE FROM app_user WHERE id = 'local-digest-user';
SQL
```
