---
name: Get Student Message Board
method: GET
endpoint: https://web.mashov.info/api/students/{studentId}/messageBoard
auth: CSRF token in header
tags: [students, messages, announcements]
---

## Purpose
Fetches the message board announcements for a specific student, typically shown on the dashboard as school-wide or class notices.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |

### Path Parameters
| Parameter | Description |
|-----------|-------------|
| studentId | UUID of the student (e.g. `6a221120-e55e-4c5a-9235-fb265b8d32b7`) |

## Response

Returns an array of message board event objects.

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| eventid | number | yes | Unique identifier for the message board event |
| eventtext | string | yes | HTML content of the announcement, may include links and RTL text |
| font | string | yes | Font override for display (empty string means default) |
| color | string | yes | Color override for display (empty string means default) |
| expirationDate | string | yes | ISO 8601 datetime when the announcement expires |
| inSite | boolean | yes | Whether the event is displayed in-site (as opposed to external link) |

### Example
```json
[
    {
        "eventid": 61,
        "eventtext": "<p>לקריאת חוק זכויות התלמיד, לחצו על <a href=\"https://he.wikisource.org/wiki/...\">הקישור</a></p>",
        "font": "",
        "color": "",
        "expirationDate": "2039-09-04T00:00:00",
        "inSite": false
    },
    {
        "eventid": 62,
        "eventtext": "<p>למעבר לפורטל הורים באתר משרד החינוך <a href=\"https://parents.education.gov.il/...\" target=\"_blank\">לחצו כאן</a></p>",
        "font": "",
        "color": "",
        "expirationDate": "2039-07-12T00:00:00",
        "inSite": false
    }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/students/{STUDENT_ID}/messageBoard' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://web.mashov.info/students/main/dashboard' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
```
