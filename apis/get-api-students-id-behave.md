---
name: Get Student Behavior Events
method: GET
endpoint: https://web.mashov.info/api/students/{studentGuid}/behave
auth: API key in header
tags: [students, behavior, attendance]
---

## Purpose
Retrieves all behavior and attendance events for a specific student, including absences, tardiness, positive reinforcements, and disciplinary notes recorded by teachers across lessons.

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

### Query Parameters
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| start | string (ISO 8601 datetime) | no | Returns behavior events from this UTC timestamp onward (example: `2026-02-25T00:00:00Z`) |
| minimal | boolean | no | When `true`, requests a minimal response payload |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| studentGuid | string | yes | UUID of the student this event belongs to |
| eventCode | number | yes | Numeric code for the event type (e.g. 1=tardiness, 2=absence, 4=positive reinforcement, 5=missing homework, 6=missing equipment, 10=not completing in-class tasks, 11=school-activity absence) |
| justified | number | yes | Justification status; `-1` means unjustified/no justification applied |
| lessonId | number | yes | Unique identifier of the specific lesson instance |
| reporterGuid | string | yes | UUID of the teacher who recorded the event |
| timestamp | string | yes | ISO 8601 datetime when the event was recorded (e.g. `"2025-09-02T08:41:54"`) |
| groupId | number | yes | ID of the class group in which the event occurred |
| lessonType | number | yes | Type of lesson; observed value: `1` (regular lesson) |
| lesson | number | yes | Lesson period number within the school day (e.g. 1, 2, 3…) |
| lessonDate | string | yes | ISO 8601 date of the lesson with zero time (e.g. `"2025-09-02T00:00:00"`) |
| lessonReporter | string | yes | UUID of the teacher who reported the lesson (matches `reporterGuid`) |
| achvaCode | number | yes | Achievement/behavior category code (mirrors `eventCode`) |
| achvaName | string | yes | Hebrew display name for the behavior category (e.g. `"חיסור"` = absence, `"חיזוק חיובי"` = positive reinforcement, `"אי הכנת ש.ב."` = missing homework) |
| achvaAval | number | yes | Numeric value/weight of the behavior event; observed as `0` |
| justificationId | number | yes | ID of the justification record; `-1` when no justification exists |
| justification | string | yes | Hebrew justification text; `"ללא הערות"` means "no comments" |
| reporter | string | yes | Display name of the teacher who recorded the event |
| subject | string | yes | Subject name of the lesson in Hebrew (e.g. `"שפה"`, `"מתמטיקה"`, `"אנגלית"`) |
| remark | string | no | Optional free-text remark from the teacher (only present on some events) |

### Example
```json
[
  {
    "studentGuid": "38aa0491-4fce-4c30-8113-f4a5310b23a1",
    "eventCode": 2,
    "justified": -1,
    "lessonId": 14,
    "reporterGuid": "b7f75882-eb56-431e-a0f1-1f582284a93c",
    "timestamp": "2025-09-02T08:41:54",
    "groupId": 424,
    "lessonType": 1,
    "lesson": 1,
    "lessonDate": "2025-09-02T00:00:00",
    "lessonReporter": "b7f75882-eb56-431e-a0f1-1f582284a93c",
    "achvaCode": 2,
    "achvaName": "חיסור",
    "achvaAval": 0,
    "justificationId": -1,
    "justification": "ללא הערות",
    "reporter": "נעה טולדו",
    "subject": "שפה"
  },
  {
    "studentGuid": "38aa0491-4fce-4c30-8113-f4a5310b23a1",
    "eventCode": 4,
    "justified": -1,
    "lessonId": 1055,
    "reporterGuid": "8c2cfc08-b456-4b4f-a801-7daa2c5ea7e4",
    "timestamp": "2025-09-21T09:24:13",
    "groupId": 432,
    "lessonType": 1,
    "lesson": 2,
    "lessonDate": "2025-09-21T00:00:00",
    "lessonReporter": "8c2cfc08-b456-4b4f-a801-7daa2c5ea7e4",
    "achvaCode": 4,
    "achvaName": "חיזוק חיובי",
    "achvaAval": 0,
    "justificationId": -1,
    "justification": "ללא הערות",
    "reporter": "פאתן עתילי",
    "remark": "עבדה יפה והעתיקה מהלוח. כל הכבוד",
    "subject": "אנגלית"
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_GUID}/behave' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/students/{STUDENT_GUID}/behave'
```

### cURL (with query string)
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_GUID}/behave?start=2026-02-25T00:00:00Z&minimal=true' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/dashboard'
```
