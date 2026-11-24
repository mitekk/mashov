---
name: Reset Password With Two Codes
method: POST
endpoint: https://web.mashov.info/api/user/reset/verify/{code}/{code2}
auth: CSRF token in header (unauthenticated — the codes are the authorisation)
tags: [auth, recovery, password]
---

> **Source: reverse-engineered, not captured.** Read out of the Angular bundle
> at `https://web.mashov.info/students/main-*.js`, not from an observed
> exchange.

## Purpose
Step 2 of password recovery, two-channel variant. Used when
`POST /api/user/recover` answered `{ "isResettingAndVerifying": true }`, meaning
Mashov sent a code to **both** the registered email address and the registered
cellphone and wants both back.

The second path segment is optional, and `/verify/{code}` is a **different
upstream route** from `/verify/{code}/` — a blank second code must produce the
one-segment path, not an empty trailing segment.

## Request

### Path parameters
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| code | string | yes | First channel's single-use code. Whitespace-stripped and percent-encoded. |
| code2 | string | no | Second channel's single-use code, when the flow is two-channel. |

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
| newPassword | string | yes | Same policy as the single-channel route: ≥6 characters, ≥1 letter, ≥1 digit, must not contain the username. |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | no | The Mashov username the new password now belongs to. |

### Example
```json
{
  "username": "303977367"
}
```

## Errors
Same ambiguity as `POST /api/user/reset/{code}`: **`404` covers both a bad code
and a password-policy violation**, so the policy is enforced locally first. See
[post-api-user-reset-token.md](post-api-user-reset-token.md) for the full
mapping table.

Whether the flow is two-channel is read from the **server-stored** flag captured
at step 1, never from client input — otherwise a caller could choose the
single-code route for an account Mashov wants two codes for.

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/user/reset/verify/{CODE}/{CODE2}' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{ "newPassword": "{NEW_PASSWORD}" }'
```
