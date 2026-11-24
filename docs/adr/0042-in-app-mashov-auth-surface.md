# ADR-0042: The Whole Mashov Auth Surface Lives In Our App — Except the Captcha, Which Cannot

- **Date**: 2026-11-23
- **Status**: Accepted
- **Deciders**: User, Backend agent, Frontend agent
- **Related**: [ADR-0029](0029-sign-in-adoption-trust-model.md) — adoption is why recovery must not mint a session · [ADR-0032](0032-household-merge-trust-model.md) — the merged household that makes `idNumber` ≠ household owner · [ADR-0017](0017-caching-strategy-conditional-redis.md) — why the recovery handle is Redis-with-a-TTL and the audit row is Postgres

## Context and Problem Statement

In-app sign-in already worked. Everything that happens when sign-in does **not**
simply succeed did not.

Mashov answers a failed `POST /api/login` with an HTTP status plus a `Reason`
response header naming the real cause. We threw that header away and told every
caller `פרטי הכניסה שגויים, נסה שוב`. For seven of its values the password is
**correct** and the account needs a next step:

| What Mashov said | What the parent was told |
|---|---|
| `MfaRequired` — send me a one-time code | wrong password |
| `ChangePass` — replace your password first | wrong password |
| `SetUsernameAndPass`, `CreateUsername` — pick credentials first | wrong password |
| `UserSuspended` — solve a captcha first | wrong password |
| `NoChildren` — this account has no children attached | wrong password |
| `SchoolClosed` — this school is closed | wrong password |

A parent in any of those rows retypes a password that was right until our own
rate limiter locks them out. There was also **no password recovery at all**: a
parent who had forgotten their password had exactly one path, and it was
`https://web.mashov.info/students/login`.

The goal was that a parent never lands there.

## Decision

Build the whole surface in-app: `Reason` classification and signposting,
password recovery, MFA, forced credential change, passwordless OTP login. Eight
`apis/` documents record the upstream contracts, every one of them marked
**reverse-engineered, not captured** — they were read out of Mashov's Angular
bundle, not observed on the wire.

The decisions worth recording are the ones where the obvious implementation is
wrong.

### 1. Recovery never mints a session, and never writes `encryptedPassword`

The recovery flow is unauthenticated and keyed by `idNumber`. Whoever completes
it has proved control of the **school-registered** email address or phone — not
ownership of our `AppUser` household. In a merged household (ADR-0029/0032)
those are provably not the same person: adoption means whoever holds either
school's password reaches the merged household, so minting a session from a
school's contact details would hand one parent the other's app.

So `POST /auth/credential-recoveries/:id/password` returns `{ok, username}` and
nothing else. Auto sign-in is a **client** concern: the reset form holds the new
password in memory and chains into the ordinary `POST /auth/login`, which
re-encrypts the credential, refreshes the roster and heals the connection. Same
user experience, boundary intact. A failed auto sign-in is explicitly **not** a
failed reset — the password has already changed upstream, so the success panel
stands and offers a manual link.

### 2. Every new route answers 400/422/429/502, never 401

`frontend/src/api/client.ts` hard-redirects the browser to `/auth/sign-in` on
any 401 whose code is not `INVALID_CREDENTIALS`. A 401 anywhere in this surface
would throw the parent off the very page carrying their instructions and wipe a
half-filled form holding a single-use code they cannot request again.

This is asserted, not assumed: unit tests walk every failure path of every
service checking `status !== 401`, and the integration suite does the same over
real HTTP. An upstream 401 is deliberately re-rendered as a 400 with a code that
says what actually happened.

### 3. The no-enumeration 202, and the two leaks we accept

`POST /auth/credential-recoveries` answers **202 with a byte-identical body**
for a real account and an unknown one. Every identity-shaped upstream failure —
`IdNumberNoMatch`, `NotContactInSchool`, `BindNotFound`, `UserInactive*`,
`MfaContactMissing`, and any unmapped 4xx — produces a *fabricated* `recoveryId`
marked `poisoned`. Step 2 against one answers `INVALID_RECOVERY_CODE` after
**identical** attempt counting and **identical** password validation, so the two
paths differ only in timing.

