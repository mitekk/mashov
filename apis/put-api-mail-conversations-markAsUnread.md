---
name: Mark Conversations As Unread
method: PUT
endpoint: https://web.mashov.info/api/mail/conversations/markAsUnread
auth: CSRF token in header
tags: [mail, conversations]
---

## Purpose
Marks one or more mail conversations as unread by sending an array of conversation IDs.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |

### Body
```json
["200be420-1691-42a6-8a54-578042ca0cb2"]
```

An array of conversation UUIDs to mark as unread.

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| *(root)* | number | yes | Number of conversations successfully marked as unread |

### Example
```json
1
```

## cURL
```bash
curl 'https://web.mashov.info/api/mail/conversations/markAsUnread' \
  -X 'PUT' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  --data-raw '["200be420-1691-42a6-8a54-578042ca0cb2"]'
```
