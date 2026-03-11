# School Parent Command Center - Requirements Input for PRD Generation (v3)

**Status:** Latest version. Supersedes v2 for all future product and PRD work.  
**Audience:** Product agent, product manager, designer, engineering lead.  
**Product type:** Household-scoped parent web application.  
**Preferred stack:** Node.js backend, React frontend, PostgreSQL database.  
**Source of truth for scope:** Only the uploaded API bundle. Do not invent unsupported capabilities.

---

## 1. Why this document exists

This document is the **requirements input** for a product/PRD agent that will write the formal PRD for a new parent-facing web app on top of the uploaded school APIs.

The parent already has legitimate access to their children's school data, but the current school UI is too heavy for day-to-day use. The problem is not lack of data. The problem is that the parent must repeatedly log in, navigate a complex legacy interface, switch context between children, and mentally assemble "what changed" from multiple screens.

This product should remove that burden.

The app should provide a **calm, modern, low-click parent command center** that answers, at a glance:

- What changed since I last checked?
- Which child needs my attention?
- Are there unread school messages?
- Was homework assigned recently?
- Were there behavior or attendance events?
- What should I open first?

This document is intentionally more concrete than a normal brief so the PRD agent does not have to guess what "simple and modern" means.

---

## 2. Version 3 revision goals

Version 3 should be treated as the authoritative input because it incorporates the broader API bundle and tightens the product intent.

Compared with earlier iterations, v3:

- integrates the additional endpoints into the supported feature map
- distinguishes clearly between **proven**, **partially proven**, and **exploratory** capabilities
- makes the **home dashboard and low-click UX** more explicit
- adds concrete requirements for **subjects, teachers, behavior classification, sync freshness, and feed deduping**
- reduces room for the PRD agent to expand into unsupported scope
- gives engineering enough structure to start system design without treating this as a full implementation spec

---

## 3. Product statement

Build a **modern parent command center** that sits on top of the existing school APIs and gives a busy parent one clear answer:

> what changed, who it affects, and what needs attention right now

This is **not** a rebuild of the school portal.  
It is a **summary and triage layer** for a parent household.

The value is created by:

- cross-child aggregation
- strong prioritization
- clean message reading
- recent homework visibility
- readable behavior/attendance history
- subject and teacher context
- minimal friction on mobile

---

## 4. Product promise

A parent should be able to open the app and understand the current household school status in **under 30 seconds**, without hunting through menus.

The most common session should look like this:

1. Open the app
2. See whether there is anything urgent
3. Open one message or one child if needed
4. Leave with confidence

The app should feel like a **daily briefing**, not an admin portal.

---

## 5. Core design principles and UX guardrails

These are product requirements, not optional design taste.

### 5.1 Principles

1. **Summary first**  
   The app must answer the household question before it asks the user to choose a child or a section.

2. **Attention first**  
   The first visible content should prioritize new unread messages, negative behavior events, and recent homework.

3. **Low click by default**  
   Common actions should take 0-2 taps. Common reading tasks should never require a deep navigation maze.

4. **Modern and calm**  
   The interface should feel premium, clean, quiet, and intentional. It must not feel like an enterprise admin dashboard.

5. **Mobile first**  
   The primary experience is phone-sized. Desktop is supported, but the product should be designed from the mobile experience upward.

6. **RTL ready**  
   Because the source content is clearly Hebrew-heavy, layouts must work naturally in RTL, including mixed Hebrew/English text.

7. **Cross-child before drill-down**  
   The parent usually wants a household briefing first, then child detail second.

8. **Use one strong mixed feed**  
   The product should prefer a good mixed "latest updates" stream over many shallow pages.

9. **Local peace of mind matters**  
   The app should support local handled/read state so a parent can stop re-processing the same item.

10. **Do not expose upstream complexity**  
    Tokens, GUIDs, source field names, platform quirks, and school-system jargon should stay in the backend/domain layer.

### 5.2 Anti-patterns to avoid

The PRD must explicitly avoid these patterns:

- a homepage that is mostly navigation chrome
- requiring tab switches before showing meaningful updates
- dense mobile tables as the primary information pattern
- carousel-heavy layouts that hide important status
- making the parent choose a child before seeing anything useful
- duplicating the same update in multiple modules with no dedupe
- showing unsupported features as disabled placeholders
- turning routine sync lag into alarming red-banner UX

---

## 6. Confirmed upstream capability map

The PRD must use the API bundle below as the source of truth for what the product can support.

### Capability confidence definitions

- **Proven** = endpoint exists and non-empty example/schema prove the usable data shape
- **Partially proven** = endpoint exists but some functional implications are still uncertain
- **Exploratory** = endpoint exists but observed sample is empty or insufficient; do not make it core scope without validation

### 6.1 Authentication and household bootstrap

| Endpoint | Confidence | What it proves | Product use |
|---|---|---|---|
| `POST /api/login` | Proven | Parent login works upstream and returns household/session context, children, school settings, username, last login, user school years | Required bootstrap for phase 1 and phase 2 school connection |
| `GET /api/user/details` | Proven | Parent contact details exist upstream in read-only form | Read-only profile/settings section |
| `accessToken.children[]` in login | Proven | Multi-child household support is explicit and includes child GUID, class code, class number, and group IDs | Core child cards and child workspaces |

### 6.2 Latest updates and alerts

| Endpoint | Confidence | What it proves | Product use |
|---|---|---|---|
| `GET /api/user/notifications?skip&take` | Proven | There is a timestamped updates feed containing homework, behavior, and unread-message summary events | Primary "what changed" source for Home |
| `GET /api/mail/counts?$select=unreadConversations` | Proven | There is an exact unread conversation count | Home summary badge and inbox badge |