`UserSuspended` is folded into that set on purpose. Mashov only escalates to a
captcha for accounts it **recognises**, so surfacing `CAPTCHA_REQUIRED` at step 1
would be a perfect "does this ID number exist at this school" oracle — better
than the thing we were hiding.

Two leaks are accepted:

- **Timing.** A real recovery sends an email; a poisoned one returns
  immediately. Closing this needs a constant-time response budget, which buys
  little against an attacker who can already measure it.
- **`RECOVERY_THROTTLED`.** `EmailLimitExceeded`, `EmailLocked`,
  `CellphoneLocked`, `MfaResendTooSoon` and a bare upstream 429 are surfaced as
  a 429. Hiding them leaves a locked-out parent retrying forever against a
  cheerful 202, which is worse than what it gives up.

One residual leak is **not** closed: a genuinely two-channel account honestly
reports `requiresSecondChannel: true`, while a poisoned handle always reports
`false`. An attacker who already knows their victim is two-channel can
distinguish. It cannot be closed without breaking the real two-channel flow,
since the flag has to be honest for the account it belongs to.

An upstream 5xx or an unreachable upstream at step 1 answers **502**, not a
poisoned 202: fabricating a recovery during a Mashov outage would have the
parent wait for an email that was never going to be sent.

### 4. Validating the password locally is what makes a 404 mean anything — and only Mashov gets to call a code wrong

`POST /api/user/reset/{code}` answers **404 for a bad code and for a
password-policy violation**, indistinguishably. Without local validation, a
parent holding a *correct* single-use code and a six-letter password is told the
code was wrong — and the code is single-use, so there is no way back.

So `password-policy.ts` runs before any upstream call, and a 404 from Mashov is
then unambiguously "wrong code".

A second condition turned out to be just as necessary, and was missed until
review: the 4xx has to have come from **Mashov's API**. Our egress is a
residential proxy, and a proxy ACL rejection is a `403` with an HTML body and no
`Reason` header — which `isUpstreamUnreachable` cannot catch, because it is true
only when there was *no* response at all. Reported as a bad code, that tells a
parent their single-use code was wrong after they have already burned it.
`isMashovRejection` now gates every "that code is not valid" answer on a
`Reason` header or a JSON content type. The same reasoning makes the frontend's
`PASSWORD_RULES` a **live checklist** rather than submit-time validation: the
parent must never be able to press the button on a password that cannot work.

The policy is **deliberately duplicated** across the two runtimes
(`backend/src/common/mashov-login/password-policy.ts` and
`frontend/src/lib/passwordPolicy.ts`), with `PASSWORD_POLICY_CASES` copied
verbatim and verified byte-identical. Four regexes and one table copied twice is
cheaper than a workspace package, and the identical table is what proves the
copies agree. The `letter` rule is `/[A-Za-z]/`, not `/\p{L}/u`: too strict
rejects a password Mashov would have taken, with copy the parent can act on; too
lax lets them reach a 404 they cannot interpret at all.

### 5. `devicePass` + `POST /api/loginDevice` is what makes MFA compatible with sync

Sixteen cron tasks keep a household's data fresh by decrypting
`encryptedPassword` and re-logging in. A password login against an
MFA-protected account re-opens the challenge **every time**, so without a
trusted-device path an MFA parent would sign in successfully once and then watch
their data go stale overnight, with no error anyone could see.

Mashov's own answer is the `devicePass` response header plus
`POST /api/loginDevice` — an empty body and that header, no challenge. So:

- Every connection login captures the header and persists it **encrypted**,
  exactly like `encryptedPassword`; it alone is enough to get a session.
