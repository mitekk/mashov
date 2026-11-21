# Connect Telegram for children's updates — a parent-driven wizard in `/more`

## Context

The digest engine is already built and has never been reachable by a parent.
`backend/src/digest/` runs an hourly 13:00–19:00 Asia/Jerusalem cron that decides cheaply
whether a child has anything unreported, has an LLM write a Hebrew briefing, and delivers it
through `senders/telegram.sender.ts` to a chat id held in `digest_recipient.address`. Every
piece of that works and is spec-covered. What is missing is any way for a parent to say
"send it to me": there is **no frontend at all** (a grep for digest/telegram/recipient across
`frontend/src` finds only the slow-path proxy entry for `/api/v1/digest/runs`), and chat ids
can only be inserted by hand with `curl`, which is how the feature's own verification section
describes using it.

So delivery today is something an operator configures. It should be something a parent turns
on. The outcome this change aims at: a parent opens `עוד`, taps one row, and three screens
later their own Telegram is receiving their children's briefings — having typed nothing, and
without us ever touching their account.

Two constraints shape the design more than anything else.

**A Telegram bot can never start a conversation.** It may only message a chat that has already
pressed START on it. So the parent pressing START is unavoidable in any design; the only real
question is what happens to their chat id afterwards. Making them *also* find @userinfobot and
retype a number buys nothing and verifies nothing, which is why the chat id is read out of the
START itself.

**There is no inbound Telegram path in the repo.** The sender is outbound-only. Capturing a
chat id from a START is genuinely new ground here, and it is the part of this plan that needs
designing rather than wiring.

Alongside it, this change closes a hole the feature has carried since ADR-0026.
`DigestRecipientService.create` validates `studentGuid` only against the active roster, so
nothing stops one parent creating a recipient row for another family's child. That was an
accepted limitation while recipients were operator-only rows; the moment a UI creates them it
stops being acceptable, and `backend/src/common/student-links.ts` already has the helper
(`canSeeStudent`) that fixes it.

## Decisions

| Topic | Decision |
|---|---|
| Link model | One app bot, one-time deep link `https://t.me/<bot>?start=<code>`. Parent presses START; we read `message.chat.id` out of that update and bind it to the code's `userId`. Nothing to type. |
| Children | Chosen in the wizard — every child the caller can see, labelled by school, pre-ticked. One `digest_recipient` row per ticked child. Per-child toggles afterwards in `/more`. |
| Ownership | `DigestRecipientService.create` starts validating `studentGuid` against the caller's own visibility set (`canSeeStudent`), closing the ADR-0026 hole. |
| Proof | The last step sends a real confirmation message and shows the parent it landed, and says plainly when delivery is off or in dry-run. |

## The wizard

A route, not a modal, and one route with internal step state:
`frontend/src/app/more/telegram/{page.tsx,TelegramSetupPageClient.tsx}`.
`AddSchoolPageClient.tsx`'s own comment makes the case for the route ("real back-button
behaviour on a phone, a shareable URL, and a page object a test can drive, and `/more/...`
already passes the phase-1 route gate so nothing else has to change") — `/more/telegram`
inherits all of it, including `PHASE1_ROUTE_PATTERNS`' `/^\/more(?:[/?#].*)?$/`, so neither
`lib/phase1-routes.ts` nor `middleware.ts` needs touching.

Steps live in component state rather than in the URL, because the middle step is a *wait* on
an external action: a back button that returned to "press START" after the START had already
been consumed would offer a dead code. Step state is `useState`, and the only navigation out
is finishing or `router.back()`.

| Step | What it must get across | What NOT to say |
|---|---|---|
| 1 — What this is | One Hebrew message per child per afternoon, only when something actually happened; nothing is sent on a quiet day. Telegram is a free messaging app; if it is not installed, the next step's button opens the store. | Don't explain bots, chat ids, APIs, or tokens. A parent never needs those words. |
| 2 — Choose children | Every visible child, labelled with its school (`schoolShortLabel`), pre-ticked, with the school label shown only when the parent has more than one school. | Don't present it as a permission grant; it is "who do you want to hear about". |
| 3 — Press START | A single large button to the deep link, and a live "waiting for you" state that resolves itself. Says the code expires, and offers a fresh one when it does. | Don't ask them to copy anything, search for the bot by name, or come back and click "I did it" — the poll knows. |
| 4 — Confirmation | "A message has just been sent to your Telegram — check that it arrived." Names the children now subscribed, and links back to `/more`. If delivery is disabled or dry-run, says so in a parent's terms ("sending is currently turned off on this server") rather than claiming success. | Don't claim briefings will arrive if `DIGEST_ENABLED` is false. |