### 6.3 Mail and communications

| Endpoint | Confidence | What it proves | Product use |
|---|---|---|---|
| `GET /api/mail/inbox/conversations?skip&take` | Proven | There is a paginated inbox list with metadata, sender, unread state, attachments flag, and subject | Read-only inbox list |
| `GET /api/mail/conversations/{conversationId}` | Proven | Full conversation details can be retrieved with HTML body and recipient groups | Conversation detail read view |
| `GET /api/mail/recipients` | Partially proven | There is a recipient/address-book style directory of teachers, users, and classes | Optional teacher/contact enrichment; future compose support if send endpoint is found |

### 6.4 Per-child learning and behavior context

| Endpoint | Confidence | What it proves | Product use |
|---|---|---|---|
| `GET /api/students/{studentGuid}/homework` | Proven | Homework history exists with subject, lesson metadata, remark, and optional file metadata | Child homework history and feed enrichment |
| `GET /api/students/{studentGuid}/behave` | Proven | Behavior and attendance history exists with event code, label, subject, reporter, lesson metadata, and optional remark | Child behavior timeline and attention logic |
| `GET /api/students/{studentGuid}/dailyBehave` | Exploratory | Daily behavior source exists but sample was empty; schema not proven | Future or feature-flagged enrichment only |
| `GET /api/students/{studentGuid}/outBehave` | Exploratory | Out-of-school incident source exists but sample was empty; schema not proven | Future or feature-flagged enrichment only |
| `GET /api/students/{studentId}/groups` | Proven | Each child has subject groups and active/inactive teachers | Subjects + teachers section in child workspace |
| `GET /api/students/{studentGuid}/lessonsCount` | Proven | Weekly hours and cumulative lessons count per group exist | Subject load/weekly hours enrichment |

### 6.5 Reference and metadata sources

| Endpoint | Confidence | What it proves | Product use |
|---|---|---|---|
| `GET /api/achvas` | Proven | Behavior event type dictionary exists with labels, display order, justifiable flag, and visibility metadata | Behavior classification and parent-friendly labeling |
| `schoolSettings` in login response | Partially proven | The school exposes capabilities and policy flags, even if not all action APIs are present | Store raw settings for future gating; do not over-surface in MVP |
| `userSchoolYears` in login response | Partially proven | Historical year support may exist upstream | Future multi-year support, not MVP |

---

## 7. Concrete opportunities unlocked by the expanded API set

The extra APIs should change the product in meaningful ways.

### 7.1 Stronger child context

Because `groups` and `lessonsCount` are now known, the app should not stop at homework + behavior.  
Each child workspace should also include a compact **Subjects and Teachers** section showing:

- subject name
- group name if useful
- teacher name(s)
- weekly hours
- total lessons held so far

This section should be informative but lightweight.

### 7.2 Better behavior interpretation

Because `achvas` exists, behavior should not be treated as a raw event log only.  
The product should use `eventCode`, `achvaName`, and the `achvas` reference dictionary to:

- classify events into attention / positive / neutral buckets
- expose whether an event type is potentially justifiable
- keep original Hebrew labels in detail while using parent-friendly labels in summary
- support future tuning without changing UI components

### 7.3 Better inbox experience

Because mail count, inbox list, and conversation detail all exist, the product should provide a genuinely better message-reading workflow than the school portal:

- exact unread count
- cleaner conversation list
- safe HTML rendering
- recipient summary
- attachment indicator
- reply-disabled hint when relevant

### 7.4 Optional read-only contacts enrichment

Because `mail/recipients` exists, the product may support a **read-only contacts/teachers directory** later, or use it to enrich teacher metadata.  
However, because no send endpoint exists, this must not become a compose feature in MVP.

### 7.5 Exploratory extended behavior sources

Because `dailyBehave` and `outBehave` exist, the backend should be designed so these sources can be ingested later without redesign.  
But because the bundle only shows empty arrays, these sources must not be required for MVP.

---

## 8. Hard product constraints

The PRD must preserve these constraints exactly.

1. **No app-side authentication in phase 1.**  
   Phase 1 uses server-configured upstream school credentials.

2. **No grades support is proven.**  
   Do not include grades, averages, report cards, grade trends, or performance analytics in MVP.

3. **No timetable/calendar support is proven.**  
   `groups` and `lessonsCount` are not a daily schedule. Do not promise today's timetable.

4. **Homework has no proven due date field.**  
   The UI may show "latest homework" or "recent homework" but must not promise overdue or due-soon logic.

5. **No message send endpoint was provided.**  
   No composition, reply, forwarding, or outbound message workflows in MVP.

6. **No attachment retrieval endpoint was provided.**  
   Homework and mail may indicate attachments, but phase 1 must not promise opening or downloading files.

7. **No justification-submit endpoint was provided.**  
   Even if behavior types are marked justifiable, phase 1 may show that status but must not offer justification actions.

8. **The upstream login requires `X-Csrf-Token`, but token acquisition is not documented.**  
   This is a real technical discovery item and must stay explicit in the PRD.

9. **Identifier naming is inconsistent.**  
   Some endpoints use `studentId`, some use `studentGuid`, and samples sometimes use folder values inconsistently. The adapter layer must normalize this.

10. **Some notifications do not include a stable numeric `id`.**  
    For example, unread-message summary notifications may lack `id`; the backend must support composite dedupe keys.

11. **Mail is not guaranteed to map cleanly to a specific child.**  
    The inbox should default to household/school context unless a child mapping can be derived safely.

