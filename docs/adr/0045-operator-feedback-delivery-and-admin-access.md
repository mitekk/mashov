# ADR-0045: A Cron Outbox Delivers Each Report, and the Admin Surface Is Gated by a JWT We Verify Ourselves

- **Date**: 2026-11-24
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent
- **Relates to**: [ADR-0044](0044-feedback-rows-are-self-contained.md) (the row this
  delivers and renders — amended by this record),
  [ADR-0038](0038-inbox-mail-notifications.md) (the cron + `TelegramSender` shape copied
  here), [ADR-0023](0023-bounding-mashov-egress-abortsignal.md) (why this module imports nothing that
  builds a Mashov client), [ADR-0026](0026-outbound-digest-delivery-and-llm-egress.md) (`DigestSender`)
- **Amended**: 2026-11-25 — sections 2 and 3 superseded in part by sections 11 and 12 below
  (a separate bot, and a destination failure parking the row instead of charging it).
- **Implemented by**: `src/feedback/feedback-notifier.service.ts`,
  `src/feedback/feedback-telegram.sender.ts`, `src/digest/senders/telegram.sender.ts`
  (`tokenVar()`/`hasToken()`),
  `src/feedback/tasks/feedback-notify.task.ts`, `src/admin-auth/`, `src/admin-feedback/`,
  `frontend/src/app/admin/feedback/`, `prisma/migrations/20261128000000_feedback_outbox_and_triage`,
  `docs/ops/admin-access-setup.md`

## Context and Problem Statement

ADR-0044 shipped `POST /api/v1/feedback` as a write-only channel: a self-contained row and
nothing else. Its own "Also deliberately absent" section named the two gaps that leaves — no
read path and no notification — and nominated the cheap fix for the second.

Both gaps have the same consequence: a parent's report lands in a table nobody is watching,
and the only way to read it is `psql`. A parent who takes the trouble to tell us the grades
are wrong gets silence, and the feature's whole value — hearing about a bug before it becomes
a pattern — depends on somebody happening to look.

So: deliver each new report to a human, and give that human a screen to read it on. The hard
parts are not the list and the message. They are **where the delivery hangs off the write
path** and **what actually authorizes the screen**.

## Decision Drivers

- A parent's `POST` must not get slower, and must not fail because Telegram is down.
- A Telegram outage must cost zero reports — a report is the thing we cannot re-derive.
- The read path renders other people's free text, their email and their schools. Whatever
  gates it has to hold against an unauthenticated request, not merely against a tidy one.
- The operator is not a parent: they have no Mashov household and no `mashov_session`.
- One operator, one allowlist. No roles model, no second user table.

## Decision

### 1. Delivery is a cron-driven outbox, not an inline send

`FeedbackService.create()` is **unchanged**. A two-minute cron
(`FeedbackNotifyTask`) selects rows where `notifiedAt IS NULL AND notifyAttempts < 3`,
oldest first, sends one Telegram message each, and persists the outcome in both branches.

The alternatives, and why not:

- **Inline `await`** — the parent waits on Telegram, and a Bot API blip turns a stored report
  into a 500 the parent reads as "it didn't send".
- **Floating promise after the response** — no latency cost, but a rejection is invisible and
  a restart between the insert and the send loses the notification silently. Worse, it is the
  kind of code whose failure mode only shows up the day it matters.
- **Cron outbox** — the row is the queue. `create()` grows no hook point at all, which is the
  main simplification this choice buys: the write path's tests did not change.

Two minutes, because the point is promptness and the tick is cheap: one indexed query over a
table bounded at ten rows per household per hour, and nothing at all when no chat is
configured.

### 2. Three attempts, then retired

`notifyAttempts` counts spent attempts; at 3 the row stops being selected. A retired row
keeps `notifyError`, and the admin detail view renders it — so a report the outbox gave up on
is visible on the screen that replaced the notification, rather than only in a log line
nobody reads.

A permanent failure (`isPermanentTelegramFailure` — "bot was blocked", "user is deactivated")
sets `notifyAttempts` straight to 3. Spending three attempts four minutes apart on a recipient
who is gone tells nobody anything.

