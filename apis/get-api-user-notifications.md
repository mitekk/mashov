---
name: Get User Notifications
method: GET
endpoint: https://web.mashov.info/api/user/notifications
auth: CSRF token in header
tags: [notifications, user]
---

## Purpose
Fetches a paginated list of notifications for the authenticated user, including homework assignments, behavior events, and unread message summaries.

## Request

### Query Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| skip | number | Number of notifications to skip (for pagination) |
| take | number | Number of notifications to return |

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/main/home |

## Response

Returns an array of notification objects. Two variants exist: **system summary** notifications (no `id`, `appName`, or `eventKey`) and **app event** notifications (full fields).

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | number | no | Unique notification ID (absent in system summary notifications) |
| userId | string | yes | UUID of the parent user account |
| appName | string | no | Source app identifier, e.g. `"com.mashov.main"` (absent in system summaries) |
| eventTime | string | yes | ISO 8601 timestamp of when the event occurred |
| eventType | number | yes | Event category: `16` = unread messages summary, `101` = behavior/achievement, `102` = homework assigned |
| eventText | string | yes | Human-readable notification text (in Hebrew) |
| eventKey | string | no | Primary reference key, typically a lesson or entity ID |
| eventKey2 | string | no | Secondary reference key, e.g. event code within a lesson |
| eventData | string | no | JSON-encoded string with detailed event payload (see below) |
| eventUserId | string | no | UUID of the student this event relates to |
| addTime | string | no | ISO 8601 timestamp of when the notification was added |
| readTime | string | no | ISO 8601 timestamp of when the notification was read (present in summary-type events) |

#### `eventData` fields (when present, parsed from JSON string)
| Field | Type | Description |
|-------|------|-------------|
| lessonId | number | Internal lesson ID |
| lessonDate | string | ISO date of the lesson |
| lessonHour | number | Lesson period number within the school day |
| groupId | number | Class/group ID |
| subjectName | string | Subject name in Hebrew |
| studentGuid | string | UUID of the student |
| privateName | string | Student's first name |
| homework | string | Homework description (eventType 102 only) |
| eventCode | number | Behavior event code (eventType 101 only) |
| achvaName | string | Behavior event label in Hebrew (eventType 101 only) |
| justId | number | Justification ID, `-1` means none |
| just | string | Justification text |

### Example
```json
[
    {
        "userId": "dd2c6df1-95d8-4459-93f9-7534fd871ac0",
        "eventTime": "2026-03-10T23:55:55.8547473+02:00",
        "eventType": 16,
        "eventText": "68 שיחות שלא נקראו",
        "readTime": "2026-03-10T23:55:55.8547483+02:00"
    },
    {
        "id": 311822,
        "userId": "dd2c6df1-95d8-4459-93f9-7534fd871ac0",
        "appName": "com.mashov.main",
        "eventTime": "2026-03-05T12:58:04",
        "eventType": 102,
        "eventText": "ניתנו לנלי שיעורי בית במולדת  חברה ואזרחות",
        "eventKey": "8559",
        "eventData": "{\"lessonId\":8559,\"lessonDate\":\"2026-03-05T00:00:00\",\"lessonHour\":5,\"groupId\":184,\"homework\":\"עמ 78 4 שאלות, עמ 81 2 שאלות לענות במחברת או על דף\",\"subjectName\":\"מולדת  חברה ואזרחות\",\"studentGuid\":\"6a221120-e55e-4c5a-9235-fb265b8d32b7\",\"privateName\":\"נלי\"}",
        "eventUserId": "6a221120-e55e-4c5a-9235-fb265b8d32b7",
        "addTime": "2026-03-05T12:58:04"
    },
    {
        "id": 309821,
        "userId": "dd2c6df1-95d8-4459-93f9-7534fd871ac0",
        "appName": "com.mashov.main",
        "eventTime": "2026-02-27T09:11:56",
        "eventType": 101,
        "eventText": "הוזן לנלי אי הכנת ש.ב. בשפה - בתאריך 27.2.26 שיעור 1",
        "eventKey": "8494",
        "eventKey2": "5",
        "eventData": "{\"lessonId\":8494,\"lessonDate\":\"2026-02-27T00:00:00\",\"lessonHour\":1,\"groupId\":181,\"subjectName\":\"שפה\",\"eventCode\":5,\"achvaName\":\"אי הכנת ש.ב.\",\"justId\":-1,\"just\":\"ללא הערות\",\"studentGuid\":\"6a221120-e55e-4c5a-9235-fb265b8d32b7\",\"privateName\":\"נלי\"}",
        "eventUserId": "6a221120-e55e-4c5a-9235-fb265b8d32b7",
        "addTime": "2026-02-27T09:11:55"
    }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/user/notifications?skip=0&take=7' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/home' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
```