12. **Some timestamps are timezone-aware and some appear naive/local.**  
    The adapter must normalize them consistently, using the school/user timezone when needed.

13. **Daily behavior and out-of-school incident schemas are not proven.**  
    These endpoints must remain behind validation or feature flags.

14. **Hebrew content is part of the product reality.**  
    The UI must support Hebrew, RTL, and mixed-language rendering from day one.

---

## 9. Product goals

### 9.1 Primary goals

- Give the parent a reliable household summary in under 30 seconds
- Reduce the number of clicks needed to discover important updates
- Surface latest changes first across all children
- Make unread school communication obvious and easy to read
- Make recent homework and behavior easier to scan than in the source system
- Keep the visual design modern, minimal, and calm

### 9.2 Secondary goals

- Give each child a compact academic/behavior context page
- Preserve local handled/read state to reduce repeated scanning
- Provide subject and teacher context without turning into a full portal
- Lay the groundwork for secure multi-user authentication in phase 2

### 9.3 Proposed product success metrics

These are recommended PRD metrics, not analytics implementation requirements yet.

- **Time to confidence:** a parent can answer "anything important?" in under 30 seconds
- **Low-click rate:** common tasks are completed in 0-2 taps from Home
- **Home usefulness:** the first screen is meaningful without switching child or category
- **Refresh trust:** last sync and stale states are visible and understandable
- **Legacy replacement value:** the app materially reduces the need to visit the legacy portal for routine status checks

---

## 10. Primary persona and jobs to be done

### Primary persona

A busy parent with one or more school-aged children who:

- checks updates quickly, usually on mobile
- wants confidence, not admin control
- cares most about recent changes and anything requiring attention
- does not want to log in to the school portal just to understand current status

### Jobs to be done

1. **When I have a minute, tell me whether anything important changed.**
2. **When something needs attention, tell me which child and why.**
3. **When I open a detail item, show me the answer immediately.**
4. **When I have multiple children, help me compare them quickly.**
5. **When I come back later, help me ignore what I already processed.**
6. **When school sends messages, make them easier to read than the original portal.**

---

## 11. Phase model and scope

## 11.1 Phase 1 definition

Phase 1 is a **private household deployment** with **no app authentication**.  
The backend holds the upstream school credentials and syncs data into PostgreSQL.

### Phase 1 must include

1. Upstream login/session handling
2. Child discovery from login response
3. Home dashboard
4. Needs-attention section
5. Mixed latest-updates feed
6. Child quick cards
7. Child workspace for each child
8. Recent homework history per child
9. Recent behavior/attendance history per child
10. Subject and teacher summary per child using `groups` + `lessonsCount`
11. Read-only inbox list
12. Conversation detail view with safe HTML rendering
13. Local read/handled state
14. Manual refresh and data freshness indicators
15. PostgreSQL persistence and normalized internal API
16. Responsive, modern, RTL-ready UI

### Phase 1 should include

1. Parent contact info read-only in Settings from `user/details`
2. Behavior classification powered by `achvas`
3. Per-source sync health in a lightweight settings/debug view
4. Read-only teacher/contact enrichment if `mail/recipients` can be used without clutter
5. Feature-flagged ingestion path for `dailyBehave` and `outBehave`
6. Good empty, stale, degraded, and partial-failure states

### Phase 1 could include if low effort

1. A read-only "All updates" page that expands the Home mixed feed
2. A simple subject filter inside a child workspace
3. A compact school profile card showing school name and current year
4. A read-only contacts directory in More, if it remains clearly useful

### Phase 1 must not include

1. App sign-up or app login
2. Grades
3. Timetable/calendar
4. Outbound messaging
5. Attachment opening/downloading
6. Justification submission
7. Push notifications
8. Role management
9. Multi-household public SaaS positioning
10. Anything that turns the product into a full school operating system

## 11.2 Phase 2 definition

Phase 2 adds proper app authentication, secure user scoping, and account onboarding.

### Phase 2 must include

1. Parent authentication for the app
2. Secure storage of upstream school credentials or tokens per user
3. Per-user data access and local state isolation
4. Connect-school-account onboarding flow
5. Session management and revocation
6. Multi-household safe deployment model

---

## 12. Information architecture

### 12.1 Recommended top-level navigation

Keep navigation small.

**Mobile-first nav:**

- Home
- Children
- Inbox
- More

**Desktop adaptation:**

- Same information architecture
- Side rail or top nav is acceptable
- Do not invent separate desktop-only modules

### 12.2 Why this IA is right

- **Home** answers the parent's main question
- **Children** gives fast child-specific drill-down
- **Inbox** supports the second most important workflow
- **More** contains low-frequency and diagnostic items

### 12.3 What should not be top-level nav in phase 1

Do not make these primary nav items:

- Homework
- Behavior
- Subjects
- Contacts
- Settings sub-pages
- Technical status pages

These should be accessible from Home, Children, or More.

---

## 13. Required user flows

These are product requirements, not suggestions.

### 13.1 Daily household check-in

1. Parent opens app
2. Home shows last sync, summary cards, needs attention, and latest updates
3. Parent can decide immediately whether action is needed
4. Parent optionally opens one item or one child
5. Parent leaves the app with confidence

### 13.2 Open a child and understand status

1. Parent taps a child card from Home or Children
2. Child workspace opens
3. Parent sees overview chips, latest timeline, homework, behavior, and subjects
4. Parent can mark items handled locally
5. Parent can return without losing context

### 13.3 Read a school conversation

