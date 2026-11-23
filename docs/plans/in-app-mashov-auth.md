# In-app Mashov auth: recovery, MFA, forced credential change, OTP login

## Context

You want the whole Mashov auth surface inside our app, so a parent never lands on
`https://web.mashov.info/students/login`.

Today only half of that is true. In-app sign-in already works end to end
(`frontend/src/app/auth/sign-in/` → `/api/v1/auth/login` → `backend/src/auth/auth.service.ts`),
and nothing in the app links out to Mashov. What is missing is everything that happens when
sign-in does *not* simply succeed:

- **No password recovery at all.** A parent who forgets their password has no path but Mashov's own site.
- **Three distinct upstream outcomes collapse into "wrong password".** Mashov answers `403` with a
  `Reason` response header. `MfaRequired`, `ChangePass`, `SetUsernameAndPass`, `CreateUsername`,
  `UserSuspended`, `NoChildren`, `SchoolClosed` all currently render as
  `פרטי הכניסה שגויים, נסה שוב`. Those users are hard-stuck on a *correct* password and will retype
  it until the rate limiter locks them out.
- **No captcha path.** After repeated failures Mashov escalates to Cloudflare Turnstile
  (`403 Reason: UserSuspended`). Our server-side axios call cannot solve a challenge.

Intended outcome: a parent can sign in, recover a forgotten password, clear an MFA challenge,
satisfy a forced credential change, log in passwordlessly by one-time code, and pass a captcha —
all without leaving our site.

## Upstream API, reverse-engineered from Mashov's Angular bundle

The page is an Angular SPA (`<mshv-root>`); everything below was read out of
`https://web.mashov.info/students/main-*.js` and its chunks. Base `https://web.mashov.info/api/`.

Login body, built by `prepareLoginData`:
`{semel, year, username, password, captcha?, isPrivateDevice?, IsBiometric, appName:'info.mashov.students', apiVersion:'3.20210425', appVersion, appBuild, deviceUuid, devicePlatform, deviceManufacturer, deviceModel, deviceVersion, registrationId?}`

| Endpoint | Body | Notes |
|---|---|---|
| `POST /api/login` | login body | → `{credential, accessToken}`; resp headers `X-Csrf-Token`, `devicePass` |
| `POST /api/login/mfa/send` | `{challengeId, method}` | `method` ∈ `{'email','sms'}` |
| `POST /api/login/mfa/verify` | `{...loginData, challengeId, code, rememberBrowser}` | password/newPassword/captcha/mfaChallengeId stripped first |
| `POST /api/user/recover` | `{semel, idNumber, email?, cellphone?}` | → `{isResettingAndVerifying?}`; sends a code |
| `POST /api/user/reset/{code}` | `{newPassword}` | `404` on bad code **or** policy violation |
| `POST /api/user/reset/verify/{code}[/{code2}]` | `{newPassword}` | two-channel variant |
| `POST /api/user/otp/request`, `POST /api/user/otp` | — | passwordless login by email/SMS code |
| `POST /api/user/password` | `{...loginData, newPassword}` | authenticated change |
| `POST /api/user/username` | `{...loginData, username}` | authenticated change |
| `POST /api/loginDevice` | `{}` + `devicePass` header | **re-login without re-challenging MFA** |
| `GET /api/schools`, `/api/logout`, `/api/clearSession[/x]`, `/api/session/isActive` | — | |

Errors: HTTP status + **`Reason` response header** (axios lowercases it: `headers['reason']`),
one of 33 values: `BindExists, BindNotFound, CellphoneLocked, ChangePass, CreateUsername,
EmailLimitExceeded, EmailLocked, IdNumberNoMatch, InvalidSchool, LoginMethodBlocked, MfaCodeExpired,
MfaContactMissing, MfaExpired, MfaInvalidCode, MfaLocked, MfaRequired, MfaResendTooSoon, NoChildren,
NoParentsAccess, NotAuthenticated, NotContactInSchool, PrivilegeEscalation, SameSchool, SchoolClosed,
SetUsernameAndPass, UserInactive, UserInactiveInYear, UsernameExists, UsernameLocked, UserSuspended,
UseUsername, UserExists`.

Turnstile site key `0x4AAAAAACI5UnCCPR536XNv`, token returned in the `captcha` login field.
Student password policy: **min 6 chars, ≥1 letter, ≥1 digit, must not contain the username.**

## Two decisions worth stating up front

**MFA and our sync model.** 16 cron tasks decrypt `encryptedPassword` and re-login. If every cron
re-login re-triggered MFA, MFA accounts would be structurally incompatible with sync. They are not:
Mashov's own answer is the `devicePass` response header plus `POST /api/loginDevice` (empty body,
`devicePass` header), which is exactly a trusted-device re-login that skips the challenge. That
mechanism is already half-present in our tree — `mashov-session.service.ts` parses the `uniquId`
cookie and persists it as `HouseholdConnection.mashovUniqueId`. Task 5 extends that to `devicePass`.
This is the load-bearing part of MFA support; without it MFA sign-in works once and sync dies the
next morning.

