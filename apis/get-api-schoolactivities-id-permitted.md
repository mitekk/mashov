---
name: Get Permitted School Activities
method: GET
endpoint: https://web.mashov.info/api/schoolActivities/{id}/permitted
auth: CSRF token in header
tags: [schoolActivities, activities, permitted]
---

## Purpose
Returns the list of school activities that the current user (parent/student) is permitted to view and respond to, for a given activity group ID.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/main/schoolActivities/{id}/answer |

### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| id | number | School activity group identifier |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | number | yes | Unique activity identifier |
| createTime | string | yes | ISO 8601 datetime when the activity was created |
| activityStartDate | string | yes | ISO 8601 datetime when the activity period begins |
| activityEndDate | string | yes | ISO 8601 datetime when the activity period ends |
| activityType | number | yes | Activity type code (observed: `2`) |
| creatorGuid | string | yes | UUID of the staff member who created the activity |
| title | string | yes | Short display title of the activity (Hebrew) |
| description | string | yes | Full rich-text HTML body with activity details (Hebrew) |
| endAnswerDate | string | yes | ISO 8601 deadline by which the parent/guardian must respond |
| isAnswered | boolean | yes | Whether the current user has already submitted a response |

> **Note:** Response is an array. Each item represents one activity the user is permitted to act on.

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
curl 'https://web.mashov.info/api/schoolActivities/1/permitted' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/main/schoolActivities/1/answer' \
  -H 'Accept: application/json, text/plain, */*'
```