1. Parent taps inbox card or inbox nav item
2. Parent sees unread count and conversation list
3. Parent opens a conversation in one tap
4. App renders safe HTML body, sender, recipients, time, and attachment indication
5. Parent can mark locally handled/read

### 13.4 Manual refresh

1. Parent taps refresh from Home or app shell
2. Cached data remains visible
3. UI shows syncing state subtly
4. Freshness indicators update when sync finishes
5. If one source fails, the rest of the dashboard remains usable

### 13.5 Return visit with local handled state

1. Parent reopens app later
2. Handled items feel visually quieter
3. New items still stand out clearly
4. The app helps the parent focus on what is new since last meaningful check

---

## 14. Detailed screen requirements

## 14.1 App shell

### Purpose

Provide a lightweight, reliable frame around the product.

### Requirements

- Mobile-first layout
- Small persistent navigation
- Household title or product title in the app bar
- Last successful sync timestamp visible somewhere persistent or easy to find
- Manual refresh action available globally
- Status state reflected as one of:
  - fresh
  - syncing
  - stale
  - degraded

### UI rules

- Keep chrome quiet
- Do not waste vertical space
- Do not place large hero graphics above the information the parent came for
- Use one accent color plus restrained status colors

---

## 14.2 Home screen

### Purpose

This is the hero screen. It must answer "what matters right now?" in one view.

### Required sections

#### A. Header strip

Must include:

- household/product title
- current date
- last successful sync time
- refresh action
- subtle freshness status

#### B. Household summary strip

Must show compact summary cards or chips for:

- unread conversations
- recent homework count
- recent behavior/attendance count
- number of children in the household

Recommended default windows for "recent":

- homework: last 7 days
- behavior/attendance: last 7 days

The unread conversations count should come from `mail/counts` as the source of truth.

#### C. Needs attention

This is the most important section after the summary strip.

Priority order should be:

1. unread school messages
2. recent negative behavior/attendance events
3. recent homework not locally handled
4. sync degradation or stale data only when it affects trust

Rules:

- show at most 3-5 cards before "See all"
- each card must include title, child name when relevant, and timestamp
- each card must have one obvious tap target
- each card must be readable without opening detail
- positive updates should not crowd out urgent items

#### D. Latest updates feed

Reverse chronological mixed feed across:

- homework notifications
- behavior notifications
- behavior/history enrichment
- unread/new conversation activity
- positive events
- optional sync/degradation events if useful

Each item should include:

- type badge
- short title
- one-line summary
- child name if applicable
- source time
- visual state: new / handled / neutral
- optional quick action such as open or mark handled

#### E. Child quick cards

One card per child with:

- child name
- class code + class number
- latest update time
- recent update count
- concise one-line status
- one tap to open the child workspace

### Home screen hard UX rules

- The first viewport on a common phone must already be useful
- The parent must not need to switch tabs to see the latest status
- The home screen must remain valuable even if the user never opens another page
- Do not use horizontal content carousels for critical information
- Keep filters to one compact row at most

### Mobile above-the-fold requirement

On a common phone-sized viewport, the parent should see:

- app header
- summary strip
- the first needs-attention items

without any navigation gymnastics.

---

## 14.3 Children screen

### Purpose

Give the parent a clean directory for switching context when they want child-specific detail.

### Requirements

For each child card show:

- name
- class code and class number
- latest update time
- recent homework count
- recent behavior count
- optional subject count
- one tap to open the child workspace

### UX rules

- This screen should feel light
- It should not duplicate the entire Home experience
- Cards should be easy to compare quickly
- Most urgency should still live on Home, not here

---

## 14.4 Child workspace

### Purpose

Provide one child's current snapshot in a way that still feels light and readable.

### Required structure

#### A. Child header

Must include:

- child name
- class code/class number
- last sync time for this child context
- compact activity summary

#### B. Overview chips

Must show:

- recent homework count
- recent behavior count
- subject count
- total weekly hours if derivable from `lessonsCount`

#### C. Child latest timeline

A mixed child-scoped timeline containing:

- homework notifications
- behavior items
- positive reinforcement
- latest mailbox references only if a child link is safely known

#### D. Recent homework section

For each item show:

- lesson date
- subject
- homework text
- remark/topic if present
- attachment names if present
- local handled toggle

Critical wording rule:

Use labels like **Recent homework** or **Latest homework**.  
Do not use due-date language.

#### E. Behavior and attendance section

For each item show:

- event label
- attention / positive / neutral bucket
- lesson date
- lesson number if available
- subject
- teacher/reporter
- justification text if meaningful
- optional teacher remark

UI grouping should support:

- All
- Attention
- Positive
- Other

#### F. Subjects and teachers section

Derived from `groups` joined with `lessonsCount`.

For each subject row/card show:

- subject name
- group name if useful
- teacher name(s)
- weekly hours
- lessons count so far

This section should not become a timetable or planning module.

### Child workspace interaction model

Acceptable patterns:

- anchored scroll sections
- compact segmented control
- sticky filter chips

Avoid:

- deep nested tabs
- sub-pages that hide the overview
- expanding tree UIs

---

## 14.5 Inbox screen

### Purpose

Give the parent a much cleaner read-only message experience than the legacy school UI.

### Required features

- unread conversations count prominently visible
- conversation list sorted by latest message time
- sender name
- subject
- time shown as both relative and exact
- clear unread styling
- attachment indicator
- reply-disabled indicator only if it adds clarity
- lazy pagination or load-more behavior

### Good defaults

- default filter: all conversations
- optional secondary filter: unread only
- group by time buckets if helpful: today / this week / earlier

### Important scope rule