- `getAuthHeadersForConnection` prefers `loginDevice` and falls back to the
  password login when there is no `devicePass` or it fails.
- Mashov may **rotate** it on either route, so whatever comes back is written
  through. Keeping a stale one fails the *next* re-login and drops sync to a
  password that may no longer exist.
- A **historical** (backward-reaching) backfill login never takes that path:
  `/api/loginDevice` carries no year, so it would return the live session rather
  than the year the backfill asked for.
- `verifyMfa` forces `rememberBrowser: true` server-side rather than reading it
  from the client. It is not a user preference; it is the only thing that makes
  Mashov issue the credential at all.

**This rests on an assumption.** `loginDevice` behaving as read out of the
bundle has not been proven against a real MFA account. If it does not hold, MFA
sign-in works once and sync degrades — and the honest answer is then the
`credentialStale` banner below, not silence.

### 6. A reset breaks sync silently, so the breakage is made visible

A completed reset invalidates the stored `encryptedPassword`. Nothing visible
breaks immediately — the session is still valid — so the only symptom is data
quietly going stale. Four things now happen:

1. `HouseholdConnection.credentialStaleAt` is set, best-effort, on
   `[schoolCode, username]` — `idNumber` **is** the Mashov username for these
   accounts. Best-effort because a parent who set a custom username through
   `CreateUsername` will not match, and their reset must still work.
2. The connection's cached session is **evicted**. This is the one that is easy
   to forget: the in-memory `MashovAuthToken` is keyed `${connectionId}:${year}`
   and outlives the reset, so without eviction the crons go on using a session
   authenticated with a password that no longer exists.
3. The flag is cleared on **every write that has just had Mashov prove the
   password**, and on no other: `AuthService.login`'s three branches (including
   the adoption branch that returns early), `ConnectionService.updateConnection`
   (the re-enter path below), and the credential change. Missed on one, a parent
   who has already fixed things keeps being told their school needs attention.
4. It is cleared on **no** write that proved nothing. `persistSessionFromLogin`
   takes a `credentialProven` flag, false for the MFA and OTP paths. An OTP
   sign-in re-stores the password it already had — possibly the dead one — and
   an MFA sign-in stores one neither side verified, since `mfa/verify` strips it
   and the screen re-asks for it. Either clearing the flag would delete the only
   signal saying which school is broken, and leave sync broken with nothing to
   show for it.
5. `MeSchool.credentialStale` renders a per-school banner with a password field
   posting to the existing `PUT /school-links/:id`. Per school because that is
   the whole point: reset school B, sign in with A's password, and the app has a
   perfectly valid session while B's sync is dead.

The first review of this branch found the loop open at both ends — the banner's
own CTA could not clear the flag it raised, and a permitted OTP sign-in cleared
it while re-storing a known-dead password. Both are fixed; both are the reason
items 3 and 4 are now stated as a single rule about proof rather than as a list
of call sites.

Nothing in that chain is ever raised as an error. The password has already
changed upstream on a single-use code; telling the parent their reset failed
when it did not is a lie they cannot act on.

### 7. OTP login cannot replace password login, and says so

> **Amendment, 2026-11-24 — it does not work in production, and is now off.**
> See §11 below. Everything in this section still describes the intent and the
> code; none of it was reachable, because step 1 was refused by Mashov.

Our sync model needs a stored credential. A household that only ever signed in
by one-time code would have none, and would get a working session and an app
that silently never updates.

`POST /auth/otp-requests` therefore **refuses** with
`409 PASSWORD_SIGN_IN_REQUIRED` for a school with no existing connection,
checked **before** a code is sent, so the parent is never left holding a code
they cannot use. For a school already signed into, the stored password is
decrypted and written back through the normal session path. The sign-in form
states the constraint in a note above the button, before the parent commits to
the method.

