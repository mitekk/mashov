---
name: Get Achva Types (Behavior Event Types)
method: GET
endpoint: https://web.mashov.info/api/achvas
auth: None
tags: [behavior, achva, reference]
---

## Purpose
Returns the full list of behavior/attendance event types (achvot) defined for the school — used to populate behavior dropdowns and interpret event codes on student behavior records.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

## Response

### Schema
Array of achva (behavior event type) objects.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| code | number | yes | Unique numeric code identifying the event type |
| name | string | yes | Display name of the event (in Hebrew) |
| hidden | boolean | yes | Whether this type is hidden from standard UI listings |
| achvaType | number | yes | Category of the achva; observed value: `1` |
| commonBehaveId | number | yes | Maps to a common/shared behavior category ID |
| onDuplicateLesson | boolean | yes | Whether this event applies when a student has a duplicate lesson |
| onLastBehave | boolean | yes | Whether this event is triggered on the last behavior entry |
| aval | number | yes | Numeric weight/score for the event; `0` = no point impact observed |
| displayOrder | number | yes | Sort order for display in UI |
| teacherId | number | yes | Teacher who owns this type; `0` = school-wide (not teacher-specific) |
| justifiable | boolean | yes | Whether the absence/event can be justified/excused |
| hideFromStudents | boolean | yes | Whether students can see this event type |
| preventPush | boolean | yes | Whether push notifications are suppressed for this event |
| showInBehave | boolean | yes | Whether this type appears in the behavior section UI |

### Example
```json
[
  {
    "code": 1,
    "name": "איחור",
    "hidden": false,
    "achvaType": 1,
    "commonBehaveId": 3,
    "onDuplicateLesson": false,
    "onLastBehave": false,
    "aval": 0,
    "displayOrder": 2,
    "teacherId": 0,
    "justifiable": false,
    "hideFromStudents": false,
    "preventPush": false,
    "showInBehave": false
  },
  {
    "code": 2,
    "name": "חיסור",
    "hidden": false,
    "achvaType": 1,
    "commonBehaveId": 1,
    "onDuplicateLesson": true,
    "onLastBehave": true,
    "aval": 0,
    "displayOrder": 1,
    "teacherId": 0,
    "justifiable": false,
    "hideFromStudents": false,
    "preventPush": false,
    "showInBehave": false
  },
  {
    "code": 11,
    "name": "חיסור בשל פעילות בית‑ספרית",
    "hidden": false,
    "achvaType": 1,
    "commonBehaveId": 1,
    "onDuplicateLesson": false,
    "onLastBehave": false,
    "aval": 0,
    "displayOrder": 11,
    "teacherId": 0,
    "justifiable": true,
    "hideFromStudents": false,
    "preventPush": false,
    "showInBehave": false
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/achvas' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*'
```