Copy is Hebrew RTL throughout, matching the existing `/more` voice. Every interactive element
gets a descriptive `data-testid` per `.claude/rules/frontend.md`, suffixed with a stable key
where repeated (`telegram-child-toggle-${studentGuid}`), following `SchoolLinksCard`'s
`settings-school-row-${link.semel}`.

### Entry point in `/more`

A new section between **Sync state** (`מצב סנכרון`) and **Account** (`חשבון`) in
`frontend/src/app/more/MorePageClient.tsx`, headed `עדכונים בטלגרם`, rendering a new
`frontend/src/components/more/TelegramCard.tsx` built on the `card-base divide-y divide-border`
row pattern:

- **Not connected** — one row, icon + "קבלו עדכונים יומיים בטלגרם" + a trailing link to
  `/more/telegram`.
- **Connected** — a row per subscribed child (name + class + school label) with a toggle
  writing `PATCH /digest/recipients/:id { enabled }`, plus a "הוספת ילד" row when some visible
  child has no row, and a "ניתוק" action. Disconnect reuses the page's established inline
  `role="dialog" aria-modal="true"` confirm-modal pattern with its own paired error state
  cleared through a single helper — the discipline `showUnlink`/`showDisconnect` enforce.

### Frontend data layer

- `frontend/src/api/telegram.ts` and `frontend/src/api/digest.ts` — thin `apiFetch` wrappers,
  modelled on `api/schoolLinks.ts`.
- `frontend/src/hooks/useDigestRecipients.ts` / `useTelegramLink.ts` — TanStack Query, modelled
  on `useSchoolLinks.ts`. The step-3 wait is a query with a `refetchInterval` that stops on
  resolution, the pattern `/auth/syncing` already uses against `GET /sync/status`.
- Types added to `frontend/src/types/api.ts` alongside the existing `ChildListItem`.
- Recipient mutations invalidate only the digest keys; this is not household-scoped state, so
  `invalidateHouseholdScopedQueries` is the wrong hammer here.

## Backend: capturing the chat id

### Long-polling, not a webhook

`getUpdates` long-polling, in a new `backend/src/telegram/` module.

A webhook needs a public HTTPS URL with a valid certificate that Telegram can reach. This
stack is local Docker — backend on `3001`, frontend on `3000`, behind NAT, with its only
outbound hop a residential tinyproxy (ADR-0023) — so there is nothing for Telegram to call.
Long-polling is outbound-only and needs no ingress at all.

The client must set `proxy: false`, for the reason `telegram.sender.ts` already documents:
`HTTPS_PROXY` is process-wide, and a parent's traffic must never cross the Mashov hop.

To switch to a webhook later: `setWebhook` with a secret header, add a `@Public()` route that
checks `X-Telegram-Bot-Api-Secret-Token`, and stop the poller. The two are **mutually
exclusive on one bot** — Telegram refuses `getUpdates` while a webhook is set — so whichever
runs, the other must be explicitly off.

### The offset needs no persistence

Passing `offset = lastUpdateId + 1` is what confirms updates; Telegram then drops them and
retains unconfirmed ones for 24 hours. So after a restart the poller is handed whatever it had
not confirmed, and **reprocessing is safe by construction**: matching a code is a conditional
update (`consumedAt: null` → set), and recipient writes are upserts. An in-memory offset is
therefore correct, and avoids both a Redis key that `allkeys-lru` may evict and a table whose
only job is a counter.

### The one-time code lives in Postgres

Not Redis. The parent may press START minutes later, possibly after closing the tab; Redis here
is `maxmemory 256mb` with `allkeys-lru` and no persistence, so an evicted code means a START
that matches nothing and a parent stuck on step 3. ADR-0017 already rules Redis out for durable
state, and we need `consumedAt` to make replay impossible and `chatId` for the wizard's poll to
answer at all.

```prisma
model TelegramLinkCode {
  id                  String    @id @default(cuid())
  code                String    @unique
  userId              String
  /** The children this link was minted for -- the parent's step-2 choice. */
  studentGuids        String[]
  expiresAt           DateTime
  consumedAt          DateTime?
  chatId              String?
  confirmationSentAt  DateTime?
  confirmationError   String?
  createdAt           DateTime  @default(now())

  user AppUser @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@map("telegram_link_code")
}
```
Plus `telegramLinkCodes TelegramLinkCode[]` on `AppUser`. `prisma db push` in the Dockerfile
CMD creates a brand-new table on boot, so **no migration file and no CMD change are needed** —
which also keeps `backend/src/prisma/boot-migrations.spec.ts` green.

