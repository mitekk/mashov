---
name: Send MFA Code
method: POST
endpoint: https://web.mashov.info/api/login/mfa/send
auth: CSRF token in header (unauthenticated — the challenge id is the handle)
tags: [auth, mfa, session]
---

> **Source: reverse-engineered, not captured.** Read out of the Angular bundle
> at `https://web.mashov.info/students/main-*.js`, not from an observed
> exchange.

## Purpose
Asks Mashov to send (or re-send) the one-time code for an MFA challenge that
`POST /api/login` already opened by answering `403` with
`Reason: MfaRequired`. The caller picks the channel.

The `challengeId` comes out of that `403`'s response body — it is the only
handle on the challenge, which is why our `MFA_REQUIRED` envelope carries it
through as `error.challengeId`.

## Request

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
  "challengeId": "{CHALLENGE_ID}",
  "method": "email"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| challengeId | string | yes | From the `403 Reason: MfaRequired` response body of `POST /api/login` |
| method | string | yes | `"email"` or `"sms"` |

## Response
`202`-shaped: no meaningful body. Our wrapper answers `202 { "ok": true }`.

## Errors
| Reason | Our mapping |
|--------|-------------|
| MfaResendTooSoon | `429 MFA_RESEND_TOO_SOON` |
| MfaLocked | `429 MFA_LOCKED` |
| MfaExpired | `400 MFA_CODE_EXPIRED` |
| MfaContactMissing | `422 MFA_CONTACT_MISSING` |
| UserSuspended | `422 CAPTCHA_REQUIRED` |
| unreachable | `502 UPSTREAM_ERROR` |

Never `401`: `apiFetch` in the frontend hard-redirects to `/auth/sign-in` on any
401 whose code is not `INVALID_CREDENTIALS`, which would throw the parent off
the code-entry screen and lose the half-typed code.

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/login/mfa/send' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{ "challengeId": "{CHALLENGE_ID}", "method": "email" }'
```
