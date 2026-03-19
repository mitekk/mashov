---
name: Get Student Lesson History
method: GET
endpoint: https://web.mashov.info/api/students/{studentId}/lessons/history
auth: None (session cookie / CSRF token)
tags: [students, lessons]
---

## Purpose
Returns the full lesson history for a specific student — each entry includes the group name, subject name, and lesson log details such as date, remarks, and homework.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| studentId | string (UUID) | Unique identifier of the student |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| [].groupName | string | yes | Display name of the class group (e.g. "שפה ג3") |
| [].subjectName | string | yes | Subject being taught (e.g. "שפה") |
| [].lessonLog.lessonID | number | yes | Unique lesson identifier |
| [].lessonLog.groupId | number | yes | Numeric ID of the class group |
| [].lessonLog.lessonDate | string (ISO 8601) | yes | Date the lesson took place, time component is always midnight |
| [].lessonLog.lesson | number | yes | Lesson period/slot number within the school day |
| [].lessonLog.tookPlace | boolean | yes | Whether the lesson actually occurred |
| [].lessonLog.remark | string | yes | Teacher's note about what was covered in the lesson |
| [].lessonLog.homeWork | string | no | Homework instructions assigned during the lesson (absent when no homework) |
| [].lessonLog.lessontype | number | yes | Lesson type code; observed value: `0` |
| [].lessonLog.reporterid | number | yes | Numeric reporter ID; observed value: `0` |
| [].lessonLog.reporterGuid | string (UUID) | yes | UUID of the teacher/reporter who logged the lesson |

### Example
```json
[
    {
        "groupName": "שפה ג3",
        "subjectName": "שפה",
        "lessonLog": {
            "lessonID": 157,
            "groupId": 181,
            "lessonDate": "2025-09-05T00:00:00",
            "lesson": 1,
            "tookPlace": true,
            "remark": "קריאת טקסט",
            "lessontype": 0,
            "reporterid": 0,
            "reporterGuid": "a7246be3-18b8-45dd-874c-fa426d022348"
        }
    },
    {
        "groupName": "שפה ג3",
        "subjectName": "שפה",
        "lessonLog": {
            "lessonID": 537,
            "groupId": 181,
            "lessonDate": "2025-09-12T00:00:00",
            "lesson": 1,
            "tookPlace": true,
            "remark": "טקסט קריאה-מה מוזר בציור?",
            "homeWork": "הילדים קיבלו טקסט קריאה. עליהם לקרוא לכם או לבן משפחה אחר לפחות 3 פעמים ויש לחתום על הדף.",
            "lessontype": 0,
            "reporterid": 0,
            "reporterGuid": "a7246be3-18b8-45dd-874c-fa426d022348"
        }
    }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{studentId}/lessons/history' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/students/{studentId}/weeklyPlan' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
```
