# ADR-0033: A Parent Links Their Own Telegram, From a One-Time Code We Read Out of the START

- **Date**: 2026-11-21
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent
- **Supersedes**: [ADR-0026](0026-outbound-digest-delivery-and-llm-egress.md)'s accepted
  recipient-ownership limitation ("nothing stops user A creating a recipient row for user B's
  child")
- **Builds on**: [ADR-0031](0031-child-visibility-is-a-set-of-connections.md) (the
  `StudentConnection` link set), [ADR-0017](0017-caching-strategy-conditional-redis.md) (no
  durable state in Redis), [ADR-0023](0023-bounding-mashov-egress-abortsignal.md) (the Mashov
  egress hop)
- **Implemented by**: `backend/src/telegram/`,
  `frontend/src/app/more/telegram/`,
  `frontend/src/components/more/TelegramCard.tsx`,
  `tests/integration/telegram-link.test.ts`

## Context and Problem Statement

ADR-0026 built the digest engine and never gave a parent a way to reach it. The hourly cron,
the cheap checker, the LLM summarizer, the Telegram sender — all of it works and all of it is
spec-covered, and all of it keys off `digest_recipient.address`, a Telegram chat id that could
only get into the database by hand. `docs/ops/digest-local-test.md` said so plainly: read your
chat id out of `getUpdates` yourself, then `UPDATE digest_recipient` with psql.

So delivery was something an operator configured. It should be something a parent turns on.

Two constraints shaped the design more than anything else.

**A Telegram bot can never start a conversation.** It may only message a chat that has already
pressed START on it. The parent pressing START is therefore unavoidable in *any* design; the
only real question is what happens to their chat id afterwards.

**There was no inbound Telegram path in the repo at all.** `TelegramSender` is outbound-only.
Capturing a chat id from a START was genuinely new ground.

## Decision

A parent opens `עוד` → `עדכונים בטלגרם`, picks which children to hear about, taps one button
to `https://t.me/<bot>?start=<code>`, and presses START. A long poller reads
`message.chat.id` out of that update, matches the code, writes one `digest_recipient` row per
chosen child, and sends a confirmation message immediately. The parent types nothing.

### Why the parent links their own account, rather than an operator doing it

Making them *also* find `@userinfobot` and retype a number buys nothing and verifies nothing:
the number is unauthenticated either way, and a mistyped chat id is indistinguishable from a
correct one until a stranger receives a child's behaviour record — which is exactly the gap
ADR-0026 flagged as "no verification handshake". Reading the id out of the START closes it:
the id is observed, not asserted, and the confirmation message proves the chat is reachable at
the moment it is bound.

### Long-polling, not a webhook

A webhook needs a public HTTPS URL with a valid certificate that Telegram can reach. This
stack is local Docker — backend on `3001`, frontend on `3000`, behind NAT, with its only
outbound hop a residential tinyproxy — so there is nothing for Telegram to call. `getUpdates`
is outbound-only and needs no ingress at all.

The client sets `proxy: false` for the reason `telegram.sender.ts` already documented:
`HTTPS_PROXY` is process-wide and plain axios honours it, and ADR-0023's hop is provisioned
for Mashov alone. That decision now lives in one file, `telegram/telegram-http.ts`, which both
the sender and the poller use — because the surest way to get it wrong was to have a second
caller remember it independently.

**What would change this:** a public HTTPS deployment. `setWebhook` with a secret header, a
`@Public()` route that checks `X-Telegram-Bot-Api-Secret-Token`, and stop the poller. The two
are **mutually exclusive on one bot** — Telegram refuses `getUpdates` while a webhook is set
— so whichever runs, the other must be explicitly off. `TELEGRAM_POLL_ENABLED=false` is that
switch, and the poller treats Telegram's 409 as a configuration error and stops rather than
retrying blindly.

### The offset is in memory, and that is correct

Passing `offset = lastUpdateId + 1` is what confirms updates; Telegram then drops them and
retains unconfirmed ones for 24 hours. After a restart the poller is handed back exactly what
it had not confirmed, so **reprocessing is safe by construction**: claiming a code is a
conditional update (`consumedAt: null` → set) and the recipient writes are upserts on
`@@unique([studentGuid, channel, address])`. An in-memory offset avoids both a Redis key that
`allkeys-lru` may evict and a table whose only job is a counter.
`tests/integration/telegram-link.test.ts` replays a START sequentially and races two of them,
because the constraint is the whole mechanism and only a real database can be asked to prove
it.

### The one-time code is a Postgres row, not a Redis key

The parent may press START minutes later, possibly after closing the tab. Redis here is
`maxmemory 256mb` with `allkeys-lru` and no persistence, so an evicted code would be a START
that matches nothing and a parent stranded on the wizard's third step with no way forward.
ADR-0017 already rules Redis out for durable state. The row also carries what nothing else
can: `consumedAt`, which makes replay impossible, and `chatId`, without which the wizard's
poll has no answer to give.

`prisma db push` in the Dockerfile CMD creates the brand-new table on boot, so there is no
migration file and no CMD change.

### The code is a credential

A guessed code binds the guesser's own chat to a victim's `userId`, and they would then
receive that family's children's behaviour reports. This is the sharpest threat in the feature,
and it is why the answer is 16 bytes rather than a short human-friendly code:

- `crypto.randomBytes(16).toString('hex')` — 32 chars, well inside Telegram's 64-char `/start`
  payload limit and its `A-Za-z0-9_-` alphabet, and 128 bits of entropy against a 15-minute,
  single-use window.
- Single-use, enforced in the same conditional `UPDATE` that matches it, not by a read
  followed by a write.
- TTL 15 minutes (`TELEGRAM_LINK_CODE_TTL_MINUTES`).
- The mint route rate-limited to 10/min, tighter than the global 50/min.
- `GET /digest/telegram-links/:code` scoped to the caller's `userId` as well as the code, so a
  code is never a bearer token for another user's status.
- `DigestRetentionService.prune()` deletes codes on a 7-day cutoff rather than the 90-day
  history one: a code is dead the moment it is consumed or expires, and a parent who abandons
  the wizard leaves one behind. That prune rides the existing `30 2 * * *` cron, which is not
  gated on `DIGEST_ENABLED`.

### The code carries the parent's choice

Step 2's chosen children are client state, but the START arrives server-side with no browser
attached — so the chosen guids are sent at mint time and stored on the row. Each is validated
with `canSeeStudent` at mint time **and again** at consume time, because the roster can change
in between. At mint time a guid outside the caller's visibility set fails the whole request:
there is a parent on the other end who can be told. At consume time there is not, so a guid
that is no longer visible is **skipped** — one child having left must not cost the parent their
other child's updates.

### Recipient creation is scoped to the caller's own children

ADR-0026 accepted that `DigestRecipientService.create` validated `studentGuid` only against
the global active roster, because `Student` has no `userId` FK. ADR-0031 supplied the missing
edge: `StudentConnection` *is* the set of connections that may see a child, and `canSeeStudent`
is that answer. `create` now calls it and answers `403` otherwise. **This supersedes ADR-0026's
limitation paragraphs**, which have been corrected rather than left contradicting the code,
along with `docs/api-contract.md` note 9.

### The confirmation is sent by the link path, not by the digest cron

`POST /digest/runs` would be the wrong tool for the proof, independently of everything above.
It has an in-process `running` guard that returns `[]` when a run is in flight; it honours
`DIGEST_DRY_RUN`, which defaults to true, so it would send nothing; on a genuinely quiet day it
correctly sends nothing, leaving the parent staring at a silent Telegram concluding the link
failed; and it consumes the dedup claims the 13:00 run needs. Sending from the link path means
the message arrives at the one instant the chat is known reachable, and the wizard needs no
extra "send me a test" route.

A confirmation that fails is recorded on the row (`confirmationError`) and shown to the parent.
It does not unwind a link that otherwise worked: the rows are written and the code is spent.

## Consequences

**Good.** The feature is reachable by the person it is for. An operator's whole job is one
token. Nothing about the chat id is asserted by a human, so ADR-0026's "a wrong chat id is
indistinguishable from a right one" is closed for any recipient created this way. The
cross-household hole is closed for *every* recipient, including ones created directly through
the API.

**Good.** The loop and the logic are separate services, so every question about what an update
*means* is answered by a spec that hands `consume()` a hand-built object with no timer and no
network anywhere.

**Single replica assumed.** Two backends both polling would make Telegram 409 at one of them.
This is the same assumption `inFlightManualRefreshByConnection` already carries, and it is
stated here rather than silently inherited: the poller logs that 409 as the misconfiguration it
is and backs off a minute instead of hot-looping.

**Connected but silent is still possible.** `DIGEST_ENABLED` defaults to `false` and
`DIGEST_DRY_RUN` to `true`, so a parent can finish the wizard on a default deployment and never
hear anything again. The wizard's last step reads both flags through the status response and
says sending is turned off on this server rather than promising briefings. The confirmation
itself still arrives, because the link path sends it regardless of those flags.

**A parent's chat id is personal data, stored per child.** It already was
(`digest_recipient.address`); what is new is that a parent can now remove it themselves —
`DELETE /api/v1/digest/telegram-links` drops every row and every code. ADR-0026's note that
`ops/` has no secrets-management path for `TELEGRAM_BOT_TOKEN` still stands and is not closed
here.

**Bad.** A parent cannot bring their own BotFather bot, so every family on a deployment shares
one bot identity, and its token is a single point of compromise for every linked chat. One app
bot is what makes the deep link work with nothing to type; a per-parent bot would mean a
per-parent token to paste, which is the design this ADR exists to avoid.

**Not in this version.** Per-parent scheduling or quiet hours; a "resend the test message"
button; any channel but Telegram (`DigestSender` already makes that a config change);
delivery history in the UI (`GET /digest/deliveries` exists and stays unused); a webhook path.
