---
name: Passwordless OTP Login
method: POST
endpoint: https://web.mashov.info/api/user/otp
auth: CSRF token in header (unauthenticated — the OTP is the authorisation)
tags: [auth, otp, session]
---

> **Source: reverse-engineered, not captured.** Read out of the Angular bundle
> at `https://web.mashov.info/students/main-*.js`, not from an observed
> exchange. The request field names on both halves are the least certain part of
> this document.

## Purpose
Sign in **without a password**, by a one-time code sent to the registered email
address or cellphone. Mirrors Mashov's own `loginMethod` switch
(`password` | `email` | `sms`) on its login form.

Two calls:

1. `POST /api/user/otp/request` — ask for the code.
2. `POST /api/user/otp` — exchange the code for a session.

### ⚠️ OTP login cannot replace password login
Our sixteen sync crons need a stored password (or a `devicePass`) to re-login in
the background. A parent who only ever signs in by OTP gets a working session
and **no background sync**. That constraint has to be visible in the UI — either
prompt for the password once after an OTP sign-in, or show the
`credentialStale` banner. It must not ship silently.

## Request — step 1: `POST /api/user/otp/request`

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
  "semel": 482273,
  "username": "{USERNAME}",
  "method": "email"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| semel | number | yes | School identifier code |
| username | string | yes | Mashov username (the ID number, for most accounts) |
| method | string | yes | `"email"` or `"sms"` |

## Request — step 2: `POST /api/user/otp`

### Body
The `POST /api/login` body with `password` omitted, plus the code:

```json
{
  "semel": 482273,
  "year": 2026,
  "username": "{USERNAME}",
  "code": "123456",
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
| code | string | yes | The one-time code. Strip all whitespace first. |
| *(login body fields)* | | yes | See [post-api-login.md](post-api-login.md), minus `password` |

## Response
Same payload as `POST /api/login` — `credential` + `accessToken`, plus the
`uniquId` cookie and `X-Csrf-Token` response header. See
[post-api-login.md](post-api-login.md).

## Errors
| Reason | Our mapping |
|--------|-------------|
| MfaInvalidCode | `400 INVALID_OTP_CODE` |
| MfaCodeExpired / MfaExpired | `400 OTP_CODE_EXPIRED` |
| MfaLocked | `429 OTP_LOCKED` |
| MfaResendTooSoon | `429 OTP_RESEND_TOO_SOON` |
| MfaContactMissing | `422 OTP_CONTACT_MISSING` |
| LoginMethodBlocked | `422 LOGIN_METHOD_BLOCKED` — this school disallows passwordless login |
| UserSuspended | `422 CAPTCHA_REQUIRED` |
| unreachable | `502 UPSTREAM_ERROR` |

Never `401` — see [post-api-login-mfa-send.md](post-api-login-mfa-send.md).

## cURL
```bash
# step 1
curl -X POST 'https://web.mashov.info/api/user/otp/request' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{ "semel": 482273, "username": "{USERNAME}", "method": "email" }'

# step 2
curl -X POST 'https://web.mashov.info/api/user/otp' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{
    "semel": 482273,
    "year": 2026,
    "username": "{USERNAME}",
    "code": "123456",
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
