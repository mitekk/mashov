---
name: Request Password Recovery
method: POST
endpoint: https://web.mashov.info/api/user/recover
auth: CSRF token in header (unauthenticated — no session required)
tags: [auth, recovery, password]
---

> **Source: CAPTURED from a live exchange, 2026-11-24.** Both channels were
> observed end to end against a real account — request, response, and the
> arrival of the code. This is the first contract in this surface to drop the
> "reverse-engineered" banner.
>
> The capture corrected the one field the previous version flagged as unproven,
> and it was wrong in both its type and its meaning. The bundle-read version
> documented `email: true` / `cellphone: true` as boolean channel flags. There
> is no channel flag: the field **name** selects the channel and its **value is
> the destination address**. `true` will not bind to a .NET string, so Mashov
> answered `400` and sent nothing — which is how this flow shipped and silently
> never delivered a single code.

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

By email — observed:
```json
{
  "email": "{EMAIL_ADDRESS}",
  "idNumber": "{ID_NUMBER}",
  "semel": 482273
}
```

By SMS — observed:
```json
{
  "cellphone": "0501234567",
  "idNumber": "{ID_NUMBER}",
  "semel": 482273
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| semel | number | yes | School identifier code |
| idNumber | string | yes | The user's national ID number. For these accounts this is also the Mashov `username`, unless the parent set a custom one via `CreateUsername`. |
| email | string | one of | The email address to send the code to. Its presence selects the email channel. |
| cellphone | string | one of | The mobile number to send the code to, with its leading zero (`0501234567`). Its presence selects the SMS channel. |

Exactly one of `email` / `cellphone` is sent; they are never both present, and
there is no separate channel flag.

**The caller supplies the destination, and Mashov checks it.** This flow does
*not* send to a contact Mashov already holds — unlike `POST /api/user/otp` and
the MFA challenge, which do. Mashov's own form asks the parent to type the
address, and refuses unless it matches what the school has on file. A UI for
this route therefore needs a destination input; one built on the assumption
that Mashov knows where to send cannot construct a valid request.

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| isResettingAndVerifying | boolean | no | `true` when Mashov sent codes on **both** channels and `POST /api/user/reset/verify/{code}/{code2}` will need both of them. Absent or `false` means the single-channel `POST /api/user/reset/{code}` applies. **Observed `false` on both successful channels**, with the client then showing a single code field — confirming the reading. A 200 is a success: the refusal path is the 400 above, not a success-shaped body. |

### Example
```json
{
  "isResettingAndVerifying": false
}
```

## Errors

**Observed:** a destination that does not match the school's record answers
`400` with an ASP.NET `ProblemDetails` body and **no `Reason` header**:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "Bad Request",
  "status": 400,
  "traceId": "00-45a69dcf5ffe7f05c85c88296f79eaca-f6a2ce9f36ce9fc6-00"
}
```

A malformed field — such as the `email: true` this contract used to specify —
is indistinguishable from it, since both fail model binding before any business
rule runs. `isMashovRejection` still classifies it as upstream-signed on the
JSON content type, so it stays on the anti-enumeration path rather than being
mistaken for a proxy ACL.

The `Reason` values below were read from the bundle and are **not** confirmed by
this capture; the observed refusal carried no such header.

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
