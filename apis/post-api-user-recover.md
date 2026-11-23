---
name: Request Password Recovery
method: POST
endpoint: https://web.mashov.info/api/user/recover
auth: CSRF token in header (unauthenticated — no session required)
tags: [auth, recovery, password]
---

> **Source: reverse-engineered, not captured.** Request and response shapes were
> read out of the Angular bundle at `https://web.mashov.info/students/main-*.js`
> and its chunks, not from an observed exchange. The field names are the
> bundle's; the channel flag's exact type (`boolean` vs the contact string) is
> the one thing a live call still has to confirm.

## Purpose
Step 1 of password recovery. Identifies a user by school + ID number and asks
Mashov to send a single-use reset code to the email address or cellphone
registered at the school. Returns whether the reset will require codes from
**both** channels.

Unauthenticated: this is the flow for someone who cannot sign in.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/login |
| User-Agent | Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 |

### Body
```json
{
  "semel": 482273,
  "idNumber": "{ID_NUMBER}",
  "email": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| semel | number | yes | School identifier code |
| idNumber | string | yes | The user's national ID number. For these accounts this is also the Mashov `username`, unless the parent set a custom one via `CreateUsername`. |
| email | boolean | no | Set to request the code by email. Mutually exclusive with `cellphone`. |
| cellphone | boolean | no | Set to request the code by SMS. Mutually exclusive with `email`. |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| isResettingAndVerifying | boolean | no | `true` when Mashov sent codes on **both** channels and `POST /api/user/reset/verify/{code}/{code2}` will need both of them. Absent or `false` means the single-channel `POST /api/user/reset/{code}` applies. |

### Example
```json
{
  "isResettingAndVerifying": false
}
```

## Errors
HTTP status plus a `Reason` response header (axios lowercases it to
`headers['reason']`).

| Reason | Meaning |
|--------|---------|
| IdNumberNoMatch | No user at this school with this ID number |
| NotContactInSchool | The ID number is known but is not a registered contact |
| BindNotFound | No contact binding to send a code to |
| MfaContactMissing | No email address or cellphone on file |
| UserInactive / UserInactiveInYear | Account not active |
| EmailLimitExceeded / EmailLocked / CellphoneLocked | Too many sends; the channel is throttled |
| MfaResendTooSoon | A code was sent very recently |
| UserSuspended | Mashov is demanding a Cloudflare Turnstile token (site key `0x4AAAAAACI5UnCCPR536XNv`, sent back in the login body's `captcha` field) |
| SchoolClosed | School closed in Mashov |

**Our wrapper never distinguishes these to the caller.** Every identity-shaped
failure (and `UserSuspended`, because Mashov only escalates for accounts it
recognises) returns an indistinguishable `202` from
`POST /api/v1/auth/credential-recoveries`, so the endpoint cannot be used to
test whether an ID number exists. See ADR-0042.

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/user/recover' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{
    "semel": 482273,
    "idNumber": "{ID_NUMBER}",
    "email": true
  }'
```
