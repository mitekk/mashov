---
name: Get Student Homework
method: GET
endpoint: https://web.mashov.info/api/students/{STUDENT_GUID}/homework
auth: CSRF token in header
tags: [homework, students]
---

## Purpose
Retrieves all homework assignments for a specific student across all subjects and groups, including optional file attachments.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

### Path Parameters
| Parameter | Description |
|-----------|-------------|
| STUDENT_GUID | Student's unique UUID (e.g. `38aa0491-4fce-4c30-8113-f4a5310b23a1`) |

## Response

### Schema
Response is an array of homework objects.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| lessonId | number | yes | Unique lesson identifier |
| lessonDate | string | yes | ISO 8601 date of the lesson (e.g. `2025-09-05T00:00:00`) |
| lesson | number | yes | Lesson period number within the school day |
| homework | string | yes | Homework assignment text (Hebrew) |
| groupId | number | yes | Class group identifier |
| remark | string | yes | Lesson topic / teacher's remark (Hebrew) |
| studentGuid | string | yes | Student's unique UUID |
| subjectName | string | yes | Subject name in Hebrew (e.g. `שפה`, `מתמטיקה`, `אנגלית`) |
| files | array | no | Attached files for this homework entry (absent when no attachments) |
| files[].fileId | string | no | UUID of the attached file |
| files[].fileName | string | no | Filename of the attachment (e.g. `IMG_6779.jpeg`) |

### Example
```json
[
  {
    "lessonId": 176,
    "lessonDate": "2025-09-05T00:00:00",
    "lesson": 3,
    "homework": "לסיים עד שאלה 9 בחוברת ״ברגל ימין״",
    "groupId": 424,
    "remark": "הבנת הנקרא - ברגל ימין ",
    "studentGuid": "38aa0491-4fce-4c30-8113-f4a5310b23a1",
    "subjectName": "שפה"
  },
  {
    "files": [
      {
        "fileId": "629aa44b-fc42-4d5c-bc55-a86cc9119da5",
        "fileName": "IMG_6779.jpeg"
      }
    ],
    "lessonId": 780,
    "lessonDate": "2025-09-16T00:00:00",
    "lesson": 3,
    "homework": "שאלות על הלוח",
    "groupId": 424,
    "remark": "כתיבה - המילה סליחה",
    "studentGuid": "38aa0491-4fce-4c30-8113-f4a5310b23a1",
    "subjectName": "שפה"
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_GUID}/homework' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/students/{STUDENT_GUID}/homework'
```
