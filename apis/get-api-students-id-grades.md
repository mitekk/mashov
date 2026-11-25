---
name: Get Student Grades
method: GET
endpoint: https://web.mashov.info/api/students/{studentGuid}/grades
auth: API key in header
tags: [students, grades, assessments]
---

## Purpose
Retrieves every graded assessment event for a specific student in the current school year — tests, quizzes, graded assignments and alternative assessments — including the numeric grade, the teacher, the class group and the subject.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Cookie | MashovAuthToken={AUTH_TOKEN}; Csrf-Token={CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

### Path Parameters
| Parameter | Description |
|-----------|-------------|
| studentGuid | The student's unique UUID identifier |

## Response

Returns an array of grade objects. Schema below describes a single array item.

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| year | number | yes | School year the grade belongs to (Mashov uses the Gregorian year the school year ends in, e.g. `2027`) |
| studentGuid | string | yes | UUID of the student this grade belongs to (matches the path parameter) |
| gradingEventId | number | yes | Identifier of the grading event (the test/assignment); equals `id` in observed data |
| grade | number | yes | The numeric grade awarded, 0–100 (observed range 58–100) |
| rate | number | yes | Weight of this grade within the subject; `0.0` in all observed rows (unweighted) |
| timestamp | string | yes | ISO 8601 local datetime when the teacher entered the grade (e.g. `"2026-11-24T15:28:44"`) |
| teacherName | string | yes | Display name of the teacher who awarded the grade, in Hebrew (e.g. `"קליין יעל"`) |
| groupId | number | yes | ID of the class group (subject + class) the grading event belongs to |
| groupName | string | yes | Hebrew name of the class group, subject plus class (e.g. `"מתמטיקה ז8"`) |
| subjectName | string | yes | Hebrew subject name (e.g. `"מתמטיקה"`, `"אנגלית"`, `"היסטוריה"`) |
| eventDate | string | yes | ISO 8601 date of the assessment itself with zero time (e.g. `"2026-11-19T00:00:00"`); can be earlier than `timestamp` |
| id | number | yes | Unique identifier of the grade record; mirrors `gradingEventId` |
| gradingPeriod | number | yes | Grading period / term number within the school year; observed value: `1` |
| gradingEvent | string | yes | Free-text title of the assessment in Hebrew (occasionally English, e.g. `"Sports Camp"`) |
| gradeRate | number | yes | Contribution of this grade to the subject average; `0.0` in all observed rows |
| gradeTypeId | number | yes | Numeric assessment-type code: `1`=מבחן (test), `2`=בוחן (quiz), `3`=הערכה חלופית - עבודה עצמאית (alternative assessment, individual work), `4`=הערכה חלופית - עבודת צוות (alternative assessment, team work), `7`=מטלה עם ציון (graded assignment) |
| gradeType | string | yes | Hebrew display name of the assessment type, matching `gradeTypeId`: `"מבחן"` \| `"בוחן"` \| `"הערכה חלופית - עבודה עצמאית"` \| `"הערכה חלופית - עבודת צוות"` \| `"מטלה עם ציון"` |

### Example
```json
[
  {
    "year": 2027,
    "studentGuid": "f05a6898-b0e6-4ea0-929d-3bd88b985c2c",
    "gradingEventId": 18,
    "grade": 93,
    "rate": 0.0,
    "timestamp": "2026-09-17T14:04:41",
    "teacherName": "קליין יעל",
    "groupId": 202,
    "groupName": "מתמטיקה ז8",
    "subjectName": "מתמטיקה",
    "eventDate": "2026-09-16T00:00:00",
    "id": 18,
    "gradingPeriod": 1,
    "gradingEvent": "2 מטלות (ממוצע) היכרות עם מערכת צירים ונקודות הנמצאות על קטעים מקבילים",
    "gradeRate": 0.0,
    "gradeTypeId": 7,
    "gradeType": "מטלה עם ציון"
  },
  {
    "year": 2027,
    "studentGuid": "f05a6898-b0e6-4ea0-929d-3bd88b985c2c",
    "gradingEventId": 427,
    "grade": 98,
    "rate": 0.0,
    "timestamp": "2026-11-11T00:17:32",
    "teacherName": "פדילה סגוד",
    "groupId": 177,
    "groupName": "אנגלית ז8",
    "subjectName": "אנגלית",
    "eventDate": "2026-11-10T00:00:00",
    "id": 427,
    "gradingPeriod": 1,
    "gradingEvent": "מבחן אנגלית",
    "gradeRate": 0.0,
    "gradeTypeId": 1,
    "gradeType": "מבחן"
  },
  {
    "year": 2027,
    "studentGuid": "f05a6898-b0e6-4ea0-929d-3bd88b985c2c",
    "gradingEventId": 681,
    "grade": 100,
    "rate": 0.0,
    "timestamp": "2026-11-25T10:10:54",
    "teacherName": "לוי אמיר דור",
    "groupId": 199,
    "groupName": "היסטוריה ז8",
    "subjectName": "היסטוריה",
    "eventDate": "2026-11-25T00:00:00",
    "id": 681,
    "gradingPeriod": 1,
    "gradingEvent": "הצגת אתר נוצרי בישראל",
    "gradeRate": 0.0,
    "gradeTypeId": 4,
    "gradeType": "הערכה חלופית - עבודת צוות"
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_GUID}/grades' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -b 'Csrf-Token={CSRF_TOKEN}; MashovAuthToken={AUTH_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/main/students/{STUDENT_GUID}/regularGrades'
```
