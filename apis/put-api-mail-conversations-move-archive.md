---
name: Archive Mail Conversations
method: PUT
endpoint: https://web.mashov.info/api/mail/conversations/move/archive
auth: None
tags: [mail, conversations]
---

## Purpose
Archives one or more mail conversations by their IDs.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |

### Body
```json
["bded2eeb-9f2c-45ae-bd90-220590e45859"]
```

An array of conversation UUID strings to archive.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| (root) | array of strings | yes | List of conversation IDs to move to archive |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| (root) | number | yes | Number of conversations successfully archived |

### Example
```json
1
```

## cURL
```bash
curl 'https://web.mashov.info/api/mail/conversations/move/archive' \
  -X 'PUT' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  --data-raw '["bded2eeb-9f2c-45ae-bd90-220590e45859"]'
```