Mailbox items should default to **Household / School messages** unless a child link can be derived safely.  
Do not fake child mapping.

---

## 14.6 Conversation detail

### Purpose

Let the parent read a message quickly and safely.

### Requirements

- open in one tap from Home or Inbox
- safe sanitized HTML rendering
- sender shown clearly
- sent time shown clearly
- recipients summarized cleanly
- preserve basic formatting where possible
- show attachment presence if present
- show reply-disabled state if relevant
- local handled/read state allowed

### Performance rule

Do not fetch every full conversation body during initial dashboard load.  
Conversation detail should be lazy-loaded when opened, or selectively prefetched for only a small unread subset if needed.

---

## 14.7 More / Settings

### Phase 1 minimum

- last successful sync by source or global summary
- freshness/degraded status
- school name and current year if useful
- parent contact info from `user/details` in read-only form
- version/build info
- clear local handled/read state action
- optional diagnostics area for internal/private use

### Phase 1 rules

- keep this area compact
- do not expose raw secrets or identifiers
- do not surface low-level upstream configuration flags unless they are meaningful to the parent

---

## 14.8 Phase 2 onboarding/auth screens

These do not exist in phase 1, but the PRD should define them for phase 2.

### Screens

1. App sign-in
2. Email magic-link or equivalent passwordless confirmation
3. Connect school account
4. Initial sync progress
5. Dashboard landing
6. Manage connection / update credentials

---

## 15. UX behavior rules that reduce burden

The PRD must carry these rules forward.

1. **Show the important thing first.**
2. **Do not hide latest updates behind tabs.**
3. **Use one strong mixed feed instead of many weak modules.**
4. **Use plain-language parent labels wherever possible.**
5. **Keep original Hebrew labels available in detail.**
6. **Use local handled state to reduce anxiety and re-scanning.**
7. **Make stale data visible but calm.**
8. **Do not clear cached content while refresh is running.**
9. **Use badges/chips/cards, not dense mobile grids.**
10. **Preserve context when moving from Home to child or message detail.**
11. **Do not require more than 2-3 steps for routine reading flows.**

---

## 16. Feed, prioritization, and deduping logic

This section is important. The product experience depends on getting it right.

## 16.1 Source roles

### Primary freshness sources

Use these to decide what changed recently:

1. `user/notifications`
2. `mail/counts`
3. `mail/inbox/conversations`

### Secondary detail/history sources

Use these to enrich and deepen detail:

1. `students/{studentGuid}/homework`
2. `students/{studentGuid}/behave`
3. `mail/conversations/{conversationId}`

### Reference/enrichment sources

Use these to improve context and classification:

1. `students/{studentId}/groups`
2. `students/{studentGuid}/lessonsCount`
3. `achvas`
4. `user/details`
5. `mail/recipients`
6. optional exploratory `dailyBehave`
7. optional exploratory `outBehave`

## 16.2 Why notifications should drive Home

`user/notifications` already captures recent homework and behavior events with timestamps and child association.  
That makes it the best source for the Home "latest updates" experience.

Per-child endpoints should deepen the history and provide richer detail, not replace the freshness model.

## 16.3 Canonical normalized update model

All sources should normalize into a canonical internal model.

Recommended fields:

- `id`
- `sourceType` (`notification`, `mail_count`, `mail_conversation`, `homework`, `behavior`, `sync_issue`)
- `sourceId`
- `studentGuid` nullable
- `studentName` nullable
- `title`
- `summary`
- `bodyHtml` nullable
- `category`
- `subcategory`
- `priority`
- `isPositive`
- `isUnread`
- `isHandledLocally`
- `eventAt`
- `syncedAt`
- `rawPayload`

## 16.4 Deduping rules

### Homework dedupe

If a notification of type `102` and a homework item refer to the same lesson/homework event, they should appear as one logical update item.

Preferred key order:

1. `studentGuid + lessonId`
2. fallback: `studentGuid + groupId + lessonDate + lesson + homework hash`

### Behavior dedupe

If a notification of type `101` and a behavior item describe the same incident, they should be merged into one logical event.

Preferred key order:

1. `studentGuid + lessonId + eventCode`
2. fallback: `studentGuid + lessonDate + lesson + subject + eventCode`

### Mail summary dedupe

Notification type `16` is an unread-summary style event.  
Treat it as supporting metadata, not a repeating feed item on every sync.  
The real unread count source of truth should be `mail/counts`.

### Conversation dedupe

Conversation list entries should dedupe by `conversationId`.  
Messages inside a conversation should dedupe by `messageId`.

## 16.5 Suggested priority buckets

- **critical**  
  Source outage affecting trust, or major unread message state if product chooses to highlight strongly
- **high**  
  Unread school conversations, recent negative behavior, major attendance issues
- **medium**  
  Recent homework not locally handled
- **low**  
  Positive reinforcement, neutral or informational history items

## 16.6 Suggested urgency heuristics

Recommended initial rules:

- unread conversations > 0 -> show inbox attention card
- negative behavior in last 7 days -> high priority
- homework assigned in last 7 days and not handled -> medium priority
- positive reinforcement -> low priority but visibly present
- sync degradation -> only elevate when it undermines trust in freshness

These should be configurable in code, not hardcoded in UI components.

---

## 17. Behavior classification requirements

Because the API bundle includes both `behave` and `achvas`, the product should not treat behavior as a flat stream.

## 17.1 Initial classification buckets

Use:

- Attention
- Positive
- Neutral/Other

## 17.2 Recommended initial observed code mapping

This mapping should be configurable and should preserve the original Hebrew label.

