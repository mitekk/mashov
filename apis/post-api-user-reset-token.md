---
name: Reset Password With Code
method: POST
endpoint: https://web.mashov.info/api/user/reset/{code}
auth: CSRF token in header (unauthenticated — the code is the authorisation)
tags: [auth, recovery, password]
---

> **Source: captured 2026-11-24**, from the browser against
> `https://web.mashov.info/students/reset`. Earlier revisions of this file were
> reverse-engineered out of the Angular bundle at
> `https://web.mashov.info/students/main-*.js`; where the capture and the bundle
> disagree, the capture wins and the disagreement is called out below.

## Purpose
Step 2 of single-channel password recovery. Sets a new password, authorised by
the single-use code `POST /api/user/recover` sent to the registered email
address or cellphone.

## Request

### Path parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| code | string | The single-use code from the recovery email/SMS — a 6-digit numeric string in the captured call (`329803`). Strip all whitespace before use: parents paste codes with spaces, and Mashov's own client strips them. Percent-encode it into the path. |

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/reset |

The captured `Referer` is **`/students/reset`**, not `/students/login` as this
file previously claimed. Mashov has not been observed to reject a mismatched
`Referer` here, but send the page the user is actually on.

**Our client sends `/students/reset` on this route.**
`MashovRecoveryService.headers()` used to send `/students/login` for every route
on the class; it now defaults to that and takes a per-route override, and both
step-2 reset routes pass `/students/reset`. The login, MFA, trusted-device and
authenticated-change routes still send `/students/login`.

No cookie header was sent. This route is genuinely unauthenticated — the
single-use code is the whole authorisation — so the CSRF token is the only
header that has to be sourced from a prior request.

### Body
```json
{
  "newPassword": "{NEW_PASSWORD}"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| newPassword | string | yes | Must satisfy the student password policy: at least 6 characters, at least one letter, at least one digit, and it must not contain the username. Symbols are accepted — the captured value used `$`. |

## Response

### ⚠️ Observed: empty body
The captured call returned **no response body at all** — not `{}`, not
`{ "username": ... }`. Treat a successful reset as "no content" and drive the UI
off the status code, never off a parsed field.

A consumer that reads `username` off this response will get `undefined` on the
happy path. The field is documented below because the Angular bundle reads it,
so some accounts or some flow variant may populate it, but **nothing may depend
on it**.

Our `POST /api/v1/auth/credential-recoveries/{id}/password` therefore falls back
to the recovering `idNumber`, which IS the Mashov username for these accounts,
and marks the value as derived rather than upstream-reported. A successful reset
logs `upstreamUsername=present|absent`, which is how we will learn whether the
empty body is universal or specific to the captured account.

The capture did not record the status code, so whether success is `200` with an
empty body or `204` is still open. Treat any 2xx as success.

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | no | **Not present in the captured response.** The Angular bundle reads this field and surfaces it to the user — a parent who has forgotten their password often does not remember the username either. Bundle-derived, unconfirmed on the wire. |

### Example
```json
```
Empty body, as captured.

## Errors

### ⚠️ `404` is ambiguous upstream
Mashov answers **`404` for a bad or expired code AND for a password-policy
violation.** The two are indistinguishable on the wire.

This is why `backend/src/common/mashov-login/password-policy.ts` exists and runs
**before** this call: with the policy enforced locally, a `404` from here is
unambiguously "wrong code". Without it, a parent holding a *correct* single-use
code and a six-letter password is told the code was wrong — and the code is
single-use, so there is no way back.

An empty body makes this worse, not better: there is no error envelope to
distinguish the two cases even in principle. The local policy check is the only
thing standing between a valid code and an unrecoverable false "wrong code".

| Status / Reason | Our mapping |
|-----------------|-------------|
| 404 | `400 INVALID_RECOVERY_CODE` |
| MfaCodeExpired / MfaExpired | `400 RECOVERY_CODE_EXPIRED` |
| MfaInvalidCode | `400 INVALID_RECOVERY_CODE` |
| MfaLocked | `429 RECOVERY_LOCKED` |
| UserSuspended | `422 CAPTCHA_REQUIRED` |
| unreachable (no response at all) | `502 UPSTREAM_ERROR` |

A transport failure must **never** render as an invalid code: the single-use
code has already been burned, so a false "wrong code" is unrecoverable. Note the
collision with the success case — an empty body is both the happy path and the
shape of a dead connection, so the status code is the only signal that separates
them.

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/user/reset/{CODE}' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/reset' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{ "newPassword": "{NEW_PASSWORD}" }'
```
