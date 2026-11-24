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
reachable** — see [step 5](#5-close-the-origin-required-follow-up).

---

## 1. Create the two Access applications

Cloudflare dashboard → **Zero Trust → Access → Applications → Add an
application → Self-hosted**, twice:

| Application name | Domain | Path |
|---|---|---|
| `mashov-admin-ui` | `mashov.mitya.dev` | `admin` |
| `mashov-admin-api` | `mashov.mitya.dev` | `api/v1/admin` |

Both reference **one reusable policy** rather than two copies of the same rule:

- **Policies → Add a policy → Reuse policy**, name `allow`
- Action: **Allow**
- Include → **Emails** → the operator address(es)

Two applications and one policy, deliberately. The page and its API are
separate paths, so one application cannot cover both; a reusable policy means
the allowlist is edited in one place and cannot drift between them.

## 2. Read the AUD tag and verify the JWKS

On either application's **Overview** tab, copy the **Application Audience (AUD)
Tag** — a 64-character hex string. Both applications have their own AUD; use
**the API one** (`mashov-admin-api`), because that is the token the backend
verifies.

The team domain is `https://<team>.cloudflareaccess.com` (Zero Trust →
Settings → Custom Pages shows the team name).

Confirm the key set is reachable and non-empty before setting anything:

```bash
curl -s https://<team>.cloudflareaccess.com/cdn-cgi/access/certs | jq '.keys|length'
# -> 2   (any number >= 1 is fine)
```

If this returns `0` or fails, stop: the backend will refuse every request with
403 and the cause will not be obvious from the screen.

## 3. Set the backend variables

Coolify → the `backend` service → **Environment Variables**:

```
ADMIN_AUTH_MODE=verify
ACCESS_AUD=<the 64-char AUD tag from step 2>
ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
FEEDBACK_TELEGRAM_CHAT_ID=<the operator chat id>
```

Notes:

- `ADMIN_AUTH_MODE` **defaults to `verify`**, so this line is belt-and-braces.
- With `verify` set and the two `ACCESS_*` values missing, the backend still
  boots and every `/api/v1/admin/*` call answers **403**. Closed, not open, and
  not fatal — a misconfigured admin screen must not take the parent-facing app
  down with it.
- `ADMIN_AUTH_MODE=insecure-dev` skips JWT verification entirely and **refuses
  to boot** unless `ENABLE_E2E_AUTH_BYPASS=1` is also set. Both must stay unset
  in production. That combination exists for the e2e run only.
- `FEEDBACK_TELEGRAM_CHAT_ID` is the only switch for the notifier. Unset means
  no messages, silently. There is no `FEEDBACK_NOTIFY_ENABLED`.
- `PUBLIC_BASE_URL` must already be set for the Telegram message to carry a
  deep link. Unset, the message still arrives and simply has no link line.

Redeploy the backend.

## 4. Smoke test, in a browser

1. Open `https://mashov.mitya.dev/admin/feedback` in a private window.
2. Cloudflare Access should present its login. Sign in with an allowlisted
   address.
3. The triage list should render with data. **If the page renders but every
   list request 403s**, the JWT is reaching the backend and failing
   verification — re-check `ACCESS_AUD` against the *API* application's tag.
4. Confirm the three filters, that opening a row clears its "New" chip, and
   that "Mark as answered" empties the awaiting-response lens.

**Signing out** is a full-page navigation to
`https://mashov.mitya.dev/cdn-cgi/access/logout` — type it in the address bar.
It cannot be an in-app XHR: Access answers it with a 302 to a login page that
fetch cannot usefully follow.

## 5. Close the origin (required follow-up)

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
| No Telegram messages at all | `FEEDBACK_TELEGRAM_CHAT_ID` unset — by design, and silent. Check `feedback.notifyAttempts` / `notifyError` for the other case |
