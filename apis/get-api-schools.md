---
name: Get Schools
method: GET
endpoint: https://web.mashov.info/api/schools
auth: None
tags: [schools, reference]
---

## Purpose
Returns the full list of schools registered in the Mashov system, including each school's unique identifier and the academic years for which data is available.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/login |

## Response

### Schema
Array of school objects.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| semel | number | yes | Unique school identifier (Israeli ministry code) |
| name | string | yes | Full school name in Hebrew |
| years | array of number | yes | Academic years for which this school has data available |

### Example
```json
[
  {
    "semel": 100005,
    "name": "חט\"ב אחד העם החדשה - פתח תקווה",
    "years": [2013, 2014, 2015, 2016, 2017, 2018, 2021, 2022, 2023, 2024, 2025]
  },
  {
    "semel": 100006,
    "name": "ישיבת דרך אמונה",
    "years": [2013, 2014, 2015]
  }
]
```

## cURL
```bash
curl 'https://web.mashov.info/api/schools' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*'
```
