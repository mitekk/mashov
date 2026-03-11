---
name: Get Student Out-of-School Behavior Records
method: GET
endpoint: https://web.mashov.info/api/students/{studentId}/outBehave
auth: API key in header
tags: [students, behavior]
---

## Purpose
Retrieves a list of out-of-school behavior incidents for a specific student by their GUID.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

## Response

### Schema
Returns an array of out-of-school behavior records. The array is empty when no records exist.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| (unknown) | — | — | Response was an empty array; item schema not yet observed |

### Example
```json
[]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_ID}/outBehave' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*'
```
