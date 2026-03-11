---
name: Get Student Lessons Count
method: GET
endpoint: https://web.mashov.info/api/students/{studentGuid}/lessonsCount
auth: API key in header
tags: [students, lessons, schedule]
---

## Purpose
Returns the total lesson count and weekly hours per group for a given student across all their enrolled subject groups.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

## Response

### Schema
Response is an **array** of objects, each representing one group enrollment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| studentGuid | string | yes | UUID of the student |
| groupId | number | yes | Unique identifier of the subject group |
| lessonsCount | number | yes | Total number of lessons held so far for this group |
| weeklyHours | number | yes | Weekly scheduled hours for this group |

### Example
```json
[
    {
        "studentGuid": "6a221120-e55e-4c5a-9235-fb265b8d32b7",
        "groupId": 187,
        "lessonsCount": 20,
        "weeklyHours": 1
    },
    {
        "studentGuid": "6a221120-e55e-4c5a-9235-fb265b8d32b7",
        "groupId": 182,
        "lessonsCount": 85,
        "weeklyHours": 6
    }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{studentGuid}/lessonsCount' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/students/{studentGuid}/behaveCounter'
```