| Event code | Observed label | Default bucket | Default priority |
|---|---|---|---|
| `1` | tardy / איחור | Attention | Medium |
| `2` | absence / חיסור | Attention | High |
| `4` | positive reinforcement / חיזוק חיובי | Positive | Low |
| `5` | missing homework / אי הכנת ש.ב. | Attention | High |
| `6` | missing equipment / אי הבאת ציוד | Attention | Medium |
| `10` | did not complete class task | Attention | Medium |
| `11` | school activity absence | Neutral | Low |
| unknown | original label only | Neutral until configured | Low |

## 17.3 Additional behavior display rules

- If `achvas.justifiable = true`, show a subtle "justifiable" badge if helpful
- If justification text is the default placeholder meaning "no comments", do not over-emphasize it
- Unknown event codes must still render safely with the original label
- The child workspace and Home feed must use the same classification logic

---

## 18. Subject and teacher model requirements

The product should use `groups` + `lessonsCount` to create a light, useful subject model.

## 18.1 Join strategy

- `groups.groupId` should be joined to `lessonsCount.groupId`
- `child.groups[]` from login can be used as bootstrap context, but `groups` should be treated as the source of truth for subject list display

## 18.2 What to show in the UI

For each subject/group row:

- subject name
- teacher name(s)
- optional group name
- weekly hours
- lessons held so far

## 18.3 What not to imply

Do not imply:

- next lesson time
- current schedule
- grading/progress
- attendance percentage
- curriculum completion

This is context, not a planner.

---

## 19. Read state model

The product needs a local state model because upstream APIs do not provide all the personalization needed for a calm parent experience.

## 19.1 Separate upstream unread from local handled

- **Mail unread** should respect upstream `isNew` / unread counts
- **Feed handled** is local to this app
- **Homework handled** is local to this app
- **Behavior handled** is local to this app

## 19.2 Phase 1 scope

Read/handled state may be household-global in phase 1 because there is no app auth.

## 19.3 Phase 2 scope

Read/handled state must become user-scoped.

---

## 20. Backend requirements

## 20.1 Technical stack

Use:

- **Backend:** Node.js
- **Frontend:** React
- **Database:** PostgreSQL

Recommended implementation shape:

- Frontend: Next.js + React + TypeScript + Tailwind CSS
- Backend: NestJS or Fastify-based TypeScript service
- ORM: Prisma
- Background jobs: cron or queue worker
- Data fetching/cache: TanStack Query on the frontend

## 20.2 Backend responsibilities

The backend must:

- acquire and maintain upstream session context
- solve or encapsulate CSRF/bootstrap logic
- call upstream APIs
- normalize and persist data
- expose a stable internal API for the frontend
- protect upstream credentials and tokens
- compute feed items, priorities, and local state joins
- serve cached data fast even if upstream sync is in progress

## 20.3 Required backend modules

Recommended logical modules:

- `upstream-session`
- `upstream-api`
- `sync`
- `household`
- `students`
- `notifications`
- `mail`
- `behavior`
- `homework`
- `subjects`
- `feed`
- `read-state`
- `settings`
- `auth` (phase 2)

## 20.4 Upstream session requirements

The backend must:

- obtain the `X-Csrf-Token`
- maintain cookies/session state if required
- authenticate using configured school credentials
- re-login on expiry
- redact secrets from logs
- never expose upstream tokens/cookies to the browser

### Explicit open discovery item

The API bundle documents the login requirement for `X-Csrf-Token`, but not how the token is acquired.  
The PRD must keep this as a first-class integration discovery task.

## 20.5 Sync flow requirements

Recommended sync order:

1. bootstrap session/login
2. fetch household login payload and children
3. fetch notifications
4. fetch unread mail count
5. fetch inbox conversations
6. fetch per-child homework
7. fetch per-child behavior
8. fetch per-child groups
9. fetch per-child lessons count
10. fetch achvas reference data
11. fetch user details
12. optionally fetch recipients
13. optionally probe exploratory behavior sources

## 20.6 Sync cadence recommendations

These are product-level defaults and can be tuned.

### Primary sources

- notifications: every 5 minutes
- unread mail count: every 5 minutes
- inbox list: every 5-10 minutes

### Secondary child history

- homework: every 10-15 minutes
- behavior: every 10-15 minutes

### Reference data

- groups: daily or on first sync, plus refresh when child context changes if needed
- lessonsCount: daily
- achvas: daily or weekly
- user details: daily
- recipients: daily or manual refresh only
- exploratory behavior sources: low-frequency, feature-flagged

## 20.7 Freshness and stale thresholds

Recommended thresholds:

- primary sources stale after 15 minutes
- child history stale after 24 hours
- reference data stale after 7 days

If stale:

- Home should still render cached data
- UI should show calm freshness messaging
- manual refresh should remain available

## 20.8 Internal API for the frontend

Recommended internal endpoints:

- `GET /api/dashboard`
- `GET /api/feed`
- `GET /api/children`
- `GET /api/children/:studentGuid`
- `GET /api/children/:studentGuid/homework`
- `GET /api/children/:studentGuid/behavior`
- `GET /api/children/:studentGuid/subjects`
- `GET /api/mail/summary`
- `GET /api/mail/conversations`
- `GET /api/mail/conversations/:conversationId`
- `GET /api/settings/source-health`
- `POST /api/read-state`
- `POST /api/sync/refresh`

The frontend must never call the upstream school APIs directly.

## 20.9 Adapter requirements

The adapter layer must:

