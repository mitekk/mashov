---
name: Get Inbox Conversations
method: GET
endpoint: https://web.mashov.info/api/mail/inbox/conversations
auth: API key in header
tags: [mail, inbox, conversations]
---

## Purpose
Fetches a paginated list of inbox mail conversations, each containing message metadata and sender info.

## Request

### Query Parameters
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| skip | number | yes | Number of conversations to skip (for pagination) |
| take | number | yes | Number of conversations to return per page |

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/main/mailbox/folder/inbox |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| conversationId | string | yes | Unique UUID identifying the conversation thread |
| subject | string | yes | Subject line of the conversation |
| sendTime | string | yes | ISO 8601 timestamp of when the conversation was initiated |
| isNew | boolean | yes | Whether the conversation has unread messages for the current user |
| hasDrafts | boolean | yes | Whether the conversation has unsent draft messages |
| hasAttachments | boolean | yes | Whether any message in the conversation has file attachments |
| preventReply | boolean | yes | Whether replying to this conversation is disabled |
| labels | array | yes | List of user-applied labels (empty array if none) |
| messages | array | yes | List of message objects within this conversation |
| messages[].messageId | string | yes | Unique UUID for this specific message |
| messages[].conversationId | string | yes | UUID of the parent conversation (matches top-level conversationId) |
| messages[].senderId | string | yes | UUID of the sender (teacher or staff member) |
| messages[].senderName | string | yes | Display name of the sender, format: "מורים/\<name\>" |
| messages[].subject | string | yes | Subject line of the message |
| messages[].lastUpdate | string | yes | ISO 8601 timestamp of the last update to this message |
| messages[].sendTime | string | yes | ISO 8601 timestamp of when the message was sent |
| messages[].folder | number | yes | Folder identifier; `0` = inbox |
| messages[].isNew | boolean | yes | Whether this specific message is unread |
| messages[].isDeleted | boolean | yes | Whether this message has been deleted |
| messages[].sendOnBehalf | boolean | yes | Whether the message was sent on behalf of another user |
| messages[].sendViaEmail | boolean | yes | Whether the message was sent via external email |
| messages[].sendViaSms | boolean | yes | Whether the message was sent via SMS |
| messages[].preventReply | boolean | yes | Whether replying to this specific message is disabled |
| messages[].sentViaEmail | boolean | yes | Whether the message was delivered via external email |
| messages[].sentViaSms | boolean | yes | Whether the message was delivered via SMS |

### Example
```json
[
  {
    "conversationId": "200be420-1691-42a6-8a54-578042ca0cb2",
    "subject": "מפגש זום לק.חברתית",
    "sendTime": "2026-03-09T18:49:43",
    "isNew": true,
    "hasDrafts": false,
    "hasAttachments": false,
    "messages": [
      {
        "messageId": "200be420-1691-42a6-8a54-578042ca0cb2",
        "conversationId": "200be420-1691-42a6-8a54-578042ca0cb2",
        "senderId": "832599e2-99ee-4f39-b9cc-b64a71893c0c",
        "senderName": "מורים/מעיינה סגל",
        "subject": "מפגש זום לק.חברתית",
        "lastUpdate": "2026-03-09T18:49:43",
        "sendTime": "2026-03-09T18:49:43",
        "folder": 0,
        "isNew": false,
        "isDeleted": false,
        "sendOnBehalf": false,
        "sendViaEmail": false,
        "sendViaSms": false,
        "preventReply": false,
        "sentViaEmail": false,
        "sentViaSms": false
      }
    ],
    "labels": [],
    "preventReply": false
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/mail/inbox/conversations?skip=0&take=20' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/mailbox/folder/inbox' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
```
