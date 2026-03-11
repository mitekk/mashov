---
name: Get Mail Conversation
method: GET
endpoint: https://web.mashov.info/api/mail/conversations/{conversationId}
auth: CSRF token in header
tags: [mail, conversations]
---

## Purpose
Fetches a full mail conversation by ID, including all messages, recipients, metadata, and folder information.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/main/mailbox/conversation/{conversationId} |

### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| conversationId | string (UUID) | Unique identifier of the conversation to retrieve |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| conversationId | string | yes | UUID of the conversation |
| subject | string | yes | Subject line of the conversation (may be in Hebrew) |
| sendTime | string | yes | ISO 8601 timestamp of when the conversation was sent |
| isNew | boolean | yes | Whether the conversation has unread messages |
| hasDrafts | boolean | yes | Whether the conversation has unsent drafts |
| hasAttachments | boolean | yes | Whether any message in the conversation has attachments |
| labels | array | yes | List of labels/tags applied to the conversation |
| preventReply | boolean | yes | Whether recipients are blocked from replying |
| messages | array | yes | List of message objects in the conversation |
| messages[].messageId | string | yes | UUID of the individual message |
| messages[].conversationId | string | yes | UUID of the parent conversation |
| messages[].senderId | string | yes | UUID of the sender |
| messages[].senderName | string | yes | Display name of the sender (e.g. "מורים/אלבז רבקה") |
| messages[].subject | string | yes | Subject of this specific message |
| messages[].body | string | yes | HTML body content of the message |
| messages[].lastUpdate | string | yes | ISO 8601 timestamp of last update to this message |
| messages[].sendTime | string | yes | ISO 8601 timestamp of when the message was sent |
| messages[].folder | number | yes | Folder ID where the message is stored (e.g. 2 = inbox) |
| messages[].isNew | boolean | yes | Whether this message is unread |
| messages[].isDeleted | boolean | yes | Whether this message has been deleted |
| messages[].labels | array | yes | Labels applied to this specific message |
| messages[].sendOnBehalf | boolean | yes | Whether the message was sent on behalf of another user |
| messages[].sendViaEmail | boolean | yes | Whether the message was scheduled to send via email |
| messages[].sendViaSms | boolean | yes | Whether the message was scheduled to send via SMS |
| messages[].preventReply | boolean | yes | Whether reply is blocked for this message |
| messages[].sentViaEmail | boolean | yes | Whether the message was actually delivered via email |
| messages[].sentViaSms | boolean | yes | Whether the message was actually delivered via SMS |
| messages[].recipients | array | yes | List of recipient group objects |
| messages[].recipients[].displayOrder | number | yes | Sort order for displaying recipients |
| messages[].recipients[].cssClass | string | yes | CSS class(es) for styling the recipient chip |
| messages[].recipients[].value | string | yes | Class code or identifier for the recipient group |
| messages[].recipients[].valueType | string | yes | Type of the value field: "ClassCode" \| ... |
| messages[].recipients[].targetType | string | yes | Audience type: "Educators" \| "Contacts" \| ... |
| messages[].recipients[].displayName | string | yes | Human-readable recipient label (e.g. "שכבה/ו/כל הורי השכבה") |
| messages[].recipients[].isGroup | boolean | yes | Whether the recipient is a group rather than an individual |

### Example
```json
{
    "conversationId": "51460d74-3914-407c-bcdc-9c8527c45a70",
    "subject": "שינוי שעת סיום  יום לימודים יום ראשון 11.11",
    "sendTime": "2026-01-10T21:24:06",
    "isNew": true,
    "hasDrafts": false,
    "hasAttachments": false,
    "messages": [
        {
            "messageId": "51460d74-3914-407c-bcdc-9c8527c45a70",
            "conversationId": "51460d74-3914-407c-bcdc-9c8527c45a70",
            "senderId": "de8a6540-5876-435e-82db-a268d4c83eb0",
            "senderName": "מורים/אלבז רבקה",
            "subject": "שינוי שעת סיום  יום לימודים יום ראשון 11.11",
            "body": "<p>הורים יקרים,<br>...</p>",
            "lastUpdate": "2026-01-10T21:24:06",
            "sendTime": "2026-01-10T21:24:06",
            "recipients": [
                {
                    "displayOrder": 4,
                    "cssClass": "mshv-contact mshv-contact-teacher",
                    "value": "ו",
                    "valueType": "ClassCode",
                    "targetType": "Educators",
                    "displayName": "שכבה/ו/כל מחנכי השכבה",
                    "isGroup": true
                },
                {
                    "displayOrder": 2,
                    "cssClass": "mshv-contact mshv-contact-parent",
                    "value": "ו",
                    "valueType": "ClassCode",
                    "targetType": "Contacts",
                    "displayName": "שכבה/ו/כל הורי השכבה",
                    "isGroup": true
                }
            ],
            "folder": 2,
            "isNew": true,
            "isDeleted": false,
            "labels": [],
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
```

## cURL
```bash
curl 'https://web.mashov.info/api/mail/conversations/{conversationId}' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/main/mailbox/conversation/{conversationId}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"' \
  -H 'sec-ch-ua-mobile: ?0'
```
