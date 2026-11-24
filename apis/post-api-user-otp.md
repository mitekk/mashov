---
name: Passwordless OTP Login (NOT IMPLEMENTABLE)
method: POST
endpoint: https://web.mashov.info/api/user/otp/request
auth: CSRF token in header + a Cloudflare Turnstile token
tags: [auth, otp, session, blocked]
---

> **Source: CAPTURED from a live exchange, 2026-11-24.** Both halves observed
> against a real account on Mashov's own login page.
>
> **This flow cannot be implemented by a server-side client, and the code for
> it has been deleted.** This document exists so nobody rebuilds it. If you are
> reading it because you are about to "finish" passwordless sign-in: the
> blocker is below, and it is not a contract detail.

## Why it is blocked

`POST /api/user/otp/request` requires a **Cloudflare Turnstile** token:

```
"captcha": "1.Y7EWuCxGUAXC-E4F2kmiyz_r35xshAyBlda5fAYexKl0ow19zaCIYijwmi0WQT7ep…"
```

Mashov's login page renders a Turnstile widget on the EMAIL and SMS tabs and
**not** on the password tab — which is why ordinary password login works from
our backend and this never could. A Turnstile token is minted by a browser
against Mashov's sitekey and validated against their configured hostnames. Our
server cannot produce one, and embedding their widget on our domain to obtain
one would be circumventing a bot-protection control, which we will not do.

The existing `CAPTCHA_REQUIRED` escape hatch — link the parent out to Mashov's
own page — remains the right answer whenever Mashov demands a captcha.

## What the previous, reverse-engineered version got wrong

It was read out of the Angular bundle and was wrong in three ways beyond the
captcha:

| Claimed | Actual |
|---|---|
| `{"method": "email"}` selects the channel | The field **name** is the channel and its **value is the address**: `{"email": "parent@example.com"}`. Identical to the mistake in `post-api-user-recover.md`. |
| Step 2 is `POST /api/user/otp` with a `code` field | **No such route.** The code goes in the `password` field of `POST /api/login`. |
| No captcha | Required. |

The bundle read got the step-1 path, `semel` and `username` right. Everything
else was invented, and because our classifier reported any step-1 refusal as an
invalid code, none of it was visible.

## The observed exchange

### Step 1 — `POST /api/user/otp/request`

```json
{
  "email": "{EMAIL_ADDRESS}",
  "semel": 482273,
  "username": "{USERNAME}",
  "captcha": "{CLOUDFLARE_TURNSTILE_TOKEN}"
}
```

Empty response body. SMS presumably swaps `email` for `cellphone` with a
mobile number, by analogy with `/api/user/recover`; not separately captured.

### Step 2 — `POST /api/login`

The ordinary login body, with the one-time code as the password. Mashov's own
email calls it a *סיסמה חד פעמית* — a one-time **password** — which is exactly
what it is.

```json
{
  "semel": 482273,
  "year": 2027,
  "username": "{USERNAME}",
  "password": "{SIX_DIGIT_CODE}",
  "captcha": "{CLOUDFLARE_TURNSTILE_TOKEN}",
  "IsBiometric": false,
  "appName": "info.mashov.students",
  "apiVersion": "3.20210425",
  "appVersion": 3.20210425,
  "appBuild": 3.20210425,
  "deviceUuid": "chrome",
  "devicePlatform": "chrome",
  "deviceManufacturer": "mac",
  "deviceModel": "desktop",
  "deviceVersion": "157.0.0.0"
}
```

Answers a normal login payload with `hasStronglyAuthenticated: true`. This
body matches `buildLoginBody` field for field, which is the one piece of good
news in this capture: our password login is built correctly.

### ⚠️ Even if the captcha vanished

OTP login still could not replace password login. The sixteen sync crons
re-login in the background by decrypting a stored password, so a parent who
only ever signed in by code would get a working session and no background sync
at all. That is why `PASSWORD_SIGN_IN_REQUIRED` existed, and it would have to
come back with any revival of this flow.