The alternatives were to prompt for the password after an OTP sign-in, or to
mark the connection `credentialStale` and let the banner explain. Both tell the
parent after the fact. Refusing up front is also the only option that does not
require making `encryptedPassword` nullable, which would ripple through every
`decrypt(conn.encryptedPassword)` call site on the critical sync path.

For the same reason `POST /auth/mfa-challenges/:id/session` **requires** a
password even though Mashov's own verify route rejects one and our upstream
client strips it. Mashov has already validated it — answering `MfaRequired`
rather than `401` *is* that validation — and without it an MFA sign-in produces
a session with no background sync. The exposure is that an unauthenticated route
accepts a password it does not itself verify; a caller with a valid one-time code
but a wrong password can store a bad credential and break only their own sync.

### 8. Turnstile is not deliverable, and the fallback is one link

The plan was to render Cloudflare Turnstile with Mashov's site key
`0x4AAAAAACI5UnCCPR536XNv` and pass the token through the login body's `captcha`
field. **It was tested before being built, and it does not work.** Rendering
that key on `http://127.0.0.1:8777` fires the widget's `error-callback` with
Cloudflare code **110200** — "domain not allowed" — and logs
`[Cloudflare Turnstile] Error: 110200.` Cloudflare site keys carry a domain
allow-list and Mashov's is theirs, so no token we could obtain would satisfy it.
A server-side axios call cannot solve a challenge either.

So `CAPTCHA_REQUIRED` renders a **single escape-hatch link** to
`https://web.mashov.info/students/login`, on the four screens that can receive
that code and nowhere else. It contradicts the never-navigate-away goal, which
is why it is a last resort — but a locked-out parent with no path at all is
worse, and that is the situation Mashov puts them in. A test walks
`frontend/src` and asserts the string `web.mashov.info` appears in exactly one
non-test file, so the goal is checked rather than hoped for.

`TurnstileWidget.tsx`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, the
`challenges.cloudflare.com` CSP allowances and the README entries are
deliberately **not** shipped: dead configuration invites someone to "finish" a
path that cannot work. `buildLoginBody` does still forward an optional
`captcha`, so if Mashov ever allow-lists our domain the widget is a small
additive change. Worth re-probing from the production hostname before treating
110200 as permanent.

### 9. Driving a password change on a third-party system

We change a password on Mashov on behalf of someone we have not authenticated.
That is the uncomfortable centre of this work, and the mitigations are
load-bearing rather than decorative:

- **Nothing is persisted.** No `newPassword`, no recovery code, no OTP code, no
  captcha token — not in Redis, not in a log line, not in an error body, not in
  an exception message. `MashovRecoveryService` has **no logger at all**, by
  design, and a spec asserts no log line in it interpolates a secret. A grep
  gate (`newPassword|recoveryCode|captcha` within a logger or console call)
  returns empty.
- **Attempt caps.** 3 recoveries per IP per 15 minutes **and** 3 per
  `(school, identity)` per hour — per-IP alone does nothing against a botnet
  enumerating one victim — plus 5 code attempts per handle, after which the
  state is **deleted** rather than merely refused. The caps protect us from
  being an abuse amplifier as much as they protect the parent.
- **Every route in the surface is metered**, per IP *and* per identity (or per
  challenge, for MFA). `POST /auth/credentials` and both MFA routes shipped
  without any limit and were caught in review: the first is an unauthenticated
  password oracle that routes around `ratelimit:login`, the second lets anyone
  holding a challenge id spam a victim's phone. One shared
  `countAgainstLimit` now serves all of them, because four hand-written copies
  is exactly what let two routes ship with none.
- **Identity keys are HMACs, not digests.** A bare `sha256` of a 9-digit ID
  number is a rainbow table away from the original, which would defeat both
  reasons for hashing it. Keyed under a value derived from `ENCRYPTION_KEY`.
- **The Redis recovery state is encrypted**, with the same `EncryptionService`
  that protects `encryptedPassword`. Stored as plain JSON it carried the
  `idNumber`, so `SCAN recovery:*` plus `GET` would dump every in-flight
  recovery's national ID to anything with Redis access.
