---
name: Login
method: POST
endpoint: https://web.mashov.info/api/login
auth: CSRF token in header
tags: [auth, session]
---

## Purpose
Authenticates a parent/student user and returns a session, credential info, and full access token with school settings and children data.

## Request

### Headers
| Header | Value |
|--------|-------|
| X-Csrf-Token | {CSRF_TOKEN} |
| Content-Type | application/json |
| Accept | application/json, text/plain, */* |
| Referer | https://web.mashov.info/students/login |

### Body
```json
{
  "semel": 482273,
  "year": 2026,
  "username": "{USERNAME}",
  "password": "{PASSWORD}",
  "IsBiometric": false,
  "appName": "info.mashov.students",
  "apiVersion": "3.20210425",
  "appVersion": 3.20210425,
  "appBuild": 3.20210425,
  "deviceUuid": "chrome",
  "devicePlatform": "chrome",
  "deviceManufacturer": "mac",
  "deviceModel": "desktop",
  "deviceVersion": "145.0.0.0"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| semel | number | yes | School identifier code |
| year | number | yes | School year (e.g. 2026) |
| username | string | yes | User's ID number as string |
| password | string | yes | User's password |
| IsBiometric | boolean | yes | Whether biometric auth is used |
| appName | string | yes | App bundle identifier |
| apiVersion | string | yes | API version string |
| appVersion | number | yes | App version number |
| appBuild | number | yes | App build number |
| deviceUuid | string | yes | Device unique identifier or "chrome" for browser |
| devicePlatform | string | yes | Platform: "chrome", "ios", "android" |
| deviceManufacturer | string | yes | Device manufacturer or "mac" |
| deviceModel | string | yes | Device model or "desktop" |
| deviceVersion | string | yes | OS/browser version |

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| sessionId | string | yes | Top-level session UUID |
| credential.sessionId | string | yes | Session UUID (same as top-level) |
| credential.userId | string | yes | User's unique UUID |
| credential.idNumber | number | yes | User's national ID number |
| credential.userType | number | yes | User type code (5 = parent) |
| credential.roleUserType | number | yes | Role-based user type code |
| credential.schoolUserType | number | yes | School-level user type code (2 = parent) |
| credential.idp | string | yes | Identity provider: "Mashov" |
| credential.hasAuthenticated | boolean | yes | Whether standard auth succeeded |
| credential.hasStronglyAuthenticated | boolean | yes | Whether strong/2FA auth was used |
| credential.semel | number | yes | School identifier code |
| credential.year | number | yes | School year |
| credential.displayName | string | yes | Human-readable display name with children listed |
| credential.correlationId | string | yes | Request correlation UUID for tracing |
| accessToken.userSettings.detailsState | number | yes | User details state flag |
| accessToken.userSettings.pushOptions | number | yes | Push notification options bitmask |
| accessToken.schoolSettings.allowStudentsFiles | boolean | yes | Whether students can access files |
| accessToken.schoolSettings.allowStudentsGroupPlans | boolean | yes | Whether students can view group plans |
| accessToken.schoolSettings.allowStudentsReleases | boolean | yes | Whether students can view releases |
| accessToken.schoolSettings.allowStudentsTimeTableAndAlfon | boolean | yes | Whether students can view timetable and contacts |
| accessToken.schoolSettings.allowStudentsToChangePicture | boolean | yes | Whether students can change their profile picture |
| accessToken.schoolSettings.allowStudentsToSendMailToAllTeachers | boolean | yes | Whether students can email all teachers |
| accessToken.schoolSettings.dateRangeLimitForJustificationRequest | number | yes | Max days back for absence justification requests |
| accessToken.schoolSettings.denyStudentsBehave | boolean | yes | Whether behavior data is hidden from students |
| accessToken.schoolSettings.denyStudentsJustificationRequests | boolean | yes | Whether students can submit justification requests |
| accessToken.schoolSettings.denyStudentsLessonsHistory | boolean | yes | Whether lesson history is hidden from students |
| accessToken.schoolSettings.denyStudentsMaakav | boolean | yes | Whether tracking (maakav) is hidden from students |
| accessToken.schoolSettings.denyStudentsPeriodicGrades | boolean | yes | Whether periodic grades are hidden from students |
| accessToken.schoolSettings.denyStudentsRegularGrades | boolean | yes | Whether regular grades are hidden from students |
| accessToken.schoolSettings.denyStudentsTeachersMessages | boolean | yes | Whether teacher messages are hidden from students |
| accessToken.schoolSettings.hasNikud | boolean | yes | Whether the school uses Hebrew nikud (vowels) |
| accessToken.schoolSettings.isClosed | boolean | yes | Whether the school is closed |
| accessToken.schoolSettings.maxPeriodicGrade | number | yes | Maximum score for periodic grades |
| accessToken.schoolSettings.maxRegularGrade | number | yes | Maximum score for regular grades |
| accessToken.schoolSettings.principalId | string | yes | UUID of the school principal |
| accessToken.schoolSettings.schoolName | string | yes | Full school name |
| accessToken.schoolSettings.schoolYear | number | yes | Active school year |
| accessToken.schoolSettings.textualGradesClasses | array[string] | yes | Grade levels that use textual grades (e.g. ["א","ב",...]) |
| accessToken.roles | array | yes | List of user roles (empty for parents) |
| accessToken.rolePermissions | array | yes | List of role permissions (empty for parents) |
| accessToken.children | array[object] | yes | List of the parent's children enrolled at the school |
| accessToken.children[].childGuid | string | yes | Child's unique UUID |
| accessToken.children[].familyName | string | yes | Child's family name (Hebrew) |
| accessToken.children[].privateName | string | yes | Child's first name (Hebrew) |
| accessToken.children[].classCode | string | yes | Class grade code (Hebrew letter, e.g. "ג") |
| accessToken.children[].classNum | number | yes | Class number within the grade |
| accessToken.children[].gender | string | yes | Gender: "נ" (female) or "ז" (male) |
| accessToken.children[].groups | array[number] | yes | List of group IDs the child belongs to |
| accessToken.inactiveChildren | array | yes | Children no longer active at the school |
| accessToken.externChildren | array | yes | External/guest children |
| accessToken.username | string | yes | Authenticated username (ID number) |
| accessToken.lastLogin | string | yes | ISO 8601 datetime of previous login |
| accessToken.lastPassSet | string | yes | ISO 8601 datetime when password was last changed |
| accessToken.displayName | string | yes | Full display name with children summary |
| accessToken.gender | string | yes | Parent gender: "ז" (male) or "נ" (female) |
| accessToken.networks | array | yes | Associated networks (empty if none) |
| accessToken.userSchools | array | yes | Other schools associated with the user |
| accessToken.userSchoolYears | array[number] | yes | School years the user has records for |

### Example
```json
{
  "sessionId": "00000000-0000-0000-0000-000000000000",
  "credential": {
    "sessionId": "00000000-0000-0000-0000-000000000000",
    "userId": "dd2c6df1-95d8-4459-93f9-7534fd871ac0",
    "idNumber": 303977367,
    "userType": 5,
    "roleUserType": 0,
    "schoolUserType": 2,
    "idp": "Mashov",
    "hasAuthenticated": true,
    "hasStronglyAuthenticated": false,
    "semel": 482273,
    "year": 2026,
    "displayName": "קורס דמיטרי [נלי ג3, מיקה ו4]",
    "correlationId": "18eb24cb-51b7-4b80-b202-71f91cffac0a"
  },
  "accessToken": {
    "userSettings": { "detailsState": 0, "pushOptions": 4294967295 },
    "schoolSettings": {
      "schoolName": "יצחק נבון - צור יצחק (יסודי)",
      "schoolYear": 2026,
      "maxRegularGrade": 100,
      "maxPeriodicGrade": 100,
      "textualGradesClasses": ["א","ב","ג","ד","ה","ו"]
    },
    "children": [
      {
        "childGuid": "6a221120-e55e-4c5a-9235-fb265b8d32b7",
        "familyName": "קורס",
        "privateName": "נלי",
        "classCode": "ג",
        "classNum": 3,
        "gender": "נ",
        "groups": [181, 182, 183]
      }
    ],
    "username": "303977367",
    "lastLogin": "2026-03-10T23:17:03",
    "lastPassSet": "2026-03-10T23:02:08",
    "displayName": "קורס דמיטרי [נלי ג3, מיקה ו4]",
    "gender": "ז",
    "userSchoolYears": [2021, 2022, 2023, 2024, 2025, 2026]
  }
}
```

## cURL
```bash
curl -X POST 'https://web.mashov.info/api/login' \
  -H 'X-Csrf-Token: {CSRF_TOKEN}' \
  -H 'Referer: https://web.mashov.info/students/login' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Content-Type: application/json' \
  -d '{
    "semel": 482273,
    "year": 2026,
    "username": "{USERNAME}",
    "password": "{PASSWORD}",
    "IsBiometric": false,
    "appName": "info.mashov.students",
    "apiVersion": "3.20210425",
    "appVersion": 3.20210425,
    "appBuild": 3.20210425,
    "deviceUuid": "chrome",
    "devicePlatform": "chrome",
    "deviceManufacturer": "mac",
    "deviceModel": "desktop",
    "deviceVersion": "145.0.0.0"
  }'
```
