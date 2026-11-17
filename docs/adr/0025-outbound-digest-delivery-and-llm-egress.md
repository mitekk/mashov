# ADR-0025: Outbound Digest Delivery — Pluggable Sender, Telegram First, and the Project's First Runtime LLM Call

- **Date**: 2026-11-17
- **Status**: Accepted
- **Deciders**: Backend agent, Planner

## Context and Problem Statement

The product thesis is "what changed, who it affects, what needs attention"
(`school-parent-portal-requirements-v3.md` §3–4), but delivery was pull-only: a parent had to
open the app to learn that their child was marked absent at 09:00. The briefing existed; it
just waited to be collected.

Pushing it out crosses three lines this codebase had never crossed.

1. **Durable per-child recipient config.** Nothing in the schema said where to send anything.
2. **Outbound third-party egress.** ADR-0018 deleted the only one the project had ever had.
   Until now the backend talked to exactly one external host, Mashov, through one proxy.
3. **A runtime LLM call.** `docs/model-routing-policy.md` governs the *build* agents — which
   model writes the code — and says nothing about a model call in the serving path, because
   there wasn't one.

Phase 1 listed push notifications as a must-not. What changed is narrower than "we changed our
minds": the thing that made push premature was not having a trustworthy answer to "has this
already been said". Dedup is now a persisted ledger with a unique constraint (ADR-0017 ruled
out Redis for durable state), so "send only what is new" is a database guarantee rather than a
hope.

## Decision

**A `DigestSender` interface with Telegram as the only real implementation, and a `LogSender`
sink for dev, tests, and dry runs.**

The channel is a configuration detail — a `digest_recipient` row names it — not a rewrite.
`LogSender` is what `DIGEST_DRY_RUN` uses, and that flag **defaults to true**, so a first
deployment renders and logs without messaging anybody.

**Sonnet 5.5 at `low` effort, configurable per deployment.**

The task is four short Hebrew lines plus one deadline-extraction judgement, so it does not need
a frontier model. Measured against the real prompt, Haiku 5.5, Sonnet 5.5 and Opus 5.5 all
extracted an explicit Hebrew deadline (`עד 25/11`) correctly — the only judgement here that
changes what a parent is told, since the report's structure and item list are template-owned.
Sonnet was chosen over Haiku on one observed difference: given a payload with no newly assigned
homework, Haiku still wrote prose describing new homework, where Sonnet and Opus left the line
empty. `renderReport` gates each section on its actual items, so that prose never rendered — but
the gate only protects *empty* sections, and loose description of a section that does have items
would reach a parent. Sonnet costs roughly a fifth of Opus on this task; at ≤7 calls per child
per active day, all three are small enough that cost did not decide this.

**No part of the child's name reaches the model.** The first name was originally sent so the
prose could address the child. It is withheld now for two reasons that point the same way: the
rendered message already carries the name in its header line, so prose repeating it reads like a
form letter; and an instruction not to repeat it was obeyed only *sometimes* — in testing, Haiku
honoured it on one run and Sonnet did not, then the reverse. A constraint that matters is
enforced by withholding the data, not by asking. What the prompt sends instead is the child's
grammatical gender (`ז`/`נ` from the roster, mapped to `male`/`female`), which is what gendered
Hebrew actually needs and which the name never reliably supplied anyway — נועם, שחר and רותם are
all ambiguous. An unrecognised value becomes `null` and the prompt says nothing, because a wrong
gender makes every verb in the message wrong.

`low` effort is deliberate rather than timid: thinking counts against `max_tokens` on these
models, so a higher level raises the chance of a truncated response — which lands on the
deterministic fallback and costs the parent the prose entirely. `DIGEST_LLM_MODEL` and
`DIGEST_LLM_EFFORT` override both. An unrecognised effort value is dropped with a warning
rather than forwarded, because the API answers a bad effort with a 400, and this service turns
every failure into the deterministic fallback — so a typo would silently degrade every message
and look exactly like an outage.

**Both new clients bypass the Mashov egress proxy, by different means.**

`HTTPS_PROXY` is process-wide and plain axios honours it. ADR-0023's hop is a single
residential tinyproxy with a 10 s `AbortSignal` and no retry-on-abort, sized for one upstream.
A parent's message must never traverse it, and neither must a prompt.

- **Telegram** uses axios, so it sets `proxy: false` explicitly. This is the same mechanism
  `getMashovProxyConfig` uses to stop axios stacking env-proxy on top of an explicit agent.
- **Anthropic** has no `proxy` option: the SDK is fetch-based, and Node's `fetch` ignores
  `HTTPS_PROXY` entirely. So the call cannot inherit the proxy by default, and the client is
  constructed with no agent, no `fetch`, and no `fetchOptions`. A test asserts that, because
  the realistic regression is someone passing an agent in by hand.

  **Two residual risks, recorded deliberately.** A global undici dispatcher
  (`setGlobalDispatcher(new ProxyAgent(...))`) installed anywhere in the process would capture
  the LLM call, and no test here would catch it. Nothing in the repo does this today.

  More likely: **Node 24 added `--use-env-proxy` and `NODE_USE_ENV_PROXY`**, which make built-in
  `fetch` honour `HTTPS_PROXY` with no code change at all. `backend/Dockerfile` pins
  `node:22-alpine`, so passing no agent is sufficient as shipped — but a routine base-image bump
  would have silently routed every prompt through the residential box with the existing test
  still green, because that test only asserts what is *passed* to the client. The summarizer
  therefore refuses to call the model outright when that flag is set and a proxy is configured,
  and falls back to the deterministic renderer. Refusing is the safe direction: a plainer
  message still reaches the parent.

