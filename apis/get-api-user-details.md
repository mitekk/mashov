---
name: Get User Details
method: GET
endpoint: https://web.mashov.info/api/user/details
auth: CSRF token in header
tags: []
---

## Purpose
Retrieves the authenticated user's account details including contact information, verification timestamps, and recovery history.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| semel | number | yes | School/institution identifier |
| userId | string | yes | Unique user UUID |
| detailsState | number | yes | State of account details completion (0 = complete) |
| email | string | yes | User's registered email address |
| emailSet | string | yes | ISO 8601 timestamp when email was set |
| emailVerified | string | yes | ISO 8601 timestamp when email was verified |
| cellphone | string | yes | User's registered phone number |
| cellphoneSet | string | yes | ISO 8601 timestamp when cellphone was set |
| cellphoneVerified | string | yes | ISO 8601 timestamp when cellphone was verified |
| lastRecovery | string | yes | ISO 8601 timestamp of last account recovery |
| lastReset | string | yes | ISO 8601 timestamp of last password reset |

### Example
```json
{
  "semel": 482273,
  "userId": "dd2c6df1-95d8-4459-93f9-7534fd871ac0",
  "detailsState": 0,
  "email": "mitekk@gmail.com",
  "emailSet": "2020-09-04T11:05:10",
  "emailVerified": "2020-09-04T11:05:31",
  "cellphone": "0547684502",
  "cellphoneSet": "2020-09-04T11:02:23",
  "cellphoneVerified": "2020-09-04T11:02:50",
  "lastRecovery": "2026-03-10T23:01:38",
  "lastReset": "2026-03-10T23:02:10"
}
```

## cURL
```bash
curl 'https://web.mashov.info/api/user/details' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/settings'
```