- normalize inconsistent field names
- parse `eventData` JSON strings inside notifications
- sanitize HTML message bodies
- normalize timestamps to a single timezone-aware representation
- preserve raw upstream payloads
- not rely on sample-specific magic constants such as one specific folder numeric value

### Timezone rule

Where upstream timestamps are naive/local, treat them consistently using the household/school timezone.

---

## 21. Database requirements

The database must store both normalized models and raw payloads.

## 21.1 Core tables/entities

### `household_connection`
Phase 1: single household configuration.

Fields:

- `id`
- `schoolCode`
- `schoolYear`
- `username`
- `encryptedPassword`
- `schoolName`
- `upstreamUserId`
- `lastLoginAt`
- `active`
- `createdAt`
- `updatedAt`

### `parent_profile`

- `id`
- `upstreamUserId`
- `displayName`
- `email`
- `cellphone`
- `detailsState`
- `rawPayload`
- `updatedAt`

### `student`

- `id`
- `studentGuid`
- `privateName`
- `familyName`
- `fullName`
- `classCode`
- `classNum`
- `gender`
- `groupsRaw`
- `rawPayload`
- `updatedAt`

### `notification_event`

- `id`
- `upstreamNotificationId` nullable
- `fingerprint` for notifications without stable IDs
- `eventType`
- `eventText`
- `eventKey`
- `eventKey2`
- `studentGuid` nullable
- `eventAt`
- `addTime`
- `readTime`
- `parsedEventData` jsonb
- `rawPayload`
- `updatedAt`

### `mail_conversation`

- `id`
- `conversationId`
- `subject`
- `senderNamePreview`
- `sendTime`
- `isUnread`
- `hasAttachments`
- `preventReply`
- `labels` jsonb
- `rawPayload`
- `lastFetchedAt`

### `mail_message`

- `id`
- `messageId`
- `conversationId`
- `senderId`
- `senderName`
- `subject`
- `bodyHtmlSanitized`
- `bodyTextPreview`
- `sendTime`
- `isUnread`
- `recipients` jsonb
- `rawPayload`

### `homework_item`

- `id`
- `studentGuid`
- `lessonId`
- `groupId`
- `lessonDate`
- `lesson`
- `subjectName`
- `homeworkText`
- `remark`
- `files` jsonb
- `rawPayload`
- `updatedAt`

### `behavior_item`

- `id`
- `studentGuid`
- `lessonId`
- `groupId`
- `eventCode`
- `achvaCode`
- `achvaName`
- `classification`
- `justifiable`
- `lessonDate`
- `lesson`
- `subject`
- `reporter`
- `remark`
- `justification`
- `eventAt`
- `rawPayload`
- `updatedAt`

### `subject_enrollment`

- `id`
- `studentGuid`
- `groupId`
- `groupName`
- `subjectName`
- `teachers` jsonb
- `inactiveTeachers` jsonb
- `weeklyHours`
- `lessonsCount`
- `rawPayload`
- `updatedAt`

### `behavior_type_reference`

- `id`
- `code`
- `name`
- `displayOrder`
- `justifiable`
- `hidden`
- `showInBehave`
- `hideFromStudents`
- `rawPayload`
- `updatedAt`

### `recipient_directory` (optional phase 1, recommended if ingested)

- `id`
- `value`
- `valueType`
- `targetType`
- `displayName`
- `comment`
- `rawPayload`
- `updatedAt`

### `read_state`

- `id`
- `itemType`
- `itemId`
- `scopeType`
- `scopeId`
- `isRead`
- `isHandled`
- `isPinned`
- `updatedAt`

### `sync_run`

- `id`
- `source`
- `status`
- `startedAt`
- `endedAt`
- `fetchedCount`
- `createdCount`
- `updatedCount`
- `errorMessage`

## 21.2 Persistence rules

- use unique constraints to prevent duplicates
- keep raw upstream payloads for debugging and remapping
- store normalized data for fast reads
- keep local handled/read state separate from source data
- prefer upsert/append semantics over destructive replacement
- treat exploratory sources as optional tables or optional ingestion paths

---

## 22. Frontend requirements

## 22.1 Frontend stack

Recommended:

- React
- Next.js
- TypeScript
- Tailwind CSS
- TanStack Query

## 22.2 Design system requirements

The interface should use:

- consistent 8px spacing rhythm
- card-based surfaces
- rounded corners
- quiet borders or soft elevation
- strong typography hierarchy
- chip/badge system
- reusable empty/loading/error components
- compact list items for mobile scan speed

## 22.3 Visual tone

The product should feel:

- minimalistic
- modern
- calm
- reliable
- parent-friendly
- not childish
- not institutional

## 22.4 Accessibility and usability

Must include:

- strong contrast
- focus states
- keyboard usability on desktop
- screen-reader labels for primary actions
- status not conveyed by color alone
- touch targets sized for mobile

## 22.5 Localization and RTL

Must support:

- RTL layouts
- Hebrew rendering
- mixed Hebrew/English strings
- natural date/time formatting
- safe rendering of long Hebrew message bodies

---

## 23. Phase 1 security requirements

Phase 1 has no app authentication, but it still must be handled responsibly.

### Required safeguards

- upstream credentials stored only server-side
- credentials encrypted at rest where stored
- no credentials or tokens in frontend bundles
- no tokens/session IDs in logs
- HTTPS in deployed environments
- optional host-layer protection such as basic auth or IP allowlist
- deployment limited to private/internal/household use

### Explicit phase 1 caveat

Phase 1 is acceptable for:

- local use
- private household deployment
- prototype validation

Phase 1 is **not** acceptable as an open public deployment.

---

## 24. Phase 2 authentication and account model

