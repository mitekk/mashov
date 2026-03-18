# API Contract: Mashov School Parent Command Center

**Version:** Phase 1 (implemented) + Phase 2 (planned)
**PRD source:** `docs/prd/PRD-current.md` (v2 active)
**Status:** Phase 1 endpoints `implemented`; Phase 2 endpoints `planned`
**Auth:** Phase 1 = no auth. Phase 2 = all `/api/v1/*` require session cookie except auth endpoints and `/health`

> This table is the source of truth for backend and frontend agents. Update it when routes change. All paths use the `/api/v1` prefix. All IDs are UUIDs (strings). All timestamps are ISO 8601 UTC. Pagination uses `page` + `limit` with the standard envelope.

---

## Standard Response Envelopes

### Success (list with pagination)
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 143,
    "totalPages": 8
  }
}
```

### Error
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Student not found",
    "details": []
  }
}
```

---

## Endpoints

| Method | Path | Auth? | Request Body / Query Params | Response Body | Status Codes | Status |
|--------|------|-------|----------------------------|---------------|-------------|--------|
**Phase 2 auth note:** All Phase 1 endpoints below change from `Auth: No` → `Auth: Yes` in Phase 2. Status changes to `changed`. The `/health` endpoint remains unauthenticated.

### Phase 2 — New Auth & Connection Endpoints

| Method | Path | Auth? | Request Body / Query Params | Response Body | Status Codes | Status |
|--------|------|-------|----------------------------|---------------|-------------|--------|
| GET | `/api/v1/auth/schools` | No | — | `Array<{ semel: number, name: string, years: number[] }>` | 200, 502 | planned |
| POST | `/api/v1/auth/login` | No | `{ semel: number, username: string, password: string }` | `{ ok: true, isFirstLogin: boolean }` (sets httpOnly session cookie) | 200, 400, 401, 429 | planned |
| DELETE | `/api/v1/auth/session` | Yes | — | `{ ok: true }` | 200, 401 | planned |
| GET | `/api/v1/auth/me` | Yes | — | `{ mashovUserId: string, username: string, displayName: string, connectedSchool: { schoolName: string, schoolYear: number } \| null }` | 200, 401 | planned |
| PUT | `/api/v1/connection` | Yes | `{ username?: string, password?: string }` | `{ ok: true }` | 200, 400, 401, 404 | planned |
| DELETE | `/api/v1/connection` | Yes | — | `{ ok: true }` | 200, 401, 404 | planned |
| GET | `/api/v1/sync/status` | Yes | — | `{ done: boolean, sourcesCompleted: number, sourcesTotal: number }` | 200, 401 | planned |

### Phase 1 Endpoints (all require Auth: Yes in Phase 2)