**Auto sign-in after reset.** The recovery flow is unauthenticated and keyed by `idNumber`, so
whoever completes it has proved control of the school-registered email/phone — not ownership of our
`AppUser` household, which in a merged household (ADR-0029/0032) is provably not the same person. So
the recovery endpoint must never mint a session or write `encryptedPassword`. Auto sign-in is
therefore implemented **client-side**: the reset form holds the new password in memory and chains
into the existing `POST /api/v1/auth/login`, which already re-encrypts the credential, refreshes the
roster and heals the connection. Same user experience, boundary intact.

## Global Constraints

- **TDD** per `.claude/rules/testing.md`: failing test first, every time.
- **Recovery endpoints must never return 401.** `frontend/src/api/client.ts` hard-redirects to
  `/auth/sign-in` on any 401 whose code is not `INVALID_CREDENTIALS`; a 401 would bounce the user
  off the page they are standing on and wipe a half-filled form. Everything in the Reason table is
  **400/422/429/502**, never 401.
- **Never persist or log a `newPassword`, a recovery code, an OTP code or a captcha token** —
  not in Redis, not in logs, not in breadcrumbs.
  `grep -rn "newPassword\|recoveryCode\|captcha" backend/src --include=*.ts | grep -i "logger\|console"`
  must be empty.
- **Never let a network failure render as an invalid code.** The user already burned a single-use
  code; a false "wrong code" is unrecoverable. Unreachable upstream → `502 UPSTREAM_ERROR`.
- Resource-shaped paths per `.claude/rules/api.md` — no verbs in paths.
- Error envelope per `.claude/rules/api.md`: `{error:{code,message,details?}}`.
- All new backend routes are `@Public()`; `frontend/src/middleware.ts` `PUBLIC_PATHS` already
  covers `/api/v1/auth/`, so no middleware change.
- **Form library deviation:** `.claude/rules/frontend.md` asks for React Hook Form + Zod. `zod` is a
  dependency; `react-hook-form` is declared but imported by **zero** files; `@hookform/resolvers`
  is not installed. Use **Zod without RHF** — `safeParse()` plus a `Record<string,string>` of field
  errors — matching `SignInPageClient.tsx` and `AddSchoolPageClient.tsx`. Flag in the ADR.
- The password policy is **deliberately duplicated** across the two runtimes
  (`backend/src/common/mashov-login/password-policy.ts` and `frontend/src/lib/passwordPolicy.ts`)
  with an identical test table on each side. Four regexes beat a workspace package here.

## Review Focus

Input classes and failure modes the planned tests do not all exercise; check each deliberately:

- A known-good `idNumber` and an unknown one must produce **byte-identical** 202 bodies and the
  same shape of `recoveryId`. Any difference (length, charset, field order, presence of a field)
  is an enumeration oracle.
- `UserSuspended` at recovery step 1 must be folded into the poisoned-202 path, not surfaced as
  `CAPTCHA_REQUIRED` — Mashov only escalates for accounts it recognises, so surfacing it is a
  perfect oracle.
- Anything that turns an upstream *transport* failure into a user-facing "wrong code".
- Any route in the new surface that can emit 401.
- Any log line, error message, exception `cause`, or Redis value that can carry a password, a code,
  or a raw `idNumber`.
- Rate-limit keys: the per-ID key must be hashed; a raw ID number must not be greppable in Redis.
- Session eviction after a reset: an in-memory `MashovAuthToken` keyed `${connectionId}:${year}`
  that outlives the reset means crons keep using a session whose password no longer exists.

---

## Task 1 — Phase 0: consolidate the login body (no behaviour change)

The upstream login body and the hard-coded CSRF literal
`'9c690c16-d0c8-ed43-9314-d622077e2e26'` exist in **three** copies:
`backend/src/auth/auth.service.ts#postLogin`, `backend/src/session/mashov-session.service.ts`
(`postSharedLogin` + `loginWithCredentials`), and the canonical
`backend/src/common/mashov-login/mashov-credential-validator.service.ts`, whose own docblock exists
to end exactly this duplication. Everything below adds a `Reason` classifier that **both** sign-in
and recovery need; written against three copies it will drift.

### Interfaces produced

- `backend/src/common/mashov-login/mashov-login-body.ts`:
  `export const MASHOV_CSRF_TOKEN: string` and
  `export function buildLoginBody(input: LoginBodyInput): Record<string, unknown>`,
  where `LoginBodyInput` carries `{semel, year, username, password?, captcha?, isPrivateDevice?, IsBiometric?}`.