## 24.1 Recommended auth approach

Prefer a low-friction modern auth flow such as:

- email magic link, or
- passkey/passwordless equivalent

with secure httpOnly session cookies.

This is better aligned with the target user than a heavy password-first auth flow.

## 24.2 Phase 2 user model

- one local account = one parent household
- one local account connects to one upstream school connection initially
- school credentials/tokens stored securely per user
- local handled/read state scoped per user
- dashboards and sync data isolated per user

## 24.3 Phase 2 onboarding flow

1. Parent enters email
2. Parent completes magic-link or equivalent sign-in
3. Parent lands on connect-school-account screen
4. Parent enters:
   - school code / semel
   - school year
   - username
   - password
5. Backend validates upstream login
6. Backend stores encrypted connection data
7. Initial sync runs
8. Parent lands on Home

## 24.4 Returning user flow

1. Parent signs in
2. Dashboard loads from cached DB data
3. Background refresh runs
4. Parent sees latest state without waiting on cold upstream calls

## 24.5 School connection update flow

1. Parent opens connection settings
2. Parent updates school credentials
3. Backend re-validates upstream login
4. Existing household data rebinds safely
5. Old credentials are invalidated or replaced securely

---

## 25. Non-functional requirements

### Performance

- warm dashboard load under 2 seconds from cached data
- refresh should not blank or block existing content
- inbox list should remain fast with lazy detail loading
- child workspace should load quickly from normalized DB data

### Reliability

- one source failing should not break the whole app
- last known good data should remain available
- partial failures should be visible but calm
- retry logic should exist for transient upstream issues

### Maintainability

- keep typed internal models
- isolate upstream adapters from UI components
- keep behavior classification configurable
- do not leak raw upstream naming into the component layer

### Observability

- structured logs
- sync history per source
- basic health metrics
- visible last sync timestamps
- error monitoring hooks

### Privacy

- no secrets in client storage
- no raw upstream secrets in analytics
- minimal logging of sensitive personal data

---

## 26. Acceptance criteria

## 26.1 Phase 1 acceptance criteria

Phase 1 is complete when all are true:

1. Backend can authenticate against the upstream school system using configured credentials.
2. Backend can solve or encapsulate the CSRF/bootstrap requirement.
3. Children are fetched from login and persisted.
4. Notifications, unread mail count, inbox conversations, homework, behavior, groups, and lessons count are synced and stored.
5. `achvas` is ingested and used for behavior classification or at minimum for label/reference enrichment.
6. Home shows:
   - unread conversation summary
   - recent homework
   - recent behavior/attendance
   - needs-attention cards
   - child quick cards
   - last successful sync time
7. Parent can open a child workspace in one tap.
8. Parent can read recent homework and behavior history per child.
9. Parent can see subject and teacher context per child.
10. Parent can open a clean inbox and read conversations safely.
11. Message HTML is sanitized before rendering.
12. Parent can mark items handled/read locally.
13. Cached data remains visible during refresh and temporary upstream failures.
14. The UI is clearly simpler and more modern than the upstream portal.
15. No unsupported capabilities are falsely implied.

## 26.2 Phase 2 acceptance criteria

Phase 2 is complete when:

1. A parent can sign in to the app securely.
2. A parent can connect their school account securely.
3. Data is scoped to the authenticated account.
4. Local read/handled state is user-specific.
5. Sessions are secure and revocable.
6. Multiple households can safely coexist in the same deployment.
7. App auth and upstream school connection are separated cleanly.

---

## 27. Risks and open questions

These items must remain explicit in the PRD.

### High-priority technical unknowns

1. How is `X-Csrf-Token` acquired before login?
2. Does the upstream flow require additional cookies or bootstrap calls?
3. Are there upstream rate limits or anti-automation protections?
4. Do homework and behavior endpoints return full history every time, or are there hidden filters/pagination behaviors?
5. Is there an undocumented attachment retrieval endpoint?
6. Can mailbox items ever be mapped safely to a child using recipients or subject metadata?
7. What is the real schema for `dailyBehave` and `outBehave` when they are non-empty?
8. Are there more upstream endpoints for grades, schedule, or announcements that were not part of this bundle?
9. Are naive timestamps always in the same timezone?
10. Are mailbox folder numeric values stable, or should the adapter treat them as non-authoritative?

### Product caution

Do not let the PRD drift into a full portal replacement.  
The best first product is a **focused household status app**.

---

## 28. PRD generation instructions for the product agent

When creating the PRD from this document, the product agent must:

1. Treat **Home** as the hero surface.
2. Keep the entire product centered on **latest updates with minimal effort**.
3. Preserve the **phase 1 / phase 2 split** exactly.
4. Keep phase 1 scoped to:
   - notifications-driven latest updates
   - mailbox reading
   - homework history
   - behavior history
   - subject/teacher context
   - child summaries
5. Explicitly exclude unsupported capabilities.
6. Translate "modern and intuitive" into concrete UX rules, not adjectives only.
7. Preserve the low-click requirement.
8. Preserve the calm, mobile-first, RTL-ready requirement.
9. Keep the CSRF/bootstrap issue visible as a discovery track.
10. Avoid writing requirements that depend on nonexistent send, schedule, grades, or attachment APIs.

---

## 29. Final product statement

Build a **modern parent command center** that turns the uploaded school APIs into a clean household briefing experience.

The parent should be able to open the app and immediately understand:

- what changed
- which child it affects
- what is new
- what needs attention
- where to tap next if detail is needed

Do that with a calm interface, strong prioritization, minimal clicks, and strict respect for what the available APIs actually support.
