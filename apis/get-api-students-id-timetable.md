---
name: Get Student Timetable
method: GET
endpoint: https://web.mashov.info/api/students/{studentId}/timetable
auth: API key in header (X-Csrf-Token)
tags: [students, timetable, schedule]
---

## Purpose
Retrieves the full weekly timetable for a student, including each scheduled lesson's time slot and the associated group/subject/teacher details.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/main/dashboard |

### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| studentId | string (UUID) | The unique identifier of the student |

## Response

Returns an array of timetable entries. Each entry contains a `timeTable` slot and the associated `groupDetails`.

### Schema

**Array item:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| timeTable | object | yes | The scheduled lesson slot |
| timeTable.groupId | number | yes | ID of the class group for this slot |
| timeTable.day | number | yes | Day of the week (1=Sunday ... 6=Friday, Israeli school week) |
| timeTable.lesson | number | yes | Lesson period number within the day (1-based) |
| timeTable.roomNum | string | yes | Room name/number where the lesson takes place; may be empty string |
| timeTable.weeks | number | yes | Week pattern; `-1` indicates all weeks |
| groupDetails | object | yes | Details about the class group for this lesson |
| groupDetails.groupId | number | yes | ID of the class group (matches timeTable.groupId) |
| groupDetails.groupName | string | yes | Display name of the group (e.g. "מתמטיקה ג3") |
| groupDetails.subjectName | string | yes | Subject being taught (e.g. "מתמטיקה") |
| groupDetails.groupTeachers | array | yes | List of currently active teachers for the group |
| groupDetails.groupTeachers[].teacherGuid | string (UUID) | yes | Unique identifier of the teacher |
| groupDetails.groupTeachers[].teacherName | string | yes | Full name of the teacher |
| groupDetails.groupInactiveTeachers | array | yes | List of previously assigned (inactive) teachers; same shape as groupTeachers |

### Example
```json
[
  {
    "timeTable": {
      "groupId": 186,
      "day": 1,
      "lesson": 1,
      "roomNum": "כיתה ג3",
      "weeks": -1
    },
    "groupDetails": {
      "groupId": 186,
      "groupName": "מתמטיקה ג3",
      "subjectName": "מתמטיקה",
      "groupTeachers": [
        {
          "teacherGuid": "f900ccb1-25af-4a36-8124-8a587dbe4c6a",
          "teacherName": "כאדס מנסור"
        }
      ],
      "groupInactiveTeachers": []
    }
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_ID}/timetable' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/dashboard' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
```