- `MashovLoginResult` widened with `csrfToken?: string` and `devicePass?: string`, read from the
  `x-csrf-token` and `devicepass` response headers (axios lowercases header names).

### Steps

1. Read `backend/src/common/mashov-login/mashov-credential-validator.service.ts`,
   `backend/src/auth/auth.service.ts`, `backend/src/auth/auth.module.ts`,
   `backend/src/session/mashov-session.service.ts`. Note the exact shape of each of the three
   login-body copies before changing anything.
2. Write `backend/src/common/mashov-login/mashov-login-body.spec.ts` first: `buildLoginBody`
   emits every documented field; `captcha`/`isPrivateDevice` are omitted when not supplied and
   present verbatim when they are; `MASHOV_CSRF_TOKEN` equals the literal the three copies use.
   Run it. **Expected:** fails — module does not exist.
3. Create `mashov-login-body.ts`. Run the spec. **Expected:** passes.
4. Rewrite `mashov-credential-validator.service.ts` to build its body with `buildLoginBody`, and
   widen `MashovLoginResult` with `csrfToken` / `devicePass`.
5. Inject `MashovCredentialValidatorService` into `AuthService`; delete `AuthService`'s private
   `postLogin` and its duplicate `MashovLoginResponse` interface, routing through the validator's
   raw-post method. Keep `AuthService`'s own try/catch — year reconciliation needs the raw post,
   not `validate`.
6. Import `MashovLoginModule` in `backend/src/auth/auth.module.ts`.
7. Leave `mashov-session.service.ts` and `connection.service.ts` on their own copies — migrating
   them needs the widened return type on the critical sync path. Record as named debt for the ADR.

**Gate:** `cd backend && npx tsc --noEmit && npm run lint && npm test -- src/auth src/common/mashov-login`
then `npx jest -c tsconfig.integration.json tests/integration/auth.test.ts`.
**Expected:** all green, no behaviour change.

### Commit

`refactor(backend): single source for the mashov login body`

---

## Task 2 — Phase 1: Reason classification + sign-in signposting

The cheapest large win: no new screens, and it converts the worst dead end in the product.

### Interfaces produced

- `backend/src/common/mashov-login/mashov-reason.ts`:
  `export type MashovReason` (all 33 values), `export function readReason(error: unknown): MashovReason | undefined`,
  `export function classifyLoginReason(reason: MashovReason | undefined): { code: string; status: number; message: string }`.
- `frontend/src/types/api.ts`: an `AuthErrorCode` union carrying the new codes.

### The mapping

All of these are **400, not 401** (see Global Constraints).

| Reason | code | Hebrew | CTA |
|---|---|---|---|
| `MfaRequired` | `MFA_REQUIRED` + `{challengeId}` | — | → Task 6 MFA step |
| `ChangePass` | `PASSWORD_CHANGE_REQUIRED` | `משוב דורש החלפת סיסמה לפני הכניסה` | → Task 8 |
| `SetUsernameAndPass`, `CreateUsername` | `CREDENTIALS_SETUP_REQUIRED` | `יש להשלים הגדרת שם משתמש וסיסמה` | → Task 8 |
| `UserSuspended` | `CAPTCHA_REQUIRED` | `נא לסמן "אני לא רובוט"` | → Task 9 Turnstile |
| `NoChildren`, `NoParentsAccess` | `NO_CHILDREN` | `לא נמצאו ילדים משויכים לחשבון זה` | — |
| `SchoolClosed` | `SCHOOL_CLOSED` | `בית הספר סגור במערכת משוב` | — |
| `UserInactive`, `UserInactiveInYear` | `USER_INACTIVE` | `החשבון אינו פעיל בשנה זו` | — |
| `UseUsername` | `USE_USERNAME` | `יש להתחבר עם שם המשתמש ולא עם מספר הזהות` | — |
| unreachable | `UPSTREAM_ERROR` (502) | `משוב אינו זמין כרגע` | — |

Everything unmapped keeps today's `INVALID_CREDENTIALS`.

### Steps

1. Write `backend/src/common/mashov-login/mashov-reason.spec.ts` first: a table with **every** one
   of the 33 Reason values → expected `{code, status}`; `readReason` pulls from
   `error.response.headers['reason']` and is case-insensitive about the header name; `readReason`
   returns `undefined` for a non-axios error. Run it. **Expected:** fails.
2. Create `mashov-reason.ts`. Run the spec. **Expected:** passes.
3. Write the `auth.service.spec.ts` additions first: a 403 with `Reason: ChangePass` produces a
   `400 PASSWORD_CHANGE_REQUIRED`; a 403 with `Reason: MfaRequired` produces
   `400 MFA_REQUIRED` carrying the `challengeId` from the response body; a plain 401 still
   produces `INVALID_CREDENTIALS`. Run. **Expected:** fails.
