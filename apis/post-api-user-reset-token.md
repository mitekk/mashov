---
name: Reset Password With Code
method: POST
endpoint: https://web.mashov.info/api/user/reset/{code}
auth: CSRF token in header (unauthenticated — the code is the authorisation)
tags: [auth, recovery, password]
---

> **Source: reverse-engineered, not captured.** Read out of the Angular bundle
> at `https://web.mashov.info/students/main-*.js`, not from an observed
> exchange.

## Purpose
Step 2 of single-channel password recovery. Sets a new password, authorised by
the single-use code `POST /api/user/recover` sent to the registered email
address or cellphone.

## Request

### Path parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| code | string | The single-use code from the recovery email/SMS. Strip all whitespace before use — parents paste codes with spaces, and Mashov's own client strips them. Percent-encode it into the path. |

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/login |

### Body
```json
{
  "newPassword": "{NEW_PASSWORD}"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| newPassword | string | yes | Must satisfy the student password policy: at least 6 characters, at least one letter, at least one digit, and it must not contain the username. |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | no | The Mashov username the new password now belongs to. Worth surfacing: a parent who has forgotten their password often does not remember the username either. |

### Example
```json
{
  "username": "303977367"
}
```

## Errors

### ⚠️ `404` is ambiguous upstream
Mashov answers **`404` for a bad or expired code AND for a password-policy
violation.** The two are indistinguishable on the wire.

This is why `backend/src/common/mashov-login/password-policy.ts` exists and runs
**before** this call: with the policy enforced locally, a `404` from here is
unambiguously "wrong code". Without it, a parent holding a *correct* single-use
code and a six-letter password is told the code was wrong — and the code is
single-use, so there is no way back.

| Status / Reason | Our mapping |
|-----------------|-------------|
| 404 | `400 INVALID_RECOVERY_CODE` |
| MfaCodeExpired / MfaExpired | `400 RECOVERY_CODE_EXPIRED` |
| MfaInvalidCode | `400 INVALID_RECOVERY_CODE` |
| MfaLocked | `429 RECOVERY_LOCKED` |
| UserSuspended | `422 CAPTCHA_REQUIRED` |
| unreachable (no response at all) | `502 UPSTREAM_ERROR` |

A transport failure must **never** render as an invalid code: the single-use
code has already been burned, so a false "wrong code" is unrecoverable.

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/user/reset/{CODE}' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{ "newPassword": "{NEW_PASSWORD}" }'
```
