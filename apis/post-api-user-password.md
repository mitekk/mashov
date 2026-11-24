---
name: Change Password
method: POST
endpoint: https://web.mashov.info/api/user/password
auth: CSRF token in header + the current password in the login body
tags: [auth, password]
---

> **Source: reverse-engineered, not captured.** Read out of the Angular bundle
> at `https://web.mashov.info/students/main-*.js`, not from an observed
> exchange.

## Purpose
Change a password while proving the current one. Driven by the forced-change
path: `POST /api/login` answered `403` with `Reason: ChangePass` (or
`SetUsernameAndPass` / `CreateUsername`), so the parent cannot sign in until
they set a new one.

Those `403`s also carry a `challengeId`, which must be echoed back here as
`mfaChallengeId`.

The companion `POST /api/user/username` has the identical shape with `username`
in place of `newPassword`.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/login |

### Body
The full `POST /api/login` body — including the **current** `password` — plus:

```json
{
  "semel": 482273,
  "year": 2026,
  "username": "{USERNAME}",
  "password": "{CURRENT_PASSWORD}",
  "newPassword": "{NEW_PASSWORD}",
  "mfaChallengeId": "{CHALLENGE_ID}",
  "IsBiometric": false,
  "appName": "info.mashov.students",
  "apiVersion": "3.20210425",
  "appVersion": 3.20210425,
  "appBuild": 3.20210425,
  "deviceUuid": "chrome",
  "devicePlatform": "chrome",
  "deviceManufacturer": "mac",
  "deviceModel": "desktop",
  "deviceVersion": "145.0.0.0"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| password | string | yes | The current password |
| newPassword | string | yes | ≥6 characters, ≥1 letter, ≥1 digit, and **must not contain the username** — the rule Mashov's own change-password dialog enforces |
| mfaChallengeId | string | no | Echoed from the `403` that demanded the change |
| *(login body fields)* | | yes | See [post-api-login.md](post-api-login.md) |

### `POST /api/user/username`
Same body, with `username` carrying the **new** username in place of
`newPassword`. Reasons `UsernameExists` and `UsernameLocked` are specific to it.

## Response
Same payload as `POST /api/login` — see [post-api-login.md](post-api-login.md).

## Errors
| Reason | Our mapping |
|--------|-------------|
| *(policy violation)* | Caught locally as `422 WEAK_PASSWORD` before this call runs |
| UsernameExists | `409 USERNAME_TAKEN` *(username route)* |
| UsernameLocked | `429 USERNAME_LOCKED` *(username route)* |
| MfaRequired | `400 MFA_REQUIRED` — the challenge has to be answered first |
| UserSuspended | `422 CAPTCHA_REQUIRED` |
| unreachable | `502 UPSTREAM_ERROR` |

Never `401` — see [post-api-login-mfa-send.md](post-api-login-mfa-send.md).

## Secrecy
`newPassword` is never persisted anywhere — not Redis, not a log line, not a
breadcrumb, not an exception message. See ADR-0042 on the exposure of driving a
password change on a third-party system from our backend.

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/user/password' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{
    "semel": 482273,
    "year": 2026,
    "username": "{USERNAME}",
    "password": "{CURRENT_PASSWORD}",
    "newPassword": "{NEW_PASSWORD}",
    "mfaChallengeId": "{CHALLENGE_ID}",
    "IsBiometric": false,
    "appName": "info.mashov.students",
    "apiVersion": "3.20210425",
    "appVersion": 3.20210425,
    "appBuild": 3.20210425,
    "deviceUuid": "chrome",
    "devicePlatform": "chrome",
    "deviceManufacturer": "mac",
    "deviceModel": "desktop",
    "deviceVersion": "145.0.0.0"
  }'
```
