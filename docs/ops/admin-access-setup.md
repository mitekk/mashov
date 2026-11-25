# Admin access setup — Cloudflare Access for `/admin`

Human-only steps. Nothing here can be scripted from this repo: the secrets go
into the Coolify UI, and the smoke test at the end requires passing a
Cloudflare Access login in a browser.

Related: [ADR-0045](../adr/0045-operator-feedback-delivery-and-admin-access.md).

---

## What is being protected

`/admin/feedback` (the page) and `/api/v1/admin/*` (its data) are the operator
triage surface for parent feedback. Every row carries a parent's display name,
their Mashov username, their schools and — usually — their email address.

There are two gates and they are **not** equally important:

| Gate | Protects | Status |
|---|---|---|
| Cloudflare Access policy on `/admin` and `/api/v1/admin` | traffic arriving *through* Cloudflare | convenience + the page shell |
| `CloudflareAccessGuard` in the backend | **every** request that reaches the origin | the real boundary |

The second one is the one that holds, because **the origin is directly
reachable** — see [step 6](#6-close-the-origin-required-follow-up).

---

## 1. The two Access applications

**These already exist** — created 2026-11-24 on account
`7cd3858e35280ca7938d9fc91fb03b15`. This section records what they are, so the
set-up can be audited, repaired or rebuilt.

| Application name | Domain (incl. path) | Application ID | App launcher |
|---|---|---|---|
| `mashov-admin-ui` | `mashov.mitya.dev/admin` | `cf5fa159-6009-43a1-b9dc-4b26f80a4ac0` | visible |
| `mashov-admin-api` | `mashov.mitya.dev/api/v1/admin` | `677a032c-f48e-4e8a-ba8d-0f483e0c555e` | hidden |

Both are `self_hosted`, session duration `24h`, `auto_redirect_to_identity`
on, restricted to the **one-time PIN** identity provider
(`055f09a1-dec3-40be-9d10-41c892c3fe48`) — matching the `campaign admin` app
already on this account.

Both reference **one reusable policy** rather than two copies of the same rule:

| Policy name | Policy ID | Decision | Include |
|---|---|---|---|
| `mashov-admin-operators` | `6a544aef-5f1a-43b8-90b3-2525d5bac011` | `allow` | Emails: the operator address |

Two applications and one policy, deliberately. The page and its API are
separate paths, so one application cannot cover both; a reusable policy means
the allowlist is edited in one place and cannot drift between them. The policy
is named for what it guards, not `allow` — this account holds other policies
and a bare `allow` would be unreadable in the list.

**To add or remove an operator**, edit that one policy: Zero Trust → Access →
Policies → `mashov-admin-operators` → Include → Emails. Both applications pick
the change up; nothing needs redeploying, because the allowlist lives in
Cloudflare and not in the app (ADR-0045: no roles model, no `AppUser.role`).

To rebuild from scratch, create two `self_hosted` applications with the domains
above and attach one reusable `allow` policy to each via
`POST /accounts/{account_id}/access/policies` then
`POST /accounts/{account_id}/access/apps` with
`policies: [{ id, precedence: 1 }]`. Do **not** inline an app-scoped policy —
those report `reusable: false` and are the legacy shape.

## 2. The AUD tags and the JWKS

Each application has its **own** Application Audience (AUD) tag:

| Application | AUD tag |
|---|---|
| `mashov-admin-ui` | `33247b2323bcfa4091a0797da7a81a10a5e77f85395481ab3875112d844892b2` |
| **`mashov-admin-api`** | **`efd01ef8d189ecdaccfe6ac9dca2bd7bfb160e88096655a561b2e06656258f6c`** |

**`ACCESS_AUD` takes the API one.** That is the audience of the token the
backend actually receives, and taking the UI one instead is the single easiest
mistake to make here: the page loads perfectly and every list request 403s,
with nothing in the Cloudflare logs to explain it.

Neither tag is a secret — Access publishes the matching one as `kid=` in its
own unauthenticated login redirect (see step 4), which is also how to check
which application is covering a path.

The team domain is **`https://young-poetry-2f7a.cloudflareaccess.com`**
(Zero Trust → Settings shows the team name).

The key set is reachable and non-empty:

```bash
curl -s https://young-poetry-2f7a.cloudflareaccess.com/cdn-cgi/access/certs \
  | jq '{n: (.keys|length), algs: [.keys[].alg]|unique}'
# -> { "n": 2, "algs": ["RS256"] }
```

Verified 2026-11-24. If this ever returns `0` or fails, the backend refuses
every request with 403 and the cause will not be obvious from the screen. The
guard pins `RS256` and will not follow the JWKS onto a weaker algorithm.

## 3. Set the backend variables

Coolify → the `backend` service → **Environment Variables**:

```
ADMIN_AUTH_MODE=verify
ACCESS_AUD=efd01ef8d189ecdaccfe6ac9dca2bd7bfb160e88096655a561b2e06656258f6c
ACCESS_TEAM_DOMAIN=https://young-poetry-2f7a.cloudflareaccess.com
FEEDBACK_TELEGRAM_BOT_TOKEN=<the FEEDBACK bot's token — see "Feedback notifications" below>
FEEDBACK_TELEGRAM_CHAT_ID=<the private channel's -100... id>
```

`ACCESS_TEAM_DOMAIN` needs the `https://` scheme and no trailing slash — it is
compared against the token's `iss` claim. Also confirm `PUBLIC_BASE_URL` is
`https://mashov.mitya.dev`, or the Telegram notification arrives without its
deep link.

Notes:

- `ADMIN_AUTH_MODE` **defaults to `verify`**, so this line is belt-and-braces.
- With `verify` set and the two `ACCESS_*` values missing, the backend still
  boots and every `/api/v1/admin/*` call answers **403**. Closed, not open, and
  not fatal — a misconfigured admin screen must not take the parent-facing app
  down with it.
- `ADMIN_AUTH_MODE=insecure-dev` skips JWT verification entirely and **refuses
  to boot** unless `ENABLE_E2E_AUTH_BYPASS=1` is also set. Both must stay unset
  in production. That combination exists for the e2e run only.
- `FEEDBACK_TELEGRAM_BOT_TOKEN` and `FEEDBACK_TELEGRAM_CHAT_ID` are the whole
  switch for the notifier: both set means on, either missing means off,
  silently. There is no `FEEDBACK_NOTIFY_ENABLED`. **The bot token is a
  different bot from `TELEGRAM_BOT_TOKEN`** — see the next section, which is
  where you create it.
- `PUBLIC_BASE_URL` must already be set for the Telegram message to carry a
  deep link. Unset, the message still arrives and simply has no link line.

Redeploy the backend.

## 4. Smoke test

First, with no browser — confirm Access is in front of both paths, and that
each path is covered by the application you think it is. The `kid=` in the
redirect **is** that application's AUD tag, so this also checks the pairing:

```bash
for p in /admin/feedback /api/v1/admin/feedback; do
  curl -s -o /dev/null -D - "https://mashov.mitya.dev$p" \
    | sed -n 's/^location: .*[?&]kid=\([0-9a-f]*\).*/'"$p"' -> kid=\1/p'
done
```

Expected (verified 2026-11-24 — both answered `HTTP/2 302`):

```
/admin/feedback          -> kid=33247b23...  (mashov-admin-ui)
/api/v1/admin/feedback   -> kid=efd01ef8...  (mashov-admin-api)
```

A `200` from either path means Access is **not** covering it. Check a
parent-facing route is untouched too: `/api/health` must still answer `200`.

Then, in a browser:

1. Open `https://mashov.mitya.dev/admin/feedback` in a private window — **the
   page, not the API.** Order matters: authenticating against the UI
   application sets the `CF_Authorization` cookie for the whole host, which
   then satisfies the API application. Hitting an API URL first gets a 302 to
   a login page an XHR cannot follow, which looks like a broken screen.
2. Cloudflare Access should present its login — a one-time PIN mailed to the
   address, since that is the only identity provider these applications
   accept. Sign in with an allowlisted address.
3. The triage list should render with data. **If the page renders but every
   list request 403s**, the JWT is reaching the backend and failing
   verification — re-check `ACCESS_AUD` against the *API* application's tag.
4. Confirm the three filters, that opening a row clears its "New" chip, and
   that "Mark as answered" empties the awaiting-response lens.

**Signing out** is a full-page navigation to
`https://mashov.mitya.dev/cdn-cgi/access/logout` — type it in the address bar.
It cannot be an in-app XHR: Access answers it with a 302 to a login page that
fetch cannot usefully follow.

## 5. Feedback notifications — the bot and the channel

Reports are delivered by a **separate bot** from the one that sends parents
their digests, into a **private channel** rather than anyone's DM. The reason
is that the operator is also a parent user of this app: one bot pointed at the
operator's own DM interleaves every parent's bug report with that operator's
own children's digests in a single conversation. See
[ADR-0045 §11](../adr/0045-operator-feedback-delivery-and-admin-access.md).

There is **no fallback** to `TELEGRAM_BOT_TOKEN`. With the feedback token unset
and the parent-facing one set, nothing is sent — on purpose.

### 1. Create the bot

In Telegram, talk to **@BotFather**:

```
/newbot
  name:     Mashov Feedback
  username: <something>_feedback_bot
```

BotFather replies with the token. That value is `FEEDBACK_TELEGRAM_BOT_TOKEN`.
Do not reuse the parent-facing bot's token, and do not put this one anywhere
the parent-facing bot's token lives.

Nothing ever replies to this bot, so there is nothing else to configure on it:
no commands, no privacy setting, no webhook. The `getUpdates` long poll that
handles a parent linking their account stays on the original bot.

### 2. Create the private channel

Telegram → **New Channel** → name it (e.g. `Mashov feedback`) → **Private**.
Do not set a public link.

### 3. Add the bot as an administrator — do not skip this

Channel → **Administrators** → **Add Admin** → search the bot's `@username` →
add it with **Post Messages** granted. The rest of the admin rights can be off.

**Post Messages** is its own toggle, and getting *that* wrong looks different
from forgetting the step entirely: an admin without it is refused with `not
enough rights to send text messages to the chat` rather than `need
administrator rights`. Both park the row, so neither is destructive — but they
point at different boxes in the Telegram UI.

This is the step whose omission used to cost reports. A private channel refuses
a non-admin bot with `bot is not a member of the channel chat` or `need
administrator rights in the channel chat`, and neither phrase classifies as a
permanent Telegram failure — so before
[ADR-0045 §12](../adr/0045-operator-feedback-delivery-and-admin-access.md) the
outbox read it as transient, spent all three attempts in six minutes and
**retired every report already waiting, permanently**. The rows survived in the
table and on `/admin/feedback`; nobody was ever pinged.

Now such a refusal **parks** the row instead: the error is recorded, no attempt
is charged, and the row stays pending — so getting this step wrong, or doing it
late, costs nothing. Delivery resumes by itself on the first tick after the bot
becomes an admin. The ordering here is still the one to follow, because it means
you never see the parked state at all.

### 4. Read the channel's chat id

Post any message in the channel, then forward that message to **@userinfobot**
(or **@JsonDumpBot**) — it reports the origin chat's id. A channel id looks like
`-1001234567890`: the leading `-100` is part of the value, so keep it.

Alternatively, with the token in hand:

```bash
curl -s "https://api.telegram.org/bot<FEEDBACK_TOKEN>/getUpdates" \
  | jq '.result[].channel_post.chat | {id, title}'
```

That only works if the bot is already an admin and something has been posted
since; the forward trick is more reliable.

### 5. Set the two variables and redeploy

Both go on the `backend` service in Coolify, as in
[step 3](#3-set-the-backend-variables):

```
FEEDBACK_TELEGRAM_BOT_TOKEN=<BotFather's token>
FEEDBACK_TELEGRAM_CHAT_ID=-1001234567890
```

Redeploy. Within ~2 minutes of the next report (the cron is `*/2`), the message
arrives in the channel.

### 6. Verify

```bash
# On the Coolify host, against the backend's database:
#   pending rows, and why any of them is stuck
psql "$DATABASE_URL" -c 'SELECT id, "createdAt", "notifiedAt", "notifyAttempts", "notifyError" FROM feedback ORDER BY "createdAt" DESC LIMIT 10;'
```

What the states mean:

`notifyAttempts` alone does **not** tell you whether a row is parked or
retrying — parking preserves whatever attempts the row had already spent, so a
row that hit two 502s and then had the bot removed from the channel sits at
`notifyAttempts` 2 *and* is parked. Read `notifyError` first:

| Row state | Meaning |
|---|---|
| `notifiedAt` set | delivered. `notifyAttempts` is how many tries it took. The happy path. |
| `notifiedAt` null, `notifyError` matches a destination phrase¹ | **parked**, at any `notifyAttempts` value. Nothing is being charged; fix the channel, the chat id or the token and it delivers itself on the next tick. |
| `notifiedAt` null, `notifyAttempts` 1–2, `notifyError` is a transport error (`HTTP 502`, `Too Many Requests`, a socket error) | a transient failure. The next tick retries. |
| `notifiedAt` null, `notifyAttempts` 3 | **retired.** Nothing will retry it. Re-arm below. Can only be reached by transport failures, never by a parked one. |
| `notifiedAt` null, `notifyAttempts` 0, `notifyError` null | nothing has tried yet — usually means the two vars are not both set. |

¹ The parking phrases, as matched case-insensitively against Telegram's own
description: `chat not found`, `group chat was upgraded`, `bot is not a
member`, `need administrator rights`, `chat_admin_required`, `bot was kicked`,
`not enough rights to send`, `chat_write_forbidden`, `have no rights to send a
message`, `unauthorized`, `http 401`. The list lives in
`backend/src/feedback/feedback-notifier.service.ts`.

A parked destination logs **once per run**, not once per row, so grep the
backend log for `Feedback notification parked` — one line tells you about every
row stuck behind the same problem.

Note that the admin detail view renders a parked row as "Not delivered after
*N* attempt(s)" using that same preserved count, so a freshly parked row reads
as "after 0 attempt(s)" next to its error. That is the parking rule working,
not a row nothing has tried.

### Re-arming retired rows

Rows retired before the parking rule existed (PR #49's own local testing left
some) will never be retried. One statement, run against the backend's database:

```sql
UPDATE feedback SET "notifyAttempts" = 0, "notifyError" = NULL
WHERE "notifiedAt" IS NULL AND "notifyAttempts" >= 3;
```

Only do this once the channel is actually working, or the rows simply park
again — harmless, but pointless. There is deliberately no re-arm button in the
admin UI: one operator, one statement.

---

## 6. Close the origin (required follow-up)

The Hetzner/Coolify box answers HTTPS for `mashov.mitya.dev` on its own IP,
bypassing Cloudflare and therefore bypassing the Access policy entirely.
Verified in this session:

```bash
curl -sk --resolve mashov.mitya.dev:443:<origin-ip> \
  https://mashov.mitya.dev/api/health
# -> 200 {"status":"ok"}
```

Until that stops returning 200, the Access policy protects the admin **page
shell** only, and `CloudflareAccessGuard` is the sole thing protecting the
data. Two ways to fix it:

- **Firewall**: restrict inbound 80/443 to
  [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/), or
- **Tunnel**: move `mashov.mitya.dev` behind the `cloudflared` connector
  already running on that host (`pgrep -a cloudflared` shows two processes) and
  close 80/443 to the internet.

**Verification that it is done:** the `curl` above must stop answering 200
(connection refused or timeout), while `https://mashov.mitya.dev/api/health`
through Cloudflare keeps answering 200.

The host firewall could not be read during planning (`sudo` needs a password),
so the current rule set is unconfirmed — the reachability test above is the
evidence, and it is the test to re-run.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Browser lands on the **parent** sign-in page | `/admin` missing from `PUBLIC_PATHS` in `frontend/src/middleware.ts` |
| Every admin call 403s, page shell loads | `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` wrong, unset, or the JWKS is unreachable |
| Admin calls answer **401** | something other than `CloudflareAccessGuard` refused it; a 401 makes `apiFetch` redirect to parent sign-in, so this is always a bug |
| Backend will not boot | `ADMIN_AUTH_MODE=insecure-dev` without `ENABLE_E2E_AUTH_BYPASS=1`; the log line names both |
| Reports arrive but carry no link | `PUBLIC_BASE_URL` unset or not an `https`/localhost origin |
| No Telegram messages at all | `FEEDBACK_TELEGRAM_BOT_TOKEN` or `FEEDBACK_TELEGRAM_CHAT_ID` unset — by design, and silent. Check `feedback.notifyAttempts` / `notifyError` for the other case |
| `notifyError` says "bot is not a member" / "need administrator rights" | the bot is not an admin of the channel — [step 5.3](#3-add-the-bot-as-an-administrator--do-not-skip-this). The rows are parked, not lost; they deliver themselves once it is |
| `notifyError` says "chat not found" | `FEEDBACK_TELEGRAM_CHAT_ID` wrong — most often the `-100` prefix dropped. Also parked, not retired |
| `notifyError` says "not enough rights to send" / "CHAT_WRITE_FORBIDDEN" | the bot is a channel admin but **Post Messages** is off — [step 5.3](#3-add-the-bot-as-an-administrator--do-not-skip-this). Parked, not lost |
| `notifyError` says "Unauthorized" or "HTTP 401" | `FEEDBACK_TELEGRAM_BOT_TOKEN` wrong or revoked. Also parked — a bad credential never recovers on its own, so spending attempts on it would only lose the reports already waiting |
| `notifyError` says "group chat was upgraded" | the channel was migrated and `FEEDBACK_TELEGRAM_CHAT_ID` is now stale. Re-read the id ([step 5.4](#4-read-the-channels-chat-id)). Parked |
| Reports arrive in a parent's digest chat | the feedback chat id points at a parent-linked chat, or something re-wired the notifier onto `TelegramSender`. `feedback.module.spec.ts` asserts the latter cannot resolve |