> **Amended 2026-11-25.** "chat not found" no longer retires a feedback row — it, and the
> channel-permission refusals beside it, now **park** the row without charging an attempt.
> See section 12.

Unlike the digest, nothing here is re-derived on retry and nobody is waiting, so there is no
case for retrying forever: that would log the same failure every two minutes for as long as
the row exists.

### 3. No `*_ENABLED` flag, deliberately diverging from house convention

The notifier is off — silently, with no query and no log line on any of its 720 ticks a day —
unless it has somewhere to deliver to. Since the amendment in section 11 that is two values
rather than one: `FEEDBACK_TELEGRAM_BOT_TOKEN` (which bot) and `FEEDBACK_TELEGRAM_CHAT_ID`
(which chat). Both set means on; either one missing means off.

Every other cron in this repo carries a `*_ENABLED` var defaulting to `false`
(`DIGEST_ENABLED`, `INBOX_NOTIFY_ENABLED`). Those gate features with per-parent recipients,
where a wrongly-on cron messages real households. Here the recipient *is* the configuration:
these two vars are not flags but the two halves of one address, and a third switch would only
create a state where delivery is off while everything needed for it is set. Two coordinates,
no flag.

The token half is asked of the sender (`hasToken()`) rather than read from config by the
notifier, so each env var name appears in exactly one place in the code.

### 4. `contactEmail` goes in the Telegram message

Ruled in, after weighing it. It is the reply address — the single most actionable field for
an operator — and anyone holding that chat already holds the deep link into the admin
dashboard, which shows the whole row. The chat is a strictly smaller disclosure than the
screen it links to, so withholding the email there buys nothing real.

It is the most identifying field in the message, and it is the one field **omitted when
absent** rather than printed as `none`.

The message carries no `parse_mode`, like every other sender here: a parent's own words
routinely contain `* _ - . !`, and Telegram rejects an entire message whose markup is
unbalanced. A report that cannot be sent because the parent used an asterisk is the worst
failure this feature could have.

### 5. In-process JWT verification is the real boundary — not defense in depth

Two Cloudflare Access applications (`/admin` and `/api/v1/admin`) share one reusable
email-allowlist policy. **And the backend verifies the forwarded
`Cf-Access-Jwt-Assertion` itself**, with `jose`: remote JWKS at
`${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, `RS256` pinned explicitly, audience and issuer
checked, identity taken only from verified claims.

The usual framing for that second check is "defense in depth". Here it is the **primary**
control, because the origin is reachable without going through Cloudflare at all. Verified
while planning this change:

```bash
curl -sk --resolve mashov.mitya.dev:443:<origin-ip> \
  https://mashov.mitya.dev/api/health