4. Modify `auth.service.ts`'s catch to call `classifyLoginReason`. Run. **Expected:** passes.
5. Modify `frontend/src/types/api.ts` with the error-code union.
6. Modify `frontend/src/app/auth/sign-in/SignInPageClient.tsx`: replace the two-branch `onError`
   with a code→copy map, and add the `שכחתי סיסמה` link
   (`data-testid="sign-in-forgot-password"` → `/auth/forgot-password`).

**Gate:** `cd backend && npx tsc --noEmit && npm run lint && npm test -- src/auth src/common/mashov-login`;
`cd frontend && npx tsc --noEmit && npm run lint && npm test`.

### Commit

`feat(auth): signpost mashov login failures instead of collapsing them`

---

## Task 3 — Recovery upstream service + password policy + `apis/` docs

### Interfaces produced

- `backend/src/common/mashov-login/mashov-recovery.service.ts` in `MashovLoginModule`: thin POSTs
  over the shared `createMashovAxios`, **no Prisma, no Redis** —
  `requestRecovery({semel, idNumber, email?, cellphone?})` → `{isResettingAndVerifying?: boolean}`,
  `resetPassword(code, newPassword)`, `resetPasswordVerify(code, code2|undefined, newPassword)`,
  `sendMfa(challengeId, method)`, `verifyMfa(loginData, challengeId, code, rememberBrowser)`,
  `loginDevice(devicePass)`.
- `backend/src/common/mashov-login/password-policy.ts`:
  `export const PASSWORD_RULES` (id, message, test) and
  `export function validatePassword(password: string, username?: string): PolicyViolation[]`,
  plus a helper that throws the `422 WEAK_PASSWORD` envelope with per-rule `details[]`.

`password-policy.ts` is load-bearing, not cosmetic: Mashov returns `404` for *both* a bad code and
a policy violation, so validating first is what makes a `404` unambiguously a bad code.

### Steps

1. Read `backend/src/common/mashov-login/` (the axios factory, `createMashovAxios`, and whatever
   `isUpstreamUnreachable()` lives in) to match existing conventions.
2. Write `password-policy.spec.ts` first, as an exported table: min 6 chars; ≥1 letter; ≥1 digit;
   must not contain the username (case-insensitive, and skipped when no username is supplied).
   Include the exact pass/fail table that `frontend/src/lib/passwordPolicy.ts` will reuse verbatim
   in Task 7. Run. **Expected:** fails.
3. Create `password-policy.ts`. Run. **Expected:** passes.
4. Write `mashov-recovery.service.spec.ts` first, with a mocked axios instance: each method hits
   the documented path and body; the code is **whitespace-stripped** and `encodeURIComponent`'d
   into the path; `resetPasswordVerify` hits `/user/reset/verify/{code}` with one code and
   `/user/reset/verify/{code}/{code2}` with two; `verifyMfa` strips
   `password`/`newPassword`/`captcha`/`mfaChallengeId` from the login data before posting;
   `loginDevice` sends an empty body and a `devicePass` header. Run. **Expected:** fails.
5. Create `mashov-recovery.service.ts` and register it in `MashovLoginModule`. Run.
   **Expected:** passes.
6. Document the endpoints with the `api-doc` skill: `apis/post-api-user-recover.md`,
   `post-api-user-reset-token.md`, `post-api-user-reset-verify.md`, `post-api-login-mfa-send.md`,
   `post-api-login-mfa-verify.md`, `post-api-user-otp.md`, `post-api-user-password.md`,
   `post-api-loginDevice.md`. Match the existing format in `apis/`.

**Gate:** `cd backend && npx tsc --noEmit && npm run lint && npm test -- src/common/mashov-login`.
Plus `grep -rn "newPassword\|code" backend/src/common/mashov-login/mashov-recovery.service.ts | grep -i "logger\|console"` → **Expected:** empty.

### Commit

`feat(backend): mashov recovery/mfa upstream client and password policy`

---

## Task 4 — Recovery orchestration + tests

**Create** `backend/src/auth/credential-recovery.service.ts` as a new provider in `AuthModule` —
not inside `AuthService`, whose `login()` is already the highest-risk method in the backend.

