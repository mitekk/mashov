---
name: Get Permitted School Activities
method: GET
endpoint: https://web.mashov.info/api/schoolActivities/permitted
auth: Session cookie (X-Csrf-Token header required)
tags: [school-activities, permissions, parental-consent]
---

## Purpose
Fetches the list of school activities (field trips, shows, etc.) that require parental consent/permission for the authenticated student's child.

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
| id | number | yes | Unique activity identifier |
| createTime | string | yes | ISO 8601 datetime when the activity record was created |
| activityStartDate | string | yes | ISO 8601 datetime for the start of the activity |
| activityEndDate | string | yes | ISO 8601 datetime for the end of the activity (same as start for single-day events) |
| activityType | number | yes | Category of activity: `1` = field trip, `2` = recurring/farm activity, `4` = theater/show |
| creatorGuid | string | yes | UUID of the staff member who created the activity |
| title | string | yes | Short Hebrew title of the activity |
| description | string | yes | Full HTML content of the parental permission letter (rich text, RTL Hebrew) |
| endAnswerDate | string | yes | ISO 8601 deadline by which parents must respond |
| isAnswered | boolean | yes | Whether the parent has already submitted a response for this activity |

### Example
```json
[
  {
    "id": 1,
    "createTime": "2025-08-28T13:05:25",
    "activityStartDate": "2025-09-10T00:00:00",
    "activityEndDate": "2026-06-16T00:00:00",
    "activityType": 2,
    "creatorGuid": "118f086c-954d-45fc-bf18-b8af0a93d558",
    "title": "חווה חקלאית",
    "description": "<p>...</p>",
    "endAnswerDate": "2025-09-10T00:00:00",
    "isAnswered": false
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/schoolActivities/permitted' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/schoolActivities'
```