**The code is a credential.** A guessed code binds the guesser's own chat to a victim's
`userId`, and they would then receive that family's children's behaviour reports. So:
`crypto.randomBytes(16).toString('hex')` (32 chars, well inside Telegram's 64-char `/start`
payload limit and its `A-Za-z0-9_-` alphabet), single-use, TTL 15 minutes, and the mint route
throttled.

**The code carries the intent.** Step 2's chosen children are client state, but the START
arrives server-side with no browser attached — so the chosen guids are sent when the code is
minted and stored on the row. Each is validated with `canSeeStudent` at mint time *and again*
at consume time, since the roster can change in between; a guid that is no longer visible is
skipped rather than failing the whole link.

### Flow

1. `POST /digest/telegram-links { studentGuids }` → validate, mint, return the code, the deep
   link and the bot's username.
2. Parent presses START. Telegram hands the poller `message.chat.id` and `/start <code>`.
3. The poller matches the code (unconsumed, unexpired), writes `chatId`, upserts one
   `digest_recipient` row per still-visible guid (`channel: 'telegram'`, `address: chatId`),
   then **sends the confirmation message immediately** through the existing `TelegramSender`
   and records `confirmationSentAt` or `confirmationError`.
4. The wizard's poll sees `status: 'linked'` and shows step 4.

Sending the confirmation server-side at the moment of linking is deliberate: it is the instant
the chat is proven reachable, and it means the wizard needs no extra "send me a test" route.

**`POST /digest/runs` must not be used as the test message** — independently of the above, it
would be the wrong tool. It has an in-process `running` guard that returns `[]` when a run is in
flight, it honours `DIGEST_DRY_RUN` (default true, so it would send nothing), on a genuinely
quiet day it correctly sends nothing — leaving the parent staring at a silent Telegram
concluding the link failed — and it consumes the dedup claims the 13:00 run needs.

### Bot username comes from the backend

`NEXT_PUBLIC_*` is inlined at **build** time by Next, so a bot username set as a runtime compose
env var would never reach the browser. It is read once from Telegram's own `getMe` and cached in
memory, which also means it cannot drift from whatever token is deployed. It is returned in the
mint response.

With no `TELEGRAM_BOT_TOKEN`, the mint route answers `503 TELEGRAM_NOT_CONFIGURED` and the
wizard says the server is not set up for Telegram — rather than rendering a `t.me/undefined`
link. The poller likewise logs once at startup and never loops.

### Files

| File | Role |
|---|---|
| `backend/src/telegram/telegram-http.ts` | Shared axios factory: `proxy: false`, token kept out of `baseURL`, `redact()`. Extracted from `telegram.sender.ts`, which starts using it — one place owns the proxy decision. |
| `backend/src/telegram/telegram.client.ts` | `getUpdates(offset, timeoutSeconds)`, `getMe()` (cached). |
| `backend/src/telegram/telegram-link.service.ts` | **All the logic**: `mint(userId, studentGuids)`, `statusFor(userId, code)`, `consume(update)`, `disconnect(userId)`. Lives in a `*.service.ts` because the 80% coverage gate excludes controllers, modules, tasks and `src/common/**`. |
| `backend/src/telegram/telegram-poller.service.ts` | The loop only — `onModuleInit` starts a self-rescheduling long poll (`timeout=30`), delegating each update to `telegram-link.service`. Skipped when the token is absent or `NODE_ENV === 'test'`. |
| `backend/src/telegram/telegram.controller.ts` | Routes below. |
| `backend/src/telegram/telegram.module.ts` | Imports `PrismaModule`; provides the above; imported by `DigestModule` (for `TelegramSender`) or exports its client to it. Like `DigestModule`, it must import nothing that builds a Mashov axios client. |

Keeping the loop and the logic in separate services is what makes this testable: specs
instantiate `TelegramLinkService` and call `consume()` with a hand-built update object, with no
timer and no network anywhere.

### Routes

Per `.claude/rules/api.md` — `/api/v1`, plural nouns, no verbs in paths, string ids, the
`{ error: { code, message, details } }` envelope. All behind the global `AppSessionGuard`.

| Method | Path | Body | Response | Codes |
|---|---|---|---|---|
| POST | `/api/v1/digest/telegram-links` | `{ studentGuids: string[] }` | `{ data: { code, deepLink, botUsername, expiresAt } }` | 201, 400, 401, 403, 429, 503 |
| GET | `/api/v1/digest/telegram-links/:code` | — | `{ data: { status: 'pending' \| 'linked' \| 'expired', linkedAt, recipientCount, confirmationSent, confirmationError } }` | 200, 401, 404 |
| DELETE | `/api/v1/digest/telegram-links` | — | — | 204, 401 |
| GET | `/api/v1/digest/recipients` | — | `{ data: DigestRecipient[] }` | 200, 401 |