# -> 200 {"status":"ok"}
```

Anyone who knows the origin IP walks straight past the Access policy. So an Access-only
design would have published every parent's report, email included, to a port scan. Closing
the origin — Cloudflare IP ranges on 80/443, or the `cloudflared` connector already running
on that host — is a **required follow-up**, recorded with its verification command in
`docs/ops/admin-access-setup.md`. Until it is done, Access protects the admin page *shell*
and this guard protects the data.

The host firewall could not be read during planning (`sudo` needs a password), so the rule
set is unconfirmed; the reachability test above is the evidence.

### 6. Refusals are 403, never 401

`frontend/src/api/client.ts` turns a 401 into a hard redirect to the **parent** sign-in page.
A 401 from an admin route would therefore bounce the operator into a Mashov login they have
no account for, and read as a broken screen rather than a refused request. Every refusal —
missing, malformed, expired, wrong-audience, unreachable JWKS — collapses to the same 403 in
the project's error envelope, with the underlying `jose` reason never surfaced.

### 7. `@Public()` on the admin controller is not a hole

`AppSessionGuard` is a global `APP_GUARD` and demands a `mashov_session` cookie. An operator
does not have one. So `AdminFeedbackController` carries `@Public()` to stand that guard down,
and `@UseGuards(CloudflareAccessGuard)` as its real gate. Global guards run before route
guards, so the ordering holds and `@Public()` can only ever remove the *parent* check.

The same widening is needed one layer up: `frontend/src/middleware.ts` gains `/admin` and
`/api/v1/admin/` in `PUBLIC_PATHS`, where "public" means only "not gated by the parent
session cookie". Both sites carry a comment saying so, because `@Public()` on an admin
controller reads like a mistake.

Correspondingly, `/admin` is kept **out** of `lib/phase1-routes.ts` and out of `NAV_ITEMS` —
nothing parent-facing links there, and the omission is what stops a future in-app link from
rendering.

### 8. Fail-closed, with the fatal case narrowed to the unsafe one

`ADMIN_AUTH_MODE` defaults to `verify`. Two different kinds of bad configuration get two
different answers:

- **Unusable** — `verify` with no `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`. Nothing can be
  verified, so nothing is served: every admin request answers 403. **Not fatal.** Every dev
  stack is in this state, the values live in the Coolify UI, and taking the whole backend
  down — every parent-facing route with it — because an operator-only screen is unconfigured
  would be the wrong trade. A prod deploy that forgets them shows an operator a 403ing
  screen, which is loud enough and is safe.
- **Unsafe** — `ADMIN_AUTH_MODE=insecure-dev`, which skips verification outright. This
  **refuses to boot** unless `ENABLE_E2E_AUTH_BYPASS=1` is also set: two independent
  switches, both default off. The second is reused rather than invented, because
  `docker-compose.yml` already documents it as "must stay 0 everywhere else" and one concept
  with one meaning beats two flags an operator has to keep straight.

`NODE_ENV` is deliberately **not** part of either rule. This project's production compose
never sets it, so a `NODE_ENV !== 'production'` guard would pass in production — worse than
no guard, because it would read like one.

### 9. Triage state is two timestamps, and `readAt` is stamped by the GET

`readAt` on first detail open; `respondedAt` on an explicit button. The detail GET has a side
effect, which is unusual enough to be worth the comment it carries: the alternative is a
PATCH the client must remember to fire, which makes the `new` filter's correctness depend on
the UI. A report that stays "new" because a render path changed is exactly the failure this
feature exists to prevent. Both stamps are written once and never rewritten, so each stays
the answer to *when* rather than *most recently when*.

`awaiting` is `contactEmail IS NOT NULL AND respondedAt IS NULL` — a report with no reply
address can never be answered and must not sit in that lens forever.

### 10. The admin UI is standalone and English

No `AppShell`, no bottom nav, `dir="ltr"`. It is not part of the parent app and should not
inherit its chrome. One exception: the **subject** renders as its Hebrew label with the raw
code beside it. The parent picked "נתון שגוי או חסר" from a Hebrew select, and the report
should be read in the words they saw.

### 11. Feedback notifications go out as a **separate bot**

`FeedbackTelegramSender` subclasses `TelegramSender` and overrides one thing — the env var
holding the token, `FEEDBACK_TELEGRAM_BOT_TOKEN` instead of `TELEGRAM_BOT_TOKEN`.

As first shipped, the notifier sent through `TelegramSender`: the same bot that sends parents
their digests. That is a problem specific to this operator, who is **also a parent user of
this app**. Pointing `FEEDBACK_TELEGRAM_CHAT_ID` at their own DM interleaves every parent's
bug report with their own children's digests in one conversation.

Separating the *chat* alone would fix the interleaving. Separating the *bot* was chosen
because it also buys two things the chat split does not: a distinct sender identity, so a
report never looks like it came from the bot parents talk to, and credential independence —
revoking the feedback token cannot stop a parent's digest, and vice versa.

The mechanics that make this a four-line subclass rather than a duplicated sender:

- `tokenVar()` is a **method**, not a field. A field could be defeated by
  field-initialisation order in a subclass; a method read at send time cannot be. It is read
  at send time rather than construction for the same reason `hasToken()` exists — a stack can
  be configured after boot.
- Everything else is inherited and therefore has exactly one implementation: the chunking,
  the `proxy: false` axios instance that keeps a report off ADR-0023's Mashov-only residential
  hop, the token-on-the-path rule that keeps it out of `config.url` in log lines, and the
  redaction on the way out.
- **No fallback to `TELEGRAM_BOT_TOKEN`.** With the feedback token unset and the parent one
  set, nothing is sent. A quiet fallback is the one behaviour this split exists to prevent.
- The sender is **send-only**. The `getUpdates` long poll that handles a parent linking their
  account stays on the original token and is not duplicated — nothing ever replies to the
  feedback bot.

`FeedbackNotifierService` injects `FeedbackTelegramSender` by **concrete type**, not
`DigestSender`. Deliberate twice over: the concrete type carries `hasToken()`, and it makes
handing this service the parent-facing sender a compile error rather than a silent cross-wire.

Consequently `FeedbackModule` **drops `imports: [DigestModule]` entirely**. Subclassing a
class it imports needs no provider from that module, so the ADR-0023 bound this record already
claimed — import nothing that builds a Mashov axios client — gets easier to hold, not harder.
`feedback.module.spec.ts` asserts `TelegramSender` is *unresolvable* in this graph, so a
future re-import is a failing test rather than a one-typo cross-wire.

### 12. A failure about the **destination** does not spend the **row's** budget

A private Telegram channel refuses a bot that is not one of its admins with `bot is not a
member of the channel chat` or `need administrator rights in the channel chat`. A bot that
*is* an admin but lacks the Post Messages right — a separate toggle, and the likelier version
of the mistake — is refused with `not enough rights to send text messages to the chat`. None
of those phrases is in `PERMANENT_TELEGRAM_FAILURES`, so all of them classify as transient
under section 2: three attempts, six minutes, and then the row is retired permanently.

That is precisely the rollout order an operator will use. Set the two env vars, then go and
make the bot a channel admin — and in the gap, every report already waiting loses its
notification for good. The reports are not lost; they stay in the table and on
`/admin/feedback`. But nobody is ever pinged, and nothing says so.

So `feedback-notifier.service.ts` carries a **feedback-local** `isDestinationFailure()`,
checked **before** `isPermanentTelegramFailure()`, because the two lists overlap on "chat not
found" and the destination reading is the right one here: a chat id with a typo in it is a
setup mistake an operator fixes, not a dead recipient. It matches, against Telegram's own
description only:

- the chat does not resolve — `chat not found`, `group chat was upgraded` (a stale id after a
  migration);
- the bot is not in the channel or not an admin — `bot is not a member`, `need administrator
  rights`, `chat_admin_required`, `bot was kicked`;
- the bot is an admin without post rights — `not enough rights to send`,
  `chat_write_forbidden`, `have no rights to send a message`;
- the credential is wrong — `unauthorized`, `http 401`.

The last group is included deliberately, and it is the one that is about the *token* rather
than the chat. A token pasted with a trailing character is the same class of mistake as a
typo'd chat id, made in the same rollout window, with the same consequence — and unlike a 502
it never recovers on its own, so spending the three attempts on it only guarantees that the
reports already waiting are the ones that lose their notification. `hasToken()` already
catches a *missing* token before any send; this catches a *malformed* one.

The membership test is "is this about the address or the credential, or about this attempt?"
Everything about the transport — a 502, a 429, a reset socket, an `ok=false` with no
description — stays on the three-attempt path, because it recovers on its own and a row
retrying forever through a real outage is the worse trade. Only Telegram's description is
matched, never the report's text (`describeTelegramError` returns the description, an HTTP
status or an axios code — never the request body), so a parent cannot park their own report by
typing one of these phrases into the form.

On such a failure the
row **parks**: `notifyError` is recorded, `notifyAttempts` is left exactly as it was, and the
row stays pending. It delivers by itself on the first tick after the channel is fixed. Same
principle as the token gate in section 3 — a failure about the address must not consume the
budget of the rows addressed to it.

It logs **once per run**, not once per row, so a misconfigured channel cannot write one line
per pending report every two minutes.

The digest's classification is **not** changed and must not be. There the address is a
per-parent chat the parent themselves supplied, so a refusal means that recipient is gone and
*should* be retired — retrying forever would re-claim, re-summarize (a model call each time)
and re-send on every run. Here there is a single operator-owned address, no model call, and at
most 20 sends per two minutes against a table bounded at ten rows per household per hour. The
opposite rule, for the opposite blast radius.

**Accepted cost:** a destination that is permanently broken retries forever. Bounded and cheap
as above, logged once per run, and the stored `notifyError` renders on the admin detail view —
which is where an operator looks.

**Re-arming an already-retired row** is SQL, not a feature. PR #49's own local testing left
retired rows behind, and the runbook carries the statement:

```sql
UPDATE feedback SET "notifyAttempts" = 0, "notifyError" = NULL
WHERE "notifiedAt" IS NULL AND "notifyAttempts" >= 3;
```

An admin-UI re-arm button was considered and declined: one operator, one statement, and a
button needs a route, a guard, a mutation and a test for a thing that has happened once.

## Consequences

### Good

- A report reaches a human within ~2 minutes and survives a Telegram outage.
- The write path is untouched: no latency, no new failure mode, no changed tests.
- A failed delivery is visible on a screen, not only in a log.
- The schema change is five nullable/defaulted columns and one index — all expressible in
  Prisma, so `prisma db push` on boot creates them in production, and all idempotent DDL, so
  `boot-migrations.spec.ts` needs no new exemption.
- The admin surface is closed by default and on every misconfiguration short of an explicit
  request to disable it.
- A parent's bug report and that same operator's own children's digests are visibly separate
  streams from separate bots, and neither credential can break the other.
- A setup mistake during rollout — the vars set before the bot is a channel admin — costs
  nothing permanently. The reports wait, and the first tick after the fix delivers them.

### Bad / accepted

- **The origin is still open.** Until the firewall or tunnel work lands, the backend guard is
  the only control on the data. Tracked in the runbook with its verification command.
- **A duplicate message is possible.** If the send succeeds and stamping the row fails, the
  next tick re-sends. Chosen over the alternative: stamping first would lose a notification
  for a send that never happened, and for a notification a duplicate is cheap and a loss is
  not.
- **A retired row is forgotten by the notifier.** Nothing retries it and nothing alerts; it
  is visible only on the admin screen. Acceptable because the screen exists — which it did
  not when ADR-0044 declined to build the notification. Re-arming one is the SQL in section 12.
- **A permanently broken destination retries forever** (section 12) — the deliberate cost of
  not burning attempts on a channel nobody has finished configuring.
- **Two bot tokens to hold.** One more secret in the Coolify UI, and one more thing to get
  wrong. There is no fallback, so a *missing* feedback token sends nothing rather than sending
  as the parent-facing bot. A *present but invalid* one does attempt a send — it simply cannot
  reach any chat — and section 12 parks the row rather than charging it for that.
- **A parked row's `notifyAttempts` is not "untried".** Parking preserves whatever the row had
  already spent, so a row can be parked at 1 or 2 attempts, and the admin detail view renders
  a freshly parked one as "Not delivered after 0 attempt(s)" beside its destination error.
  Correct, and it reads oddly. The runbook's state table tells an operator to read
  `notifyError` first for exactly this reason.
- **The rate limit's race is unchanged**, and now so is the outbox's: two processes running
  this cron would both select the same row. There is one backend container, and the in-row
  `notifiedAt` makes a duplicate message rather than a lost one. Not worth a lock.
- **Retention is still unanswered, and now sharper.** There is a screen rendering a parent's
  name, username, email, schools and free text, kept forever. ADR-0044 left this open; this
  record restates it and still does not build a deletion job. That is the next thing to do
  here.

### Out of scope

No reply thread, no email sending, no per-subject routing, no queue, no second operator, no
roles model (`AppUser` gains no `role` column — the allowlist lives in Cloudflare). No change
to the parent-facing form, the rate limit, or the row shape the write path stores.
