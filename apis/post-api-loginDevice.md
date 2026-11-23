---
name: Trusted Device Re-login
method: POST
endpoint: https://web.mashov.info/api/loginDevice
auth: devicePass header (no password, no MFA challenge)
tags: [auth, mfa, session, sync]
---

> **Source: reverse-engineered, not captured.** Read out of the Angular bundle
> at `https://web.mashov.info/students/main-*.js`, not from an observed
> exchange. This endpoint behaving as described is the single assumption MFA
> support rests on — see the risk note below.

## Purpose
Re-login on a device Mashov already trusts: an **empty body** plus the
`devicePass` header issued by `POST /api/login/mfa/verify` (with
`rememberBrowser: true`) or by `POST /api/login`. Returns a session **without
re-triggering the MFA challenge**.

### Why this endpoint decides whether MFA is supportable at all
Sixteen cron tasks re-login by decrypting the stored `encryptedPassword`. If
every one of those re-logins re-opened an MFA challenge, MFA-protected accounts
would be structurally incompatible with background sync — the parent would sign
in successfully once and then watch their data go stale overnight, with no error
anyone could see.

This is Mashov's own answer to that, so our cron path prefers it and falls back
to password login only when there is no `devicePass` or the call fails.

> **Risk:** if this does not work as read off the bundle, MFA sign-in works once
> and sync degrades. The honest fallback is then the `credentialStale` banner,
> not silence. Prove it on a real MFA account.

## Request

### Headers
| Header | Value |
|--------|-------|
| devicePass | {DEVICE_PASS} |
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/login |
| Cookie | uniquId={UNIQU_ID} *(optional — sent when we hold one, so Mashov recognises the device)* |

### Body
```json
{}
```

Empty object. No credentials in the body at all.

## Response

### Headers
| Header | Description |
|--------|-------------|
| devicePass | May be **rotated**. If present, persist the new value — otherwise the next re-login fails and sync falls back to a password that may no longer exist. |
| X-Csrf-Token | Session CSRF token |
| Set-Cookie: uniquId | Device identity cookie |

### Schema
Same payload as `POST /api/login` — see [post-api-login.md](post-api-login.md).

## Errors
| Reason / status | Meaning |
|-----------------|---------|
| NotAuthenticated | The `devicePass` is no longer valid; fall back to password login |
| MfaRequired | The device is no longer trusted; the challenge is open again |
| unreachable | `502 UPSTREAM_ERROR` — a dead egress proxy, not an auth failure |

A failure here must **never** be reported as bad credentials: the fallback is a
password login, not a message to the parent.

## Storage
`HouseholdConnection.devicePass` (`String?`, encrypted with the existing
`EncryptionService`, exactly like `encryptedPassword`). Nullable and additive;
the schema is managed with `prisma db push`, so there is no migration file.

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/loginDevice' \
  -H 'devicePass: {DEVICE_PASS}' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{}'
```
