---
name: Get Student Daily Behavior Events
method: GET
endpoint: https://web.mashov.info/api/students/{studentGuid}/dailyBehave
auth: API key in header
tags: [students, behavior, daily]
---

## Purpose
Retrieves daily behavior events for a specific student. Similar to `/behave` but scoped to daily records rather than per-lesson. Returns an empty array when no daily behavior events exist.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

### Path Parameters
| Parameter | Description |
|-----------|-------------|
| studentGuid | The student's unique UUID identifier |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| — | — | — | Response is an array; schema unknown — endpoint returned `[]`. Expected shape likely mirrors `/behave` items (see `get-api-students-id-behave.md`) |

### Example
```json
[]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_GUID}/dailyBehave' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/students/{STUDENT_GUID}/dailyBehave'
```