**What child data leaves the host, and what does not.**

The prompt carries: the child's **first name** (`Student.privateName`), subject names,
`achvaName`, `classification`, free `remark` and `homeworkText`, and dates. It does not carry
family names, `studentGuid`, `reporter` or teacher names, or usernames.

A single `buildPrompt()` owns this and names every field explicitly. It must never grow a
`JSON.stringify(payload)` shortcut — the payload is typed today, but the moment something
identifying is added upstream, a blanket serialisation would ship it silently. The enforcement
is a hostile unit test: it hands `buildPrompt` a payload carrying a family name, a guid, a
reporter and a username, and asserts none of them appear. `DigestCollectorService` never
selects those columns in the first place, so there is nothing to leak.

**Known limitation, accepted knowingly: free text is passed through unredacted.** A teacher's
`remark` or `homeworkText` can name *other* children ("יוסי ודנה יציגו"). Stripping structured
fields does not touch that, so the first-names-only rule holds for *this* child's identifiers
and not for third parties a teacher happened to mention. Withholding free text would gut the
summary's usefulness; redacting names out of Hebrew free text reliably is its own project.
Flagged here rather than left implied.

**Recipient rows are the child → parent ownership mapping.**

`Student` has no `userId` or `connectionId` FK — children are global, and every existing cron
iterates the whole active roster. Rather than refactor roster ownership to ship a digest, a
child gets one only if an enabled `digest_recipient` row exists for it. That makes delivery
strictly opt-in, which is the right default for pushing a child's behavior data to a messaging
app, and it keeps the model bill at zero for families who have not asked for it.

**The limitation this accepts:** nothing stops user A creating a recipient row for user B's
child, because there is no FK to validate against. The mitigations are what is available — the
`studentGuid` must be on the active roster, and the creating `userId` is recorded on every row,
so every row is attributable. **A real ownership model is separate work and should be its
own piece of work before this is exposed to more than one household.**

What the missing FK does *not* excuse is the manual-run endpoint. `POST /digest/runs` takes a
`studentGuid` in its body, and a run both spends model tokens and sends real messages — so a
`studentGuid` that cannot be validated against an FK is instead validated against the caller's
own recipient rows: `runAll` takes a `userId` and `listDeliveryTargets` filters by it. Without
that scoping an authenticated user could name another household's child and get that family a
real message, *and* consume the claims their own 13:00 run needed, since a delivered item is
never re-reported. The cron omits the `userId` and still runs every opted-in child.

## Consequences

**Good.** The feature is opt-in, off by default (`DIGEST_ENABLED=false`), and silent by default
(`DIGEST_DRY_RUN=true`). Nothing about delivery is coupled to Telegram beyond one class. The
LLM is a decoration on a deterministic report, not a dependency of it: every failure mode —
missing key, timeout, refusal, malformed output — renders the same template with deterministic
Hebrew and still sends, because a parent getting a plainer message beats a parent getting
nothing.

**Bad.** Two new third-party credentials, `ANTHROPIC_API_KEY` and `TELEGRAM_BOT_TOKEN`, are the
first non-Mashov secrets in the project, and **`ops/` has no secrets-management path at all** —
they live in `.env` beside the Mashov password. Neither is ever logged (the Telegram token is
kept out of `baseURL` precisely because axios puts request URLs in error objects, and is
redacted from extracted error text as a second layer), but "not logged" is not "managed". That
gap is real and is not closed by this ADR.

**Also bad.** A wrong Telegram chat id is indistinguishable from a right one until a stranger
receives a child's behavior record. There is no verification handshake. `DIGEST_DRY_RUN` and
the `digest_delivery.messageText` audit trail are the only guards, and a nonce handshake before
a recipient goes live would be a worthwhile follow-up.

**Volume.** Seven runs a day per child, each capable of sending. Nothing caps messages per day,
and a parent who finds the bot noisy will mute it, which costs more than a missed digest. A
minimum item age and a daily cap are the obvious next refinement. One specific failure here was
closed during review: a single unreachable recipient used to fail the whole run and release its
claims, so the *working* recipient was re-sent the same digest every hour indefinitely.
Delivery is now per-recipient. What is still missing is a permanent-vs-transient distinction —
a `403 bot was blocked` is retried on the same cadence as a `503`, forever, with no
consecutive-failure counter and no auto-disable.

**Ownership, partially tightened.** Recipient mutations and delivery history are scoped by the
creating `userId`, because a `digest_delivery` row carries `messageText` — the rendered
behavior remarks that were sent to a parent — and one household could otherwise read another's
or silently disable its digest. This does **not** amount to an ownership model: creation is
still validated only against the global active roster, so a user can still register a recipient
for another household's child. That remains separate work.

**Silence is no longer unqualified.** A run that finds nothing now distinguishes a genuinely
quiet day from one where the school data has not synced successfully for hours, recording
`skipped_stale`. The digest reads only local Postgres, so without that distinction a dead
Mashov session looks exactly like "nothing happened at school today" — which is a materially
wrong belief to leave a parent holding. What this does *not* yet do is tell the parent: the
distinction is visible in `GET /digest/deliveries` but no message is sent. Whether a stale-data
notice should reach the parent is a product decision, not a technical one.
