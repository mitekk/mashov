---
name: Get Mail Recipients
method: GET
endpoint: https://web.mashov.info/api/mail/recipients
auth: None
tags: [mail, recipients, messaging]
---

## Purpose
Returns the list of available mail recipients (teachers, parents, and class groups) that a student can send messages to.

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
| displayOrder | number | yes | Sort order for display (observed value: always 0) |
| value | string | yes | UUID uniquely identifying this recipient |
| valueType | string | yes | Type of the value field: `"User"` |
| targetType | string | yes | Target entity type: `"User"` |
| displayName | string | yes | Human-readable name in format `"Group/Name"` (e.g. `"מורים/שם מורה"`, `"כיתה/שכבה/קבוצה/שם"`) |
| comment | string | no | Optional subject/course label associated with the recipient (e.g. `"מתמטיקה"`, `"אנגלית"`) |

### Example
```json
[
  {
    "displayOrder": 0,
    "value": "88748a4c-77d2-4a77-a199-c93332347306",
    "valueType": "User",
    "targetType": "User",
    "displayName": "הורים/קורס ענבל"
  },
  {
    "comment": "מתמטיקה",
    "displayOrder": 0,
    "value": "919e6bd1-2a6b-4c0d-a9f7-e69429a76bd7",
    "valueType": "User",
    "targetType": "User",
    "displayName": "מורים/עינת סהר בירן"
  },
  {
    "displayOrder": 0,
    "value": "6a221120-e55e-4c5a-9235-fb265b8d32b7",
    "valueType": "User",
    "targetType": "User",
    "displayName": "כיתה/ג/3/קורס נלי"
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/mail/recipients' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*'
```