- **No identity in a URL.** The username is the ID number for these accounts, so
  the MFA and credential-change screens ask for it rather than receive it in a
  query string, where it would land in browser history and every reverse-proxy
  access log.
- **An audit row per completed reset**, `CredentialRecoveryAudit`, carrying
  `{schoolCode, hmac(idNumber), ip, at}` and nothing else. It is the trail that
  makes an abuse pattern visible after the fact. A failed audit write is logged,
  not raised, for the same reason as §6.
- **Terms of service.** Automating Mashov's password-reset endpoints from our
  backend is very likely outside what Mashov intends, as is the rest of this
  integration. Stated plainly rather than left implicit.

A third leak follows from the egress model: recovery emails fire from the
residential proxy's IP. If it rotates, Mashov sees one account's recovery
requests arriving from many addresses — a plausible abuse signal and a likely
Turnstile trigger. A dead proxy must surface as **502**, which
`isUpstreamUnreachable()` already gets right; the asymmetry versus login is that
a false "wrong code" after a single-use code was burned is unrecoverable.

### 10. Zod without React Hook Form

`.claude/rules/frontend.md` asks for React Hook Form + Zod. `react-hook-form` is
a declared dependency imported by **zero** files, and `@hookform/resolvers` is
not installed. These screens use **Zod without RHF** — a rule list plus a
`Record<string, string>` of field errors — which adds no production dependency
and keeps them consistent with `SignInPageClient.tsx` and
`AddSchoolPageClient.tsx` sitting right beside them. A deliberate deviation from
the rule, recorded here rather than silently taken.

### 11. What the unobserved contract actually cost — and the rule it bought

Added 2026-11-24, after passwordless sign-in was tried on production.

Picking "קוד לאימייל" or "קוד בסמס" on `/auth/sign-in` answered, on both
channels, `400 INVALID_OTP_CODE` — *"That code is not valid."* The parent was
told a code was wrong before one had been sent, and because the code input only
renders once step 1 succeeds, it also looked like a missing form field.

Two separate failures, and the second is the one worth recording.

**The upstream call is refused.** `POST /api/user/otp/request` was read out of
the Angular bundle and never observed, and the `apis/` document says in its own
words that the request field names are the least certain part of it. The likely
cause is §9's egress model meeting a flow that needs session state: our
`headers()` sends a hard-coded CSRF literal and **no cookie at all**, and
`requestOtp`/`verifyOtp` thread nothing between the two calls — no `uniquId`, no
per-session token — where `sendMfa`/`verifyMfa` at least carry a `challengeId`.
Unproven, because nothing told us.

**Nothing told us.** `OtpService.classify` took a `stage: 'request' | 'verify'`
and used it *only to interpolate a log message*. Its unmapped-4xx tail answered
`INVALID_OTP_CODE` at either stage, and three different upstream answers reached
that tail: no `Reason` header; a `Reason` in `MASHOV_REASONS` that this surface
maps on no branch (24 of the 32); and a `Reason` string outside the list, which
`readReason` discards silently. Worse, the only `logger` call in `classify` was
in the unreachable branch — so a Mashov refusal became user-facing copy with **no
record of the status, the `Reason` or the path**. The failure was not merely
mis-reported; it was undiagnosable from production.

`MfaService.classify` had the identical defect at its `'send'` stage.
`CredentialRecoveryService` did not: its step 1 guards on `!isMashovRejection`
and poisons instead, which is why §3 and §4 read as carefully as they do. The
two that were wrong are the two whose step 1 was added late.

Three rules follow, and they generalise past this bug:

1. **A stage argument that only reaches a log line is a bug waiting to be
   filed.** If a classifier knows which call failed, its answer must depend on
   it. The three code-validity reasons are now routed through that branch too,
   not just the bare 4xx — the defect was never specific to a missing header.