### The surface

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/v1/auth/credential-recoveries` | `{semel, idNumber, channel:'email'\|'sms'}` | 202 `{recoveryId, requiresSecondChannel, channel}` |
| POST | `/api/v1/auth/credential-recoveries/:id/password` | `{code, secondCode?, newPassword}` | 200 `{ok:true, username}` |

Redis `recovery:${recoveryId}`, TTL 900s:
`{semel, idNumber, channel, isResettingAndVerifying, attempts, poisoned?}`. The opaque id is what
lets step 2 carry no PII and keeps the two-channel flag server-side.

**No-enumeration mechanism.** `IdNumberNoMatch`, `NotContactInSchool`, `BindNotFound`,
`UserInactive*`, `MfaContactMissing`, `UserSuspended` and any unmapped 4xx all return an
**indistinguishable 202** with a *fabricated* `recoveryId` carrying `poisoned: true`; step 2 against
it always answers `400 INVALID_RECOVERY_CODE` after identical attempt-counting. `UserSuspended` is
folded in here on purpose — a `CAPTCHA_REQUIRED` at step 1 would be a perfect oracle, since Mashov
only escalates for accounts it recognises.

Two accepted leaks, both for the ADR: response **timing** (a real recover sends an email), and
`RECOVERY_THROTTLED` for `EmailLimitExceeded`/`EmailLocked`/`CellphoneLocked`/`MfaResendTooSoon`/429
— hiding that one leaves a locked-out parent retrying forever, which is worse.

Step-2 mapping: `404` → `400 INVALID_RECOVERY_CODE`; `MfaCodeExpired`/`MfaExpired` →
`400 RECOVERY_CODE_EXPIRED`; `MfaInvalidCode` → `400 INVALID_RECOVERY_CODE`; `MfaLocked` →
`429 RECOVERY_LOCKED`; `UserSuspended` → `422 CAPTCHA_REQUIRED`; unreachable → `502 UPSTREAM_ERROR`.

Rate limits, reusing the Redis pattern already in `auth.service.ts`: `ratelimit:recovery:${ip}`
3/900s **and** `ratelimit:recovery:id:${semel}:${sha256(idNumber)}` 3/3600s (hashed — the raw key
would park an ID number under a greppable Redis key). Per-IP alone does nothing against a botnet
enumerating one victim. 5 code attempts per `recoveryId`, then the key is deleted.

Validate the password with `password-policy.ts` **before** calling upstream. Write an audit row per
completed reset with `{semel, sha256(idNumber), ip, at}` — never the code or the password.

### Steps

1. Read `backend/src/auth/auth.service.ts`'s Redis rate-limit helper and
   `backend/src/auth/auth.controller.ts` for the `@Public()` and DTO conventions.
2. Write `credential-recovery.service.spec.ts` first: the poisoned-202 path for each listed Reason;
   byte-identical 202 bodies for known and unknown IDs; the 6th attempt on one `recoveryId`
   rejected and the key deleted; `requiresSecondChannel` read from the server-stored flag, with
   flag-true-and-`secondCode`-missing → `400 SECOND_CODE_REQUIRED`; each step-2 Reason → its
   mapped code; an unreachable upstream → `502`, never `INVALID_RECOVERY_CODE`; a weak password
   rejected `422 WEAK_PASSWORD` before any upstream call. Run. **Expected:** fails.
3. Create `credential-recovery.service.ts` + DTOs + the two controller routes. Run.
   **Expected:** passes.
4. Write `tests/integration/auth-recovery.test.ts` (spy on the new services with `jest.spyOn`,
   matching how `tests/integration/auth.test.ts` already mocks upstream): the two 202 bodies are
   byte-identical; per-IP and per-ID 429; the two-channel path calls `/verify`; recovery routes
   reachable with **no `mashov_session` cookie**; no route returns 401.
   Run. **Expected:** fails, then passes.

**Gate:** `cd backend && npx tsc --noEmit && npm run lint && npm test -- src/auth`;
`npx jest -c tsconfig.integration.json tests/integration/auth.test.ts tests/integration/auth-recovery.test.ts`.
Manual: `grep -n "Unauthorized" backend/src/auth/credential-recovery.service.ts` → **Expected:** empty.
`grep -rn "newPassword\|recoveryCode\|captcha" backend/src --include=*.ts | grep -i "logger\|console"` → **Expected:** empty.

### Commit

`feat(auth): in-app mashov password recovery endpoints`

---

## Task 5 — `devicePass`/`loginDevice` + stale-credential remediation

This is what makes MFA compatible with sync, and what stops a reset from silently breaking it.

### Trusted device

- **Modify** `backend/prisma/schema.prisma` — `HouseholdConnection.devicePass String?` (encrypted
  via the existing `EncryptionService`) and `credentialStaleAt DateTime?`. Additive and nullable;
  the schema is managed with `prisma db push`, so **no migration file**.
- **Modify** `mashov-session.service.ts` — capture the `devicePass` response header on login, and
  prefer `POST /api/loginDevice` with that header for cron re-logins, falling back to password
  login. This is what stops the 16 sync tasks re-triggering MFA every morning.
- Pass `rememberBrowser: true` on `verifyMfa` (Task 6) so Mashov issues the `devicePass` at all.

### Stale-credential remediation

A reset invalidates the stored `encryptedPassword`, and sync breaks silently.

1. Best-effort mark: `findUnique({ schoolCode_username: { schoolCode: semel, username: idNumber } })`
   — `idNumber` *is* the Mashov `username` for these accounts (`apis/post-api-login.md` shows
   `credential.idNumber: 303977367` next to `accessToken.username: "303977367"`), and
   `HouseholdConnection` is uniquely keyed on `[schoolCode, username]`. Best-effort because a parent
   who set a custom username via `CreateUsername` will not match.
2. `sessionService.invalidateConnection(connectionId)` — without it the in-memory `MashovAuthToken`
   keyed `${connectionId}:${year}` outlives the reset and the crons keep using a session whose
   password no longer exists. `connection.service.ts:307` already does this on unlink.
3. Self-heal: `auth.service.ts#login` already rewrites `encryptedPassword` on all three branches
   (adoption, update, create) — add `credentialStaleAt: null` beside each. No new logic.
