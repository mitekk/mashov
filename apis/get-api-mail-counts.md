---
name: Get Mail Counts
method: GET
endpoint: https://web.mashov.info/api/mail/counts?$select=unreadConversations
auth: CSRF token in header
tags: [mail, notifications]
---

## Purpose
Returns mail count statistics for the current user, filtered by the `$select` query param — in this case, the number of unread conversations.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Referer | https://web.mashov.info/students/main/home |
| Accept | application/json, text/plain, */* |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| unreadConversations | number | yes | Total number of unread mail conversations for the current user |

### Example
```json
{
  "unreadConversations": 68
}
```

## cURL
```bash
curl 'https://web.mashov.info/api/mail/counts?$select=unreadConversations' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/main/home' \
  -H 'Accept: application/json, text/plain, */*'
```