2. **Every unmapped upstream answer gets logged, not just the unreachable
   ones.** `describeMashovFailure` is the only sanctioned way: it reads the
   **raw** `Reason` header rather than `readReason`, because an unrecognised
   value is exactly the evidence worth having, and it takes the path as a
   **caller-supplied literal** — never `err.config?.url`, since
   `resetPassword` puts a single-use recovery code *in the path* and a helper
   reaching for the request URL would write live recovery codes into the logs
   the first time it was reused. It cannot see a request body, request headers
   or a response body at all. The secrecy grep gate, which guarded one file,
   now guards all four that log.
3. **A reverse-engineered path is not shipped as a live button.** §8 refused to
   ship dead Turnstile config on the reasoning that it "invites someone to
   'finish' a path that cannot work"; a button that always fails is worse,
   because a parent presses it. `PASSWORDLESS_SIGN_IN_ENABLED` in
   `frontend/src/lib/featureFlags.ts` is `false` until a real capture of
   Mashov's own login page proves the contract and an integration test asserts
   the captured request shape.

A plain constant, not an env var: the sign-in page is statically prerendered, so
`process.env` bakes at `next build` whether it is read client- or server-side,
and the runtime values in compose would be ignored silently — which is the state
`NEXT_PUBLIC_SYNCING_HARD_CAP_MS` is already in. The backend routes stay **live
and ungated**: they are metered per IP and per identity, they refuse a school
with no stored credential before sending anything, and verifying the corrected
contract needs them reachable. The flag's job is only to stop parents walking
into a dead end.

The honest summary of §7 and of the *reverse-engineered contracts* bullet below:
we shipped a sign-in method on a guess, and the first thing the guess cost was
not the broken flow — flows break — but a false accusation aimed at the parent,
with no evidence trail to correct it.

### 12. The capture, and what it ended

Added 2026-11-24, from a live capture of Mashov's own login and recovery pages
against a real account. Three flows were observed end to end; two contracts
were wrong, and one of them fatally.

**Recovery was wrong and is now fixed.** `apis/post-api-user-recover.md` had
flagged one field as unproven — "the channel flag's exact type (`boolean` vs
the contact string) is the one thing a live call still has to confirm" — and
the guess was wrong in both its type and its meaning. We sent `email: true`.
Mashov wants `email: "parent@example.com"`: there is no channel flag, the
field **name** selects the channel and its value is the destination address,
which the parent types and Mashov checks against the school's record. `true`
fails .NET model binding, so Mashov answered 400 and sent nothing, while our
deliberately indistinguishable 202 told the parent to check their inbox. This
is the defect in §11 again, inverted: a false *positive*, which is strictly
harder to find than the false negative, because "no email arrived" is
indistinguishable from "it went somewhere you forgot about".

**Passwordless OTP sign-in was removed, and cannot come back.** Mashov gates
`POST /api/user/otp/request` behind a **Cloudflare Turnstile** token — the
widget renders on the EMAIL and SMS tabs of its login form and not on the
password tab, which is exactly why ordinary password login works from our
backend and this never could. A Turnstile token is minted by a browser against
Mashov's sitekey; our server cannot produce one, and rendering their widget on
our domain to obtain one would be circumventing a bot-protection control. §8
already concluded Turnstile is not deliverable and the fallback is one link
out; this extends that conclusion from *solving* a captcha to *pre-empting*
one, and the answer is the same.

The second half of the flow did not exist either. There is no
`POST /api/user/otp`: the one-time code is submitted as the `password` field of
an ordinary `POST /api/login` — Mashov's own email calls it a *סיסמה חד פעמית*,
a one-time password, which is literally what it is. We had invented a route and
a field name, and because `classify` reported every step-1 refusal as an
invalid code, none of it was visible.