The GET by code is additionally scoped to the caller's `userId`, so a code is never a bearer
token for another user's status. DELETE removes the caller's `telegram` recipient rows (per-child
off stays the existing `PATCH /digest/recipients/:id`).

The last row is a **one-word change to an existing route**: `RecipientQueryDto.studentGuid`
becomes `@IsOptional()`, and `listFor` becomes `list({ userId, studentGuid? })`, so the `/more`
card can ask "what am I subscribed to" without naming a child. Child names, classes and school
labels are joined client-side from the already-cached `useChildren()` — no new read route and no
server-side join.

### The ownership fix

`DigestRecipientService.create` currently accepts any `studentGuid` on the active roster. It
starts calling `canSeeStudent(prisma, userId, studentGuid)` from
`backend/src/common/student-links.ts` instead. Both the ADR-0026 limitation paragraph and
`docs/api-contract.md` note 9 describe the hole as accepted, so both must be corrected in the
same change rather than left contradicting the code.

## Tasks

TDD throughout, per `.claude/rules/testing.md`: the failing test comes first in every task.
Start on a fresh branch off `master` — the working tree currently carries unrelated
parent-name/profile work on `fix/clear-stale-source-health`.

| # | Task | Files | Verify | Commit |
|---|---|---|---|---|
| 1 | Close the ownership hole | `digest-recipient.service.{ts,spec.ts}`, ADR-0026, `docs/api-contract.md` | `cd backend && npx jest src/digest/digest-recipient` | `fix(digest): scope recipient creation to the caller's own children` |
| 2 | Schema + shared HTTP | `prisma/schema.prisma`, `src/telegram/telegram-http.ts`, `senders/telegram.sender.ts` (+ spec stays green) | `npx prisma generate && npx tsc --noEmit && npx jest src/digest/senders` | `feat(telegram): add link-code table and a shared bot HTTP client` |
| 3 | Mint + status + disconnect, and prune dead codes | `telegram-link.service.{ts,spec.ts}`, `digest-retention.service.{ts,spec.ts}` | `npx jest src/telegram/telegram-link src/digest/digest-retention` | `feat(telegram): mint and resolve one-time link codes` |
| 4 | Consume a START | same service + spec: happy path, expired, consumed, replay, unknown code, bare `/start`, a guid gone from the roster, confirmation-send failure | `npx jest src/telegram/telegram-link` | `feat(telegram): bind a chat to a parent from the start payload` |
| 5 | Client, poller, module | `telegram.client.ts`, `telegram-poller.service.ts`, `telegram.module.ts`, `app.module.ts` | `npx tsc --noEmit && npx jest src/telegram` | `feat(telegram): poll for start messages when a bot token is set` |
| 6 | Controller + contract | `telegram.controller.ts`, `digest.controller.ts` (optional `studentGuid`), `docs/api-contract.md` | `npx tsc --noEmit` in `backend/` | `feat(telegram): expose link, status, and disconnect endpoints` |
| 7 | Frontend data layer | `api/telegram.ts`, `api/digest.ts`, `hooks/useTelegramLink.ts`, `hooks/useDigestRecipients.ts`, `types/api.ts` | `cd frontend && npx tsc --noEmit` | `feat(more): add telegram link api client and hooks` |
| 8 | The wizard | `app/more/telegram/{page.tsx,TelegramSetupPageClient.tsx}` + `.test.tsx` | `cd frontend && npm test` | `feat(more): add a guided telegram setup wizard` |
| 9 | `/more` entry + toggles | `components/more/TelegramCard.{tsx,test.tsx}`, `MorePageClient.tsx` | `cd frontend && npm test && npx tsc --noEmit` | `feat(more): show telegram subscriptions and per-child toggles` |
| 10 | Integration | `tests/integration/telegram-link.test.ts` | `npm run test:integration` | `test(telegram): cover linking, replay, and cross-household refusal` |
| 11 | Env, docs, ADR | `docker-compose.yml`, `.env.example`, `backend/.env.example`, `README.md`, `docs/adr/0033-*.md`, `docs/adr/README.md`, `docs/ops/digest-local-test.md` | `npm run lint` | `docs(telegram): record the parent-driven link decision` |

