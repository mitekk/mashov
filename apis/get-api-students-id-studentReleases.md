---
name: Get Student Release Requests
method: GET
endpoint: https://web.mashov.info/api/students/{studentGuid}/studentReleases
auth: CSRF token in header
tags: [students, releases]
---

## Purpose
Retrieves all early release requests submitted for a specific student, including request details, scheduled release time, and approval status.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| studentGuid | string (UUID) | Unique identifier of the student |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | number | yes | Unique release request identifier |
| studentGuid | string | yes | UUID of the student this request belongs to |
| contactGuid | string | yes | UUID of the parent/contact who submitted the request |
| releaseDate | string | yes | Date of the requested early release (ISO 8601, time portion is always `00:00:00`) |
| startHour | string | yes | Time of day the student should be released (HH:MM:SS) |
| remark | string | yes | Free-text note from the parent explaining the reason for release |
| status | number | yes | Request status code: `1` = pending/approved (observed value) |
| isDeleted | boolean | yes | Whether this request has been soft-deleted |
| requestEditTime | string | yes | Timestamp of when the request was last created or edited (ISO 8601) |

### Example
```json
[
    {
        "id": 64,
        "studentGuid": "38aa0491-4fce-4c30-8113-f4a5310b23a1",
        "contactGuid": "88748a4c-77d2-4a77-a199-c93332347306",
        "releaseDate": "2026-01-23T00:00:00",
        "startHour": "11:30:00",
        "remark": "הי, אבקש לשחרר את מיקה קורס מחר בשעה 11:30, יש לה תור לרופא. תודה",
        "status": 1,
        "isDeleted": false,
        "requestEditTime": "2026-01-22T18:28:33"
    },
    {
        "id": 66,
        "studentGuid": "38aa0491-4fce-4c30-8113-f4a5310b23a1",
        "contactGuid": "88748a4c-77d2-4a77-a199-c93332347306",
        "releaseDate": "2026-01-28T00:00:00",
        "startHour": "11:30:00",
        "remark": "אבקש לשחרר את מיקה תודה",
        "status": 1,
        "isDeleted": false,
        "requestEditTime": "2026-01-27T21:46:34"
    }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{studentGuid}/studentReleases' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/studentsReleaseRequests'
```
