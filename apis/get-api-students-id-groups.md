---
name: Get Student Groups
method: GET
endpoint: https://web.mashov.info/api/students/{studentId}/groups
auth: API key in header
tags: [students, groups]
---

## Purpose
Returns all study groups a student is enrolled in, including each group's subject name and assigned teachers (active and inactive).

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

## Response

### Schema
Array of group objects.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| groupId | number | yes | Unique numeric identifier for the group |
| groupName | string | yes | Display name of the group (subject + class, e.g. "מתמטיקה ג3") |
| subjectName | string | yes | Name of the subject taught in this group |
| groupTeachers | array | yes | List of currently active teachers assigned to the group |
| groupTeachers[].teacherGuid | string | yes | Unique UUID identifier for the teacher |
| groupTeachers[].teacherName | string | yes | Full name of the active teacher |
| groupInactiveTeachers | array | yes | List of teachers who are no longer active in this group (may be empty) |
| groupInactiveTeachers[].teacherGuid | string | yes | Unique UUID identifier for the inactive teacher |
| groupInactiveTeachers[].teacherName | string | yes | Full name of the inactive teacher |

### Example
```json
[
  {
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
  },
  {
    "groupId": 194,
    "groupName": "אומנות ג3",
    "subjectName": "אומנות",
    "groupTeachers": [
      {
        "teacherGuid": "15ddf956-82ab-4fb3-ba0a-0c2ce2d3372c",
        "teacherName": "עטרה ברכה ענויאן טייב"
      }
    ],
    "groupInactiveTeachers": [
      {
        "teacherGuid": "210618fe-52bc-46a6-88a3-7cb09bf36168",
        "teacherName": "סיאור מרעי"
      }
    ]
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{studentId}/groups' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/students/{studentId}/behaveCounter' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-ch-ua-mobile: ?0'
```