So `OtpService`, both `/auth/otp-requests` routes, the two upstream methods,
the frontend branch, ten `OTP_*` codes with their Hebrew copy, and
`PASSWORDLESS_SIGN_IN_ENABLED` are deleted. §7's constraint — OTP login cannot
replace password login, because sync re-logins decrypt a stored password —
remains true and would still apply to any revival, but it is no longer the
binding reason. `apis/post-api-user-otp.md` is kept, rewritten as a captured
record of *why* it is impossible, because §8's own standard applies to
knowledge as much as to configuration: the next person to look at this should
find the blocker, not an inviting gap.

**The rule §11 bought, restated with its evidence.** Do not ship a flow whose
upstream contract has never been observed. Of the three contracts this branch
rested on, the capture confirmed one (`buildLoginBody`, field for field),
corrected one (recovery), and killed one (OTP). That is a one-in-three hit rate
on careful bundle reading, and the two failures were invisible in production
precisely because the error-handling turned them into plausible sentences.

## Consequences

### Good

- Every row of the `Reason` table is now a signpost instead of a lie. The worst
  dead end in the product is gone.
- A parent who forgets their password recovers it without leaving the app.
- MFA accounts can sign in **and** keep syncing, via a mechanism Mashov
  provides rather than one we invented.
- A reset no longer breaks sync silently; the affected school says so, by name.
- The login body and the CSRF literal have one home, after existing in four
  copies. The `Reason` classifier is written once.
- 2127 backend unit tests, 211 frontend tests, 106 integration tests and 41
  unauthenticated E2E tests pass, including byte-identical-202, no-401,
  no-logged-secrets, no-raw-ID-in-Redis and no-bare-sha256 assertions.

### Bad, or merely accepted

- **`loginDevice` is unproven** against a real MFA account (§5). If it fails,
  MFA sync degrades to the `credentialStale` banner.
- **The captcha path leaves the app** (§8), the one place that does.
- **Timing and `RECOVERY_THROTTLED` leak** whether an account exists (§3), as
  does `requiresSecondChannel` for a known two-channel victim.
- **The MFA and credential-change routes accept an unverified password** (§7).
  Bounded, since an unproven credential can no longer clear the stale flag, so
  the blast radius of a typo is one household's own sync and a banner that
  stays up — which is the correct outcome.
- **`MashovSessionService` and `ConnectionService` keep their own login-body
  copies.** Only `AuthService` was migrated; migrating the other two changes the
  critical sync path, and the `devicePass` work already touched it once. The CSRF
  literal is now shared, the body is not. **Named debt.**
- **The cron fan-out predicate does not filter on `credentialStaleAt`.** The
  grep the plan asked for found eighteen separate
  `householdConnection.findMany` literals across `src/sync/tasks/*` with
  inconsistent predicates, not one shared helper. Session eviction (§6) already
  prevents stale *data*; what remains is one failed upstream login per task per
  run for a stale connection. **Named debt.**
- **The password policy is duplicated** (§4), on purpose, held together by a
  table that must be kept identical.
- **Session eviction after a reset is per process.** `invalidateConnection`
  clears an in-memory map, which is correct for the single-container deployment
  this runs on and incomplete the moment there are two app processes: a reset
  would evict only the cache of the process that served it, and the others would
  keep their session until it expires upstream. The `credentialStale` banner
  still fires, and the stored password is still rewritten, so the parent is told
  the truth either way — but anyone adding a second replica has to move this
  cache to Redis, or accept a stale session per extra process for up to its
  upstream lifetime.
- **The upstream contracts are reverse-engineered, not observed.** Two specific
  guesses are flagged in `apis/`: the recovery channel flag's type
  (`email: boolean` vs. a contact string), and whether `rememberBrowser` really
  issues a `devicePass`. One real end-to-end reset on a live account is the only
  thing that settles the first, and it has not been run.
  **Update 2026-11-24:** a third guess has now been settled, negatively — the
  OTP request contract does not work as read, and passwordless sign-in is off.
  See §11.