| Method | Path | Auth? | Request Body / Query Params | Response Body | Status Codes | Status |
|--------|------|-------|----------------------------|---------------|-------------|--------|
| GET | `/health` | No | — | `{ status: "ok" \| "degraded", db: "connected" \| "error" }` | 200 | implemented |
| GET | `/api/v1/dashboard` | **Yes** (Phase 2) | — | See [Dashboard Response](#get-apiv1dashboard) | 200, 401 | changed |
| GET | `/api/v1/feed` | **Yes** (Phase 2) | `?page=1&limit=20` | See [Feed Response](#get-apiv1feed) | 200, 401 | changed |
| GET | `/api/v1/children` | **Yes** (Phase 2) | — | See [Children List Response](#get-apiv1children) | 200, 401 | changed |
| GET | `/api/v1/children/:studentGuid` | **Yes** (Phase 2) | — | See [Child Workspace Response](#get-apiv1childrenstudentguid) | 200, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/homework` | **Yes** (Phase 2) | `?page=1&limit=50&status=all\|new\|archived` (`all` excludes archived) | See [Homework Response](#get-apiv1childrenstudentguidhomework) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/:homeworkId/is-new` | **Yes** (Phase 2) | `{ isNew: boolean }` | See [Homework Item](#homework-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/:homeworkId/archive` | **Yes** (Phase 2) | `{ isArchived: boolean }` | See [Homework Item](#homework-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/is-new` | **Yes** (Phase 2) | `{ homeworkIds: string[], isNew: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/homework/archive` | **Yes** (Phase 2) | `{ homeworkIds: string[], isArchived: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/behavior` | **Yes** (Phase 2) | `?page=1&limit=50&bucket=all\|attention\|positive\|neutral&status=all\|new\|archived` (`all` excludes archived) | See [Behavior Response](#get-apiv1childrenstudentguidbehavior) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/:behaviorId/is-new` | **Yes** (Phase 2) | `{ isNew: boolean }` | See [Behavior Item](#behavior-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/:behaviorId/archive` | **Yes** (Phase 2) | `{ isArchived: boolean }` | See [Behavior Item](#behavior-item-shape) | 200, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/is-new` | **Yes** (Phase 2) | `{ behaviorIds: string[], isNew: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| PUT | `/api/v1/children/:studentGuid/behavior/archive` | **Yes** (Phase 2) | `{ behaviorIds: string[], isArchived: boolean }` | `{ updated: number }` | 200, 400, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/subjects` | **Yes** (Phase 2) | — | See [Subjects Response](#get-apiv1childrenstudentguidsubjects) | 200, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/notices` | **Yes** (Phase 2) | — | See [Notices Response](#get-apiv1childrenstudentguidnotices) | 200, 401, 404 | changed |
| GET | `/api/v1/children/:studentGuid/timetable` | **Yes** (Phase 2) | — | See [Timetable Response](#get-apiv1childrenstudentguidtimetable) | 200, 401, 404 | changed |
| GET | `/api/v1/mail/summary` | **Yes** (Phase 2) | — | See [Mail Summary Response](#get-apiv1mailsummary) | 200, 401 | changed |
| GET | `/api/v1/mail/conversations` | **Yes** (Phase 2) | `?page=1&limit=20&filter=all\|new\|archived` | See [Conversations List Response](#get-apiv1mailconversations) | 200, 401 | changed |
| GET | `/api/v1/mail/conversations/:id` | **Yes** (Phase 2) | — | See [Conversation Detail Response](#get-apiv1mailconversationsid) | 200, 401, 404 | changed |
| PUT | `/api/v1/mail/conversations/mark-read` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| PUT | `/api/v1/mail/conversations/mark-unread` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| PUT | `/api/v1/mail/conversations/archive` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| PUT | `/api/v1/mail/conversations/unarchive` | **Yes** (Phase 2) | `{ conversationIds: string[] }` | `{ updated: number }` | 200, 400, 401 | changed |
| GET | `/api/v1/settings/source-health` | **Yes** (Phase 2) | — | See [Source Health Response](#get-apiv1settingssource-health) | 200, 401 | changed |
| GET | `/api/v1/settings/profile` | **Yes** (Phase 2) | — | See [Profile Response](#get-apiv1settingsprofile) | 200, 401 | changed |
| POST | `/api/v1/sync/refresh` | **Yes** (Phase 2) | — | `{ started: true, message: string }` | 202, 401 | changed |

---

## Response Body Schemas

### GET /api/v1/dashboard

```typescript
{
  freshness: {
    state: "fresh" | "syncing" | "stale" | "degraded";
    lastSyncAt: string | null;           // ISO 8601, most recent successful sync across all sources
    staleSources: string[];              // source names that are past their stale threshold
  };
  summary: {
    unreadConversations: number;         // from mail_conversation.isUnread count
    recentHomeworkCount: number;         // homework_item in last 7 days
    recentBehaviorCount: number;         // behavior_item in last 7 days
    childrenCount: number;               // active student count
  };
  feed: Array<{                          // max 20 items; full feed via GET /api/v1/feed
    id: string;
    sourceType: "homework" | "behavior" | "mail" | "positive";
    sourceId: string;
    studentGuid: string | null;
    studentName: string | null;
    title: string;
    summary: string;
    category: string;
    priority: "high" | "medium" | "low";
    isPositive: boolean;
    isUnread: boolean;
    isHandled: boolean;
    eventAt: string;                     // ISO 8601
    syncedAt: string;                    // ISO 8601
    linkPath: string;
  }>;
  children: Array<{
    studentGuid: string;
    privateName: string;
    familyName: string;
    fullName: string;
    classCode: string;
    classNum: number;
    recentHomeworkCount: number;
    recentBehaviorCount: number;
    latestUpdateAt: string | null;       // ISO 8601
    oneLineStatus: string;               // e.g. "3 homework items, 1 behavior event"
  }>;
  school: {
    schoolName: string;
    schoolYear: number;
  };
}
```

### GET /api/v1/feed

```typescript
{
  data: Array<{
    id: string;
    sourceType: "homework" | "behavior" | "mail" | "positive";
    sourceId: string;
    studentGuid: string | null;
    studentName: string | null;
    title: string;
    summary: string;
    category: string;
    priority: "high" | "medium" | "low";
    isPositive: boolean;
    isUnread: boolean;
    isHandled: boolean;
    eventAt: string;                     // ISO 8601
    syncedAt: string;                    // ISO 8601
    linkPath: string;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### GET /api/v1/children

```typescript
{
  data: Array<{
    studentGuid: string;
    privateName: string;
    familyName: string;
    fullName: string;
    classCode: string;                   // Hebrew letter, e.g. "ג"
    classNum: number;
    gender: string;                      // "נ" | "ז"
    isActive: boolean;
    recentHomeworkCount: number;         // last 7 days
    recentBehaviorCount: number;         // last 7 days
    subjectCount: number;
    latestUpdateAt: string | null;       // ISO 8601
  }>;
}
```

### GET /api/v1/children/:studentGuid

```typescript
{
  student: {
    studentGuid: string;
    privateName: string;
    familyName: string;
    fullName: string;
    classCode: string;
    classNum: number;
    gender: string;
    isActive: boolean;
  };
  summary: {
    recentHomeworkCount: number;         // last 7 days
    recentBehaviorCount: number;         // last 7 days
    subjectCount: number;
    totalWeeklyHours: number;            // sum of subject_enrollment.weeklyHours
    attentionBehaviorCount: number;      // behavior items in Attention bucket, last 7 days
  };
  lastSyncAt: string | null;            // ISO 8601, latest sync_run.endedAt for this child's sources
}
```

### GET /api/v1/children/:studentGuid/homework

Query param semantics for `status`:
- `new` → `isNew=true` and `isArchived=false`
- `all` → all non-archived items (`isArchived=false`), regardless of `isNew`
- `archived` → archived items only (`isArchived=true`)

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    lessonId: number;
    groupId: number;
    lessonDate: string;                  // ISO 8601 date, e.g. "2026-03-05T00:00:00Z"
    lesson: number;                      // period number
    subjectName: string;                 // Hebrew
    homeworkText: string;                // Hebrew
    remark: string | null;               // lesson topic / teacher remark
    files: Array<{
      fileId: string;
      fileName: string;
    }>;
    isNew: boolean;                      // true until explicitly dismissed
    isArchived: boolean;                 // soft-archived by the parent
    updatedAt: string;                   // ISO 8601
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

#### Homework Item Shape

Used in both list and mutation responses:

```typescript
{
  id: string;
  studentGuid: string;
  lessonId: number;
  groupId: number;
  lessonDate: string;
  lesson: number;
  subjectName: string;
  homeworkText: string;
  remark: string | null;
  files: Array<{ fileId: string; fileName: string; }>;
  isNew: boolean;
  isArchived: boolean;
  updatedAt: string;
}
```

### PUT /api/v1/children/:studentGuid/homework/is-new

```typescript
// Request
{
  homeworkIds: string[];
  isNew: boolean;
}

// Response
{
  updated: number;
}
```

### PUT /api/v1/children/:studentGuid/homework/archive

```typescript
// Request
{
  homeworkIds: string[];
  isArchived: boolean;
}

// Response
{
  updated: number;
}
```

### GET /api/v1/children/:studentGuid/behavior

Query param semantics for `status`:
- `new` → `isNew=true` and `isArchived=false`
- `all` → all non-archived items (`isArchived=false`), regardless of `isNew`
- `archived` → archived items only (`isArchived=true`)

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    lessonId: number;
    groupId: number;
    eventCode: number;
    achvaCode: number;
    achvaName: string;                   // Hebrew label
    bucket: "attention" | "positive" | "neutral";
    priority: "high" | "medium" | "low";
    justifiable: boolean;
    lessonDate: string;                  // ISO 8601
    lesson: number | null;               // period number
    subject: string;                     // Hebrew
    reporter: string;                    // teacher name
    remark: string | null;               // null if "ללא הערות" or empty
    justification: string | null;        // null if "ללא הערות" or empty
    eventAt: string;                     // ISO 8601
    isNew: boolean;                      // true until explicitly dismissed
    isArchived: boolean;                 // soft-archived by the parent
    updatedAt: string;                   // ISO 8601
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

#### Behavior Item Shape

Used in both list and mutation responses:

```typescript
{
  id: string;
  studentGuid: string;
  lessonId: number;
  groupId: number;
  eventCode: number;
  achvaCode: number;
  achvaName: string;
  bucket: "attention" | "positive" | "neutral";
  priority: "high" | "medium" | "low";
  justifiable: boolean;
  lessonDate: string;
  lesson: number | null;
  subject: string;
  reporter: string;
  remark: string | null;
  justification: string | null;
  eventAt: string;
  isNew: boolean;
  isArchived: boolean;
  updatedAt: string;
}
```

### PUT /api/v1/children/:studentGuid/behavior/is-new

```typescript
// Request
{
  behaviorIds: string[];
  isNew: boolean;
}

// Response
{
  updated: number;
}
```

### PUT /api/v1/children/:studentGuid/behavior/archive

```typescript
// Request
{
  behaviorIds: string[];
  isArchived: boolean;
}

// Response
{
  updated: number;
}
```

### GET /api/v1/children/:studentGuid/subjects

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    groupId: number;
    groupName: string;                   // e.g. "מתמטיקה ג3"
    subjectName: string;                 // Hebrew
    teachers: Array<{
      teacherGuid: string;
      teacherName: string;
    }>;
    inactiveTeachers: Array<{
      teacherGuid: string;
      teacherName: string;
    }>;
    weeklyHours: number;
    lessonsCount: number;                // lessons held so far
    updatedAt: string;                   // ISO 8601
  }>;
}
```

### GET /api/v1/children/:studentGuid/notices

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    eventId: number;
    eventText: string;                   // sanitized HTML (DOMPurify applied before storage)
    expirationDate: string;              // ISO 8601 — only non-expired items returned
    inSite: boolean;
    updatedAt: string;                   // ISO 8601
  }>;
}
```

### GET /api/v1/children/:studentGuid/timetable

Returns the student's weekly timetable. Synced weekly (Sunday 03:00). Returns an empty array when no data has been synced yet.

```typescript
{
  data: Array<{
    id: string;
    studentGuid: string;
    groupId: number;
    day: number;                         // 1=Sunday … 6=Friday (Israeli school week)
    lesson: number;                      // period number within the day
    roomNum: string;                     // empty string if not set
    weeks: number;                       // -1 = all weeks; positive = specific week mask
    groupName: string;                   // e.g. "מתמטיקה ג3"
    subjectName: string;                 // Hebrew subject name
    teachers: Array<{
      teacherGuid: string;
      teacherName: string;
    }>;
    updatedAt: string;                   // ISO 8601
  }>;
}
```

### GET /api/v1/mail/summary

```typescript
{
  newCount: number;                      // authoritative from mail_conversation.isNew count
  recentConversations: Array<{           // top 3 most recent new/unread, for home screen preview
    conversationId: string;
    subject: string;
    senderNamePreview: string;
    sendTime: string;                    // ISO 8601
    isNew: boolean;
    hasAttachments: boolean;
    preventReply: boolean;
  }>;
  lastSyncAt: string | null;            // ISO 8601
}
```

### GET /api/v1/mail/conversations

Query params: `page=1`, `limit=20`, `filter=all|new|archived`

```typescript
{
  data: Array<{
    conversationId: string;
    subject: string;
    senderNamePreview: string;           // from messages[0].senderName
    sendTime: string;                    // ISO 8601
    isNew: boolean;                      // matches upstream isNew / unread state
    hasDrafts: boolean;
    hasAttachments: boolean;
    preventReply: boolean;
    labels: string[];
    lastFetchedAt: string;               // ISO 8601
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### GET /api/v1/mail/conversations/:id

Note: If `bodyHtmlSanitized` is null in DB (not yet fetched), backend lazily fetches from upstream, sanitizes, stores, and returns.

```typescript
{
  conversationId: string;
  subject: string;
  sendTime: string;                      // ISO 8601
  isNew: boolean;                        // matches upstream isNew / unread state
  hasDrafts: boolean;
  hasAttachments: boolean;
  preventReply: boolean;
  labels: string[];
  messages: Array<{
    messageId: string;
    conversationId: string;
    senderId: string;
    senderName: string;                  // e.g. "מורים/מעיינה סגל"
    subject: string;
    bodyHtmlSanitized: string;           // DOMPurify-sanitized HTML
    bodyTextPreview: string;             // first 200 chars of stripped HTML
    sendTime: string;                    // ISO 8601
    isNew: boolean;
    recipients: Array<{
      displayOrder: number;
      displayName: string;               // Hebrew label, e.g. "שכבה/ו/כל הורי השכבה"
      valueType: string;                 // "ClassCode" | ...
      targetType: string;                // "Educators" | "Contacts" | ...
      isGroup: boolean;
    }>;
    preventReply: boolean;
    sentViaEmail: boolean;
    sentViaSms: boolean;
  }>;
  lastFetchedAt: string;                 // ISO 8601
}
```

### GET /api/v1/settings/source-health

```typescript
{
  sources: Array<{
    source: string;                      // e.g. "notifications", "homework:studentGuid", "mail_inbox"
    status: "fresh" | "stale" | "failed" | "never_synced";
    lastSuccessAt: string | null;        // ISO 8601
    lastAttemptAt: string | null;        // ISO 8601
    lastErrorMessage: string | null;
    fetchedCount: number | null;
    staleThresholdMinutes: number;
  }>;
  overallState: "fresh" | "syncing" | "stale" | "degraded";
  lastFullSyncAt: string | null;         // ISO 8601
}
```

### GET /api/v1/settings/profile

```typescript
{
  upstreamUserId: string;
  displayName: string;
  email: string;
  cellphone: string;
  schoolName: string;
  schoolYear: number;
  schoolCode: number;
  detailsState: number;
  updatedAt: string;                     // ISO 8601
}
```

---

## Upstream Mashov API Reference (Backend Internal Use Only)

These are the upstream API calls made by the NestJS sync engine. The frontend never calls these.

| Method | Upstream Path | Used By |
|--------|--------------|---------|
| GET | `https://web.mashov.info/api/schools` | AuthController — school list for login form (proxied to frontend, no auth required) |
| GET | `https://web.mashov.info/students/login` | MashovSessionService — CSRF bootstrap |
| POST | `/api/login` | MashovSessionService — authenticate; also called by AuthController on user login |
| GET | `/api/user/notifications?skip=0&take=50` | NotificationSyncTask |
| GET | `/api/mail/counts?$select=unreadConversations` | MailCountSyncTask |
| GET | `/api/mail/inbox/conversations?skip=0&take=50` | InboxSyncTask |
| GET | `/api/students/{childGuid}/homework` | HomeworkSyncTask (per child) |
| GET | `/api/students/{studentGuid}/behave` | BehaviorSyncTask (per child) |
| GET | `/api/students/{studentId}/groups` | DailyGroupsTask (per child) |
| GET | `/api/students/{studentGuid}/lessonsCount` | DailyLessonsCountTask (per child) |
| GET | `/api/students/{childGuid}/messageBoard` | DailyMessageBoardTask (per child) |
| GET | `/api/achvas` | DailyAchvasTask |
| GET | `/api/user/details` | DailyUserDetailsTask |
| GET | `/api/mail/recipients` | DailyMailRecipientsTask (optional) |
| GET | `/api/mail/conversations/{conversationId}` | MailController — lazy detail fetch |
| PUT | `/api/mail/conversations/markAsUnread` | MailActionController — mark-unread proxy |
| PUT | `/api/mail/conversations/move/archive` | MailActionController — archive proxy |
| GET | `/api/students/{childGuid}/dailyBehave` | DailyBehaveSyncTask (feature-flagged) |
| GET | `/api/students/{studentId}/outBehave` | OutBehaveSyncTask (feature-flagged) |

---

## Notes

1. **`PUT /api/v1/mail/conversations/mark-unread` and `PUT archive`** — these are proxy actions that call the upstream Mashov API directly and also update local `mail_conversation.isNew` state in DB. `mark-read`, `unarchive` are local-only operations.
2. **`GET /api/v1/mail/conversations/:id`** — the response includes sanitized HTML body. The first call for a conversation that has not been detail-fetched will be slightly slower (upstream proxy + sanitize + store). Subsequent calls return from DB.
3. **Notices** — only non-expired items are returned. `expirationDate` comparison is done server-side.
4. **Behavior `remark` and `justification` fields** — the backend suppresses the upstream default value `"ללא הערות"` and returns `null` instead. Frontend should treat `null` as "no comment".
5. **`POST /api/v1/sync/refresh`** — returns `202 Accepted` immediately. Sync runs asynchronously. Frontend should poll `GET /api/v1/settings/source-health` to observe progress.
6. **All list endpoints** — default limit 20, max limit 100. Exception: `/children/subjects`, `/children/notices`, and `/children/timetable` return full lists (no pagination needed at current data scale).
7. **Read/handled state** — implemented directly on items (`isNew`, `isArchived` fields on `homework_item` and `behavior_item`; `isNew` on `mail_conversation`). There is no separate `read_state` table in Phase 1. State is household-global.
8. **Timetable** — synced weekly (Sunday 03:00). The `day` field uses Israeli school week: 1=Sunday, 2=Monday, …, 6=Friday. Frontend should handle the case where `data` is empty (sync not yet run or source returned no data).