4. Make it visible: add `credentialStale` to `MeSchool` in
   `backend/src/school-links/school-links.service.ts` and render a banner deep-linking to the
   existing re-enter-credentials screen (`PUT /school-links/:id`). This closes the loop for a
   multi-school household — reset school B, sign in with A, and B must say it needs attention.
5. Cron guard: add `credentialStaleAt: null` to the connection fan-out predicate. **First run
   `grep -rn 'householdConnection.findMany' backend/src/sync backend/src/connection`** — if that is
   one shared helper, do it; if it is sixteen literals, defer and rely on step 2. Ledger the ruling.

### Steps

1. Run the grep above and ledger the ruling it decides.
2. Edit `schema.prisma`; run `npx prisma generate` (and `db push` against a local DB if one is up).
3. Write the failing tests first: a completed reset marks the matching connection stale and calls
   `invalidateConnection`; a reset with no matching connection succeeds anyway; a following
   `login()` clears `credentialStaleAt` and rewrites `encryptedPassword`;
   `school-links.service` surfaces `credentialStale`; `mashov-session` prefers `loginDevice` when a
   `devicePass` exists and falls back to password login when `loginDevice` fails.
4. Implement. Run each. **Expected:** passes.
5. Frontend: render the `credentialStale` banner, `data-testid="school-credential-stale-banner"`,
   deep-linking to the re-enter-credentials screen.

**Gate:** `cd backend && npx tsc --noEmit && npm run lint && npm test`;
`cd frontend && npx tsc --noEmit && npm run lint && npm test`;
`npx jest -c tsconfig.integration.json tests/integration/auth.test.ts tests/integration/auth-recovery.test.ts`.

### Commit

`feat(sync): trusted-device re-login and stale-credential remediation`

---

## Task 6 — MFA endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/v1/auth/mfa-challenges/:challengeId/code` | `{method:'email'\|'sms'}` | 202 `{ok:true}` |
| POST | `/api/v1/auth/mfa-challenges/:challengeId/session` | `{semel, username, code, rememberBrowser}` | 200 `{ok:true, isFirstLogin}` + `mashov_session` cookie |

`/session` reuses the existing login session-minting path in `AuthService` — same cookie, same
roster refresh, same connection healing — and passes `rememberBrowser: true` through to
`verifyMfa` so Mashov issues a `devicePass`, which is persisted encrypted per Task 5.

MFA Reason mapping: `MfaInvalidCode` → `400 INVALID_MFA_CODE`;
`MfaCodeExpired`/`MfaExpired` → `400 MFA_CODE_EXPIRED`; `MfaLocked` → `429 MFA_LOCKED`;
`MfaResendTooSoon` → `429 MFA_RESEND_TOO_SOON`; `MfaContactMissing` → `422 MFA_CONTACT_MISSING`;
`UserSuspended` → `422 CAPTCHA_REQUIRED`; unreachable → `502 UPSTREAM_ERROR`. Never 401.

### Steps

1. Write the failing specs: each Reason → its mapped code; `/session` success mints the
   `mashov_session` cookie and persists the `devicePass` encrypted; the code is
   whitespace-stripped; no route returns 401.
2. Implement the two routes (in `credential-recovery.service.ts` or a sibling `mfa.service.ts` —
   whichever keeps `AuthService.login()` untouched; ledger the choice). Run. **Expected:** passes.
3. Extend `tests/integration/auth-recovery.test.ts` with the MFA routes.

**Gate:** as Task 4.

### Commit

`feat(auth): in-app mashov MFA challenge endpoints`

---

## Task 7 — Recovery + MFA frontend

**Create**, each a server shell + client component mirroring `sign-in/page.tsx`:

- `frontend/src/app/auth/forgot-password/{page.tsx,ForgotPasswordPageClient.tsx}`
- `frontend/src/app/auth/reset-password/{page.tsx,ResetPasswordPageClient.tsx}`
- `frontend/src/app/auth/mfa/{page.tsx,MfaPageClient.tsx}`
- `frontend/src/lib/passwordPolicy.ts` — a Zod schema factory taking the username (the
  no-username-inside rule is relational) plus a `PASSWORD_RULES` array for a **live checklist**, not
  just submit-time errors. Mashov's 404-on-policy-violation is unhelpable; the user must never reach it.

