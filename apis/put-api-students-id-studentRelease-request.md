---
name: Update Student Release Request
method: PUT
endpoint: https://web.mashov.info/api/students/{studentGuid}/studentRelease/{releaseId}/request
auth: CSRF token in header
tags: []
---

## Purpose
Updates an existing student release request by its ID, including release date, time, contact, remark, and status.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |

### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| studentGuid | string | UUID of the student |
| releaseId | number | Numeric ID of the release request |

### Body
```json
{
  "id": 84,
  "studentGuid": "38aa0491-4fce-4c30-8113-f4a5310b23a1",
  "contactGuid": "dd2c6df1-95d8-4459-93f9-7534fd871ac0",
  "releaseDate": "2026-03-20T00:00:00",
  "startHour": "09:00:00",
  "remark": "asd1",
  "status": 1,
  "isDeleted": false,
  "requestEditTime": "2026-03-19T21:44:35",
  "releaseDateMoment": "2026-03-20T09:00:00",
  "isExpired": false,
  "isDirty_menu": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | number | yes | Numeric ID of the release request (must match `releaseId` in path) |
| studentGuid | string | yes | UUID of the student (must match `studentGuid` in path) |
| contactGuid | string | yes | UUID of the contact associated with this release |
| releaseDate | string | yes | ISO 8601 date of the release (time component set to `00:00:00`) |
| startHour | string | yes | Time of day for the release in `HH:MM:SS` format |
| remark | string | no | Optional note accompanying the request |
| status | number | yes | Request status: `1` = pending/submitted |
| isDeleted | boolean | yes | Whether the request is soft-deleted |
| requestEditTime | string | yes | ISO 8601 datetime of the last edit |
| releaseDateMoment | string | yes | Combined release date and start hour as ISO 8601 datetime |
| isExpired | boolean | yes | Whether the release date is in the past |
| isDirty_menu | boolean | yes | Internal UI dirty flag — indicates unsaved changes in the menu |

## Response

Empty body. Success is indicated by a 2xx HTTP status code.

## cURL
```bash
curl -X PUT 'https://web.mashov.info/api/students/{STUDENT_GUID}/studentRelease/{RELEASE_ID}/request' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Content-Type: application/json' \
  --data-raw '{"id":{RELEASE_ID},"studentGuid":"{STUDENT_GUID}","contactGuid":"{CONTACT_GUID}","releaseDate":"2026-03-20T00:00:00","startHour":"09:00:00","remark":"asd1","status":1,"isDeleted":false,"requestEditTime":"2026-03-19T21:44:35","releaseDateMoment":"2026-03-20T09:00:00","isExpired":false,"isDirty_menu":true}'
```
