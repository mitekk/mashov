---
name: Delete Student Release
method: DELETE
endpoint: https://web.mashov.info/api/students/{studentId}/studentRelease/{releaseId}
auth: Session cookie + CSRF token
tags: [students, release]
---

## Purpose
Deletes a specific student release record by its ID. Used when cancelling or removing a previously created release request.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| studentId | string (UUID) | The unique identifier of the student |
| releaseId | number | The numeric ID of the release record to delete |

## Response

### Status
`204 No Content` — empty body on success.

### Schema
*(No response body)*

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_ID}/studentRelease/{RELEASE_ID}' \
  -X 'DELETE' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*'
```