**Modify** `frontend/src/api/auth.ts` (new functions), `frontend/src/types/api.ts` (new types),
`SignInPageClient.tsx` (routing `MFA_REQUIRED` → `/auth/mfa?cid=…`).

`recoveryId` travels as `/auth/reset-password?rid=…` — opaque, single-use, server-side TTL, so safe
in a URL in a way a verification code is not, and a refresh does not strand the user. A missing or
invalid `rid` renders a "start again" state. Both clients wrap in `<Suspense>` for `useSearchParams`,
as `SignInPageClient` already does. Reuse `frontend/src/components/auth/SchoolAutocomplete.tsx` as-is.

Two-channel variant: one form, two code inputs, branch on the **server-stored** flag, not client
input.

RTL details that bite: code and ID inputs need `dir="ltr"` + `inputMode="numeric"`, and the code
input `autoComplete="one-time-code"` so iOS SMS autofill works and digits do not reorder. Passwords
`autoComplete="new-password"`.

Step-1 copy must be enumeration-safe — "if the details are correct", never "a code was sent":
`אם הפרטים נכונים, נשלח קוד אימות ל{אימייל|טלפון} הרשום במשוב`.

On reset success: show `הסיסמה עודכנה במשוב` and the returned `username`, then **auto sign-in** by
calling the existing `login()` mutation with the in-memory new password; fall back to a button to
`/auth/sign-in` if it fails.

### Steps

1. Read `frontend/src/app/auth/sign-in/{page.tsx,SignInPageClient.tsx}`,
   `frontend/src/app/.../AddSchoolPageClient.tsx`, `frontend/src/api/auth.ts`,
   `frontend/src/api/client.ts`, `frontend/src/components/auth/SchoolAutocomplete.tsx`.
2. Write `frontend/src/lib/passwordPolicy.test.ts` first with the **same table** as the backend
   spec. Run. **Expected:** fails, then passes against the new `passwordPolicy.ts`.
3. Write component tests for each client (per whatever `frontend` already uses) covering the
   enumeration-safe copy, the `rid`-missing state, the live checklist, and the two-code branch.
   Run. **Expected:** fails, then passes.
4. Build the three screens and the API functions.
5. Every interactive element gets a descriptive `data-testid` per `.claude/rules/frontend.md`.

**Gate:** `cd frontend && npx tsc --noEmit && npm run lint && npm test`.

### Commit

`feat(frontend): in-app password recovery and MFA screens`

---

## Task 8 — Phase 3: forced credential change + passwordless OTP

**Backend** — `POST /api/v1/auth/credentials` wrapping `POST /api/user/password` and
`POST /api/user/username`, driven by the `PASSWORD_CHANGE_REQUIRED` /
`CREDENTIALS_SETUP_REQUIRED` codes from Task 2 (these carry a `challengeId` too, which must be
echoed back as `mfaChallengeId`). Reuse `password-policy.ts`, including the rule that `newPassword`
must not contain the username.

`POST /api/v1/auth/otp-requests` → `POST /api/user/otp/request`, then
`POST /api/v1/auth/otp-requests/:id/session` → `POST /api/user/otp`, reusing the login
session-minting path.

**Frontend** — `frontend/src/app/auth/complete-setup/` for the forced change, and an "entry method"
switch on the sign-in form (`password` | `email` | `sms`) mirroring Mashov's own `loginMethod`.

One constraint to surface in the UI, not hide: **OTP login cannot replace password login.** The 16
sync crons need a stored password (or a `devicePass`), so an OTP-only sign-in gets a working session
but no background sync. Either prompt for the password once after OTP sign-in, or show the
`credentialStale` banner from Task 5. **Decide at implementation time and ledger the ruling; do not
let it ship silently.**

### Steps

1. Failing specs first, same shape as Tasks 4 and 6: Reason mapping, policy-before-upstream, no 401,
   nothing logged.
2. Implement backend, then frontend screens with `data-testid`s.
3. Implement the chosen OTP/sync answer and make it visible in the UI.

**Gate:** both stacks' `tsc --noEmit && lint && test`, plus the integration suite.

### Commit

`feat(auth): forced credential change and passwordless OTP login`

---

## Task 9 — Phase 4: Turnstile

**Verify this first, before building the UI.** The token must satisfy *Mashov's* site key, and
Cloudflare site keys carry a domain allow-list. If Mashov's key is locked to `web.mashov.info`, the
widget will fail on our origin with error `110200` and this phase is **not deliverable as designed**
— in which case the fallback is a single escape-hatch link to
`https://web.mashov.info/students/login`, shown **only** on `CAPTCHA_REQUIRED`, never in the happy
path. That contradicts the never-navigate-away goal, so it is a last resort, not a primary path —
but a locked-out parent with no path at all is worse. **Ledger which branch you took.**

