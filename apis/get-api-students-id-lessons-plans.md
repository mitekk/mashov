---
name: Get Student Lesson Plans
method: GET
endpoint: https://web.mashov.info/api/students/{studentId}/lessons/plans
auth: CSRF token in header
tags: [students, lessons, plans]
---

## Purpose

Retrieves the weekly lesson plans for a specific student, including lesson dates, lesson numbers, and teacher-authored plan text (in Hebrew).

## Request

### Path Parameters

| Parameter | Type          | Description                      |
| --------- | ------------- | -------------------------------- |
| studentId | string (UUID) | Unique identifier of the student |

### Headers

| Header       | Value                             |
| ------------ | --------------------------------- |
| X-Csrf-Token | {CSRF_TOKEN}                      |
| Accept       | application/json, text/plain, _/_ |

## Response

### Schema

| Field      | Type   | Required | Description                                                                         |
| ---------- | ------ | -------- | ----------------------------------------------------------------------------------- |
| groupid    | number | yes      | Identifier of the class/group this lesson belongs to                                |
| lessondate | string | yes      | Date of the lesson in ISO 8601 format (`YYYY-MM-DDT00:00:00`)                       |
| lesson     | number | yes      | Lesson period number within the school day                                          |
| plan       | string | yes      | Teacher-authored lesson plan text (Hebrew); may include multiline content with `\n` |

### Example

```json
[
  {
    "groupid": 181,
    "lessondate": "2025-09-12T00:00:00",
    "lesson": 1,
    "plan": "טקסט קריאה מה מוזר בציור?\nמילים להכתבה: ביקר, ראה, חטפה, התבונן, התפלא, שאל, ענה, מתחבאת, תחכה, ברחה"
  },
  {
    "groupid": 181,
    "lessondate": "2025-09-19T00:00:00",
    "lesson": 1,
    "plan": "הכתבה + קריאה מונחית"
  },
  {
    "groupid": 181,
    "lessondate": "2025-10-17T00:00:00",
    "lesson": 1,
    "lessonLink": "https://edu-il.zoom.us/j/8167152718pwd=TDFhekk3UHVtZXNVOTE2dVNabU13QT09",
    "plan": "הכתבה"
  }
]
```

## cURL

```bash
curl 'https://web.mashov.info/api/students/{studentId}/lessons/plans' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/students/{studentId}/weeklyPlan'
```
