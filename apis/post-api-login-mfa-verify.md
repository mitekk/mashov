---
name: Verify MFA Code
method: POST
endpoint: https://web.mashov.info/api/login/mfa/verify
auth: CSRF token in header (unauthenticated — the code is the authorisation)
tags: [auth, mfa, session]
---

> **Source: reverse-engineered, not captured.** Read out of the Angular bundle
> at `https://web.mashov.info/students/main-*.js`, not from an observed
> exchange. `rememberBrowser` issuing a `devicePass` is the claim that most
> needs confirming on a real MFA account — see ADR-0042 and the risk note.

## Purpose
Answers an MFA challenge and, on success, returns the same payload
`POST /api/login` returns: `credential` + `accessToken`, plus the `uniquId`
cookie, `X-Csrf-Token` and — when `rememberBrowser` was true — the `devicePass`
response header.

**`rememberBrowser: true` is load-bearing.** It is what makes Mashov issue the
`devicePass` that `POST /api/loginDevice` later uses. Without it an
MFA-protected account signs in once and then every one of our 16 cron re-logins
re-triggers the challenge, so background sync dies the next morning.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/login |

### Body
The full `POST /api/login` body, **with `password`, `newPassword`, `captcha` and
`mfaChallengeId` stripped out** (Mashov's own client strips them; this route
rejects them), plus three fields:

```json
{
  "semel": 482273,
  "year": 2026,
  "username": "{USERNAME}",
  "IsBiometric": false,
  "appName": "info.mashov.students",
  "apiVersion": "3.20210425",
  "appVersion": 3.20210425,
  "appBuild": 3.20210425,
  "deviceUuid": "chrome",
  "devicePlatform": "chrome",
  "deviceManufacturer": "mac",
  "deviceModel": "desktop",
  "deviceVersion": "145.0.0.0",
  "challengeId": "{CHALLENGE_ID}",
  "code": "123456",
  "rememberBrowser": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| challengeId | string | yes | From the `403 Reason: MfaRequired` response body |
| code | string | yes | The one-time code. Strip all whitespace first. |
| rememberBrowser | boolean | yes | `true` to have Mashov issue a `devicePass` for trusted-device re-login |
| *(login body fields)* | | yes | See [post-api-login.md](post-api-login.md), minus `password` / `newPassword` / `captcha` / `mfaChallengeId` |

## Response

### Headers
| Header | Description |
|--------|-------------|
| X-Csrf-Token | Session CSRF token |
| devicePass | **Only when `rememberBrowser` was true.** The trusted-device credential for `POST /api/loginDevice`. Store it encrypted. |
| Set-Cookie: uniquId | Device identity cookie, persisted as `HouseholdConnection.mashovUniqueId` |

### Schema
Identical to `POST /api/login` — see [post-api-login.md](post-api-login.md).

## Errors
| Reason | Our mapping |
|--------|-------------|
| MfaInvalidCode | `400 INVALID_MFA_CODE` |
| MfaCodeExpired / MfaExpired | `400 MFA_CODE_EXPIRED` |
| MfaLocked | `429 MFA_LOCKED` |
| UserSuspended | `422 CAPTCHA_REQUIRED` |
| unreachable | `502 UPSTREAM_ERROR` |

Never `401` — see [post-api-login-mfa-send.md](post-api-login-mfa-send.md).

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/login/mfa/verify' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{
    "semel": 482273,
    "year": 2026,
    "username": "{USERNAME}",
    "IsBiometric": false,
    "appName": "info.mashov.students",
    "apiVersion": "3.20210425",
    "appVersion": 3.20210425,
    "appBuild": 3.20210425,
    "deviceUuid": "chrome",
    "devicePlatform": "chrome",
    "deviceManufacturer": "mac",
    "deviceModel": "desktop",
    "deviceVersion": "145.0.0.0",
    "challengeId": "{CHALLENGE_ID}",
    "code": "123456",
    "rememberBrowser": true
  }'
```