- **Create** `frontend/src/components/auth/TurnstileWidget.tsx` — load
  `https://challenges.cloudflare.com/turnstile/v0/api.js` on demand (not on first paint), site key
  `0x4AAAAAACI5UnCCPR536XNv` from `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, Hebrew locale, `onToken` /
  `onExpire`. Reset the widget on every failed submit — Turnstile tokens are single-use.
- **Modify** `SignInPageClient.tsx`, `ForgotPasswordPageClient.tsx`, `MfaPageClient.tsx` — mount it
  on `CAPTCHA_REQUIRED`, gate submit on a token, and pass `captcha` through.
- **Modify** the login/recovery DTOs and `buildLoginBody` to forward `captcha` verbatim.
- **Modify** `frontend/src/app/layout.tsx` CSP (if one is set) to allow `challenges.cloudflare.com`
  in `script-src`, `connect-src`, `frame-src`.
- **Modify** `.env.example` + `README.md` for the new var.

### Commit

`feat(auth): turnstile captcha path for suspended mashov accounts`

---

## Task 10 — E2E + ADR

- E2E page objects `tests/e2e/pages/{ForgotPasswordPage,ResetPasswordPage,MfaPage}.ts` and
  `tests/e2e/auth-recovery.spec.ts`, **`data-testid` selectors only** per
  `.claude/rules/testing.md`. Run against the dockerized stack.
- `docs/adr/0042-in-app-mashov-auth-surface.md` via the `adr` skill, covering: resource-shaped
  paths; the no-enumeration 202 and its two accepted leaks; why recovery never mints a session or
  writes `encryptedPassword`; `devicePass`/`loginDevice` as the MFA-sync bridge; the deliberate RHF
  deviation; the duplicated password policy; the Turnstile domain risk and the escape hatch; the
  third-party-password-mutation exposure; and the remaining `mashov-session.service.ts` duplication
  as named debt.

**Gate:**

```bash
cd backend  && npx tsc --noEmit && npm run lint && npm test -- --coverage
cd frontend && npx tsc --noEmit && npm run lint && npm test
npx jest -c tsconfig.integration.json tests/integration/auth.test.ts tests/integration/auth-recovery.test.ts
docker compose up -d --build
npx playwright test tests/e2e/auth.spec.ts tests/e2e/auth-recovery.spec.ts
```

### Commit

`test(e2e): recovery and MFA journeys` + `docs(adr): in-app mashov auth surface`

---

## Risks

1. **Turnstile domain lock** (Task 9) — test before building.
2. **We would be driving a password change on a third-party system from our backend**, on behalf of
   someone we have not authenticated. Mandatory: never persist `newPassword` or any code anywhere
   (not Redis, not logs, not breadcrumbs); audit that the recovery service has no logger call
   interpolating a body; write an audit row per completed reset with
   `{semel, sha256(idNumber), ip, at}`. The attempt caps protect us from being an abuse amplifier as
   much as they protect the user. State the ToS exposure plainly in the ADR.
3. **Residential-proxy egress.** Recovery emails fire from the proxy's IP, so if it rotates, Mashov
   sees one account's recovery requests from many IPs — a plausible abuse signal and a likely
   Turnstile trigger. A dead proxy must surface as `502`, which `isUpstreamUnreachable()` already
   gets right; the asymmetry versus login is that a false "wrong code" after a single-use code was
   burned is unrecoverable.
4. **MFA + sync** is only sound if `devicePass`/`loginDevice` works as read from the bundle. Prove
   it on a real MFA account before Task 8; if it does not hold, MFA sign-in works once and sync
   degrades, and the honest answer is the `credentialStale` banner.
5. Recovery endpoints must **never return 401** — `apiFetch`'s redirect would wipe a half-filled form.

## Manual checks automation will not catch

- `grep -rn "newPassword\|recoveryCode\|captcha" backend/src --include=*.ts | grep -i "logger\|console"` → must be empty.
- `grep -n "Unauthorized" backend/src/auth/credential-recovery.service.ts` → must be empty.
- With `HTTPS_PROXY` at a blackhole, step 1 returns 502 within `MASHOV_TIMEOUT_MS`.
- **Before Task 9 UI work:** mount Turnstile with key `0x4AAAAAACI5UnCCPR536XNv` on `localhost` and
  confirm it issues a token rather than error `110200`.
- **Before Task 7 frontend work:** one real end-to-end reset on a live account — confirm the email
  arrives and the new password works on `POST auth/login`. This is the only way to know whether
  `/api/user/recover` is Turnstile-gated for our proxy IP, and a `UserSuspended` there changes the plan.
