---
name: Get School Bell Schedule
method: GET
endpoint: https://web.mashov.info/api/bells
auth: API key in header (X-Csrf-Token)
tags: [school, timetable, bells, schedule]
---

## Purpose
Retrieves the school's bell schedule — the clock time each lesson period starts and
ends. The resource is **school-wide**, not per-student: the school is implied by the
session's `semel`, so the path takes no identifier.

> **The route exists; its payload shape is still unverified.** Probed live on
> 2026-11-22 with a logged-in session for two schools (semel 484121 and 482273, year
> 2027): `GET /api/bells` answered **HTTP 200 with an empty array** for both. So the
> endpoint is real and reachable — it is not a 404 — but neither school serves any
> period rows, and no live response has ever carried a field to check the names
> against.
>
> The shape below is taken from the open-source `yardnsm/node-mashov` client — `src/api-config.js`
> declares `bells: ${baseUrl}/bells`, `src/controllers/bells.js` maps `e.lessonNumber`,
> `e.startTime` and `e.endTime`, and its fixture carries
> `{"lessonNumber": 1, "startTime": "08:15:00", "endTime": "09:00:00"}`. Treat field names as
> a best guess: the consumer (`backend/src/sync/tasks/bells.task.ts`) treats both an
> empty array and a 404 as a successful no-op and falls back to a bundled default
> schedule (ADR-0037).

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/main/dashboard |

### Path Parameters
None.

## Response

Returns an array of period rows, one per lesson period in the school day. The array
contains **no break rows** — recess is the gap between one period's `endTime` and the
next period's `startTime`, and has to be derived.

### Schema

**Array item:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| lessonNumber | number | yes | Lesson period number within the day (1-based); matches `timeTable.lesson` of [Get Student Timetable](get-api-students-id-timetable.md) |
| startTime | string | yes | Period start, `HH:MM:SS` local school time |
| endTime | string | yes | Period end, `HH:MM:SS` local school time |

### Example
```json
[
  { "lessonNumber": 1, "startTime": "08:15:00", "endTime": "09:00:00" },
  { "lessonNumber": 2, "startTime": "09:00:00", "endTime": "09:45:00" },
  { "lessonNumber": 3, "startTime": "10:00:00", "endTime": "10:45:00" }
]
```

### Errors
| Status | Meaning |
|--------|---------|
| 200 with `[]` | The school serves no bell schedule. Observed on every school probed so far; not an error condition for the sync task. |
| 404 | The endpoint or the school's schedule does not exist. Not an error condition for the sync task either. |
| 401 / 403 | Session expired or the school is not in scope for this login. |

## cURL
```bash
curl 'https://web.mashov.info/api/bells' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/dashboard' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  -b cookies.txt
```
