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

### 4. Validating the password locally is what makes a 404 mean anything

`POST /api/user/reset/{code}` answers **404 for a bad code and for a
password-policy violation**, indistinguishably. Without local validation, a
parent holding a *correct* single-use code and a six-letter password is told the
code was wrong — and the code is single-use, so there is no way back.

So `password-policy.ts` runs before any upstream call, and a 404 from Mashov is
then unambiguously "wrong code". The same reasoning makes the frontend's
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
3. `AuthService.login` clears the flag on **all three** write branches,
   including the adoption branch that returns early. Missed on one, a parent who
   has already fixed things keeps being told their school needs attention.
4. `MeSchool.credentialStale` renders a per-school banner with a password field
   posting to the existing `PUT /school-links/:id`. Per school because that is
   the whole point: reset school B, sign in with A's password, and the app has a
   perfectly valid session while B's sync is dead.

Nothing in that chain is ever raised as an error. The password has already
changed upstream on a single-use code; telling the parent their reset failed
when it did not is a lie they cannot act on.

### 7. OTP login cannot replace password login, and says so

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
- **The per-identity rate-limit key is hashed.** A raw key would park a national
  ID number under a greppable Redis key, readable by anything with Redis access.
- **An audit row per completed reset**, `CredentialRecoveryAudit`, carrying
  `{schoolCode, sha256(idNumber), ip, at}` and nothing else. It is the trail that
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
- 2090 backend unit tests, 198 frontend tests, 52 integration tests and 41
  unauthenticated E2E tests pass, including byte-identical-202, no-401 and
  no-logged-secrets assertions.

### Bad, or merely accepted

- **`loginDevice` is unproven** against a real MFA account (§5). If it fails,
  MFA sync degrades to the `credentialStale` banner.
- **The captcha path leaves the app** (§8), the one place that does.
- **Timing and `RECOVERY_THROTTLED` leak** whether an account exists (§3), as
  does `requiresSecondChannel` for a known two-channel victim.
- **The MFA and credential-change routes accept an unverified password** (§7).
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
- **The upstream contracts are reverse-engineered, not observed.** Two specific
  guesses are flagged in `apis/`: the recovery channel flag's type
  (`email: boolean` vs. a contact string), and whether `rememberBrowser` really
  issues a `devicePass`. One real end-to-end reset on a live account is the only
  thing that settles the first, and it has not been run.