New env vars (all optional, with inline defaults at the read site — the existing pattern; no zod
anywhere in this repo): `TELEGRAM_LINK_CODE_TTL_MINUTES` (15), `TELEGRAM_POLL_TIMEOUT_SECONDS`
(30), `TELEGRAM_POLL_ENABLED` (defaults on, but inert without a token).
`TELEGRAM_BOT_TOKEN` already exists in `docker-compose.yml`.

ADR-0033 records: why the parent links their own account rather than an operator doing it; why
long-polling over a webhook here and what would change that; why the code is a Postgres row and
not a Redis key; the code-as-credential threat and the 16-byte answer; and that this supersedes
ADR-0026's recipient-ownership limitation.

`docs/ops/digest-local-test.md` §4 currently tells an operator to read their chat id from
`getUpdates` by hand and `UPDATE digest_recipient` with psql. That is exactly the procedure this
feature replaces, so it is rewritten to point at the wizard.

## Verification

```bash
# Unit — both sides
cd backend && npm run lint && npm run typecheck && npm test   # 80% line gate
cd frontend && npm run lint && npm run typecheck && npm test

# Integration, against real Postgres
npm run test:integration

# Whole stack
docker compose up --build
```

End to end, by hand — the only way to prove the parts that no test can:

1. Get a bot token from @BotFather, put `TELEGRAM_BOT_TOKEN=…` and `DIGEST_ENABLED=true`,
   `DIGEST_DRY_RUN=false` in `.env`, `docker compose up --build`.
2. Sign in, open `עוד` → the new `עדכונים בטלגרם` row → the wizard.
3. Pick children, tap the deep link **on a phone**, press START.
4. Confirm: the wizard flips to step 4 by itself, the confirmation message arrives in Telegram,
   and the Hebrew renders right-to-left correctly in the real client — the one thing a log
   cannot show (the same reason `docs/ops/digest-local-test.md` gives).
5. `curl -X POST …/api/v1/digest/runs -d '{}'` and confirm a real briefing lands for the picked
   children only.
6. Press START again → no duplicate rows, a friendly "already connected" reply.
7. Toggle one child off in `/more`, re-run, confirm that child is no longer included.
8. Restart the backend mid-link (between minting and START) and confirm the START still lands —
   the in-memory offset's 24-hour safety net.
9. With `DIGEST_ENABLED=false`, confirm step 4 says sending is off rather than promising
   briefings.
10. Sign in as a second parent and confirm they cannot create a recipient for the first
    parent's child (the task-1 fix), nor read their delivery history.

## Risks

| Risk | Handling |
|---|---|
| **The link code is a credential** — a guessed code redirects a family's briefings to a stranger. | 16 random bytes, single-use, 15-minute TTL, throttled mint, `consumedAt` checked in the same conditional update. |
| **Connected but silent** — `DIGEST_ENABLED` is false by default, so a parent could finish the wizard and never hear anything. | Step 4 reads the real flags and says so plainly; the confirmation message is sent by the link path, not the digest cron, so it arrives regardless. |
| **Webhook/`getUpdates` exclusivity** — a webhook set once on the bot silently breaks polling. | ADR-0033 states only one may be active; the poller logs Telegram's 409 as a configuration error rather than retrying blindly. |
| **Two backend replicas** both polling → Telegram 409s. | Same single-replica assumption `inFlightManualRefreshByConnection` already documents; stated in the ADR, not silently inherited. |
| **A parent abandons the wizard mid-link.** | Codes expire and the wizard offers a fresh one. `DigestRetentionService.prune()` currently deletes from `digest_reported_item` and `digest_delivery` only, so task 3 adds a third `deleteMany` for codes — on a much shorter cutoff than the 90-day `RETENTION_DAYS` (7 days, since a code is dead the moment it is consumed or expires). It rides the existing `30 2 * * *` cron, which is not gated on `DIGEST_ENABLED`. |
| **The poller crash-looping without a token** — the default deployment has none. | Token absence is checked before the loop starts; it logs once and stays inert. |
| **A parent's chat id is personal data** now stored per child. | It already was (`digest_recipient.address`); DELETE removes every row, and ADR-0026's note about `ops/` having no secrets-management path still stands. |

## Deliberately not in a first version

- Per-parent scheduling or quiet hours — the window stays `DIGEST_ENABLED`-wide.
- A "resend the test message" button in `/more` (`POST /digest/telegram-tests`).
- Any channel but Telegram, though `DigestSender` already makes that a config change.
- Delivery history in the UI — `GET /digest/deliveries` exists and stays unused for now.
- A webhook path.
- Letting a parent bring their own BotFather bot.
