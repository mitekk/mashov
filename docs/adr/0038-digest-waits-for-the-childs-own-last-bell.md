# ADR-0038: The Digest Waits for the Child's Own Last Bell

- **Date**: 2026-11-23
- **Status**: Accepted
- **Deciders**: User, Backend agent
- **Related**: [ADR-0026](0026-outbound-digest-delivery-and-llm-egress.md) — the digest and its fixed hourly window; [ADR-0037](0037-bell-schedule-source-and-derived-breaks.md) — bell schedule source and derived breaks; [ADR-0027](0027-derived-homework-deadlines.md) — timetable-derived deadline estimates

## Context and Problem Statement

The digest fired on a fixed clock: `@Cron('0 13-19 * * *')`, Asia/Jerusalem. Every
opted-in child was checked at each of those seven ticks, and anything unreported was
sent immediately.

That window was chosen before the project had any notion of when a school day ends. The
result is the noise the user reported: a child still in class at 13:00 produces a
message, then another at 14:00, then another at 15:00 — each one a partial picture,
because the teachers who will record the rest of the day's behaviour and homework have
not had the chance to enter it yet. A parent reads three fragments instead of one
briefing.

ADR-0026 named this as the feature's known weak point: *"Seven runs a day per child,
each capable of sending. Nothing caps messages per day, and a parent who finds the bot
noisy will mute it, which costs more than a missed digest. A minimum item age and a
daily cap are the obvious next refinement."*

The data needed to do better landed in ADR-0037. `bell_schedule` holds a school's
periods (`lesson` → `startTime`/`endTime` as zone-less `"HH:MM"` strings), with a
bundled, labelled default when the school serves none; `timetable_entry` has been
per-student-per-weekday since March. Joining them on `lesson` answers the question the
fixed window could only guess at: *when is this particular child let out today?*

## Decision Drivers

- A digest that arrives mid-lesson is worse than one that arrives an hour later. Its
  value is completeness, and completeness is what the early ticks cannot have.
- Whatever we build must not be able to *lose* an item. A scheduling change that
  suppresses news is far worse than the noise it fixes.
- Missing data is the normal case, not an error. Saturdays, holidays, an unsynced child,
  a school that serves no bell times — each must behave exactly as the feature did
  before.
- School days are not uniform. A first-grader finishes at 11:20 and an eighth-grader at
  15:00; one fixed hour cannot be right for both, which is how we got here.

## Decision

**1. A per-child gate, and the cron is only its outer bound.**
`backend/src/digest/digest-dismissal.service.ts` resolves, per child per run: today's
Mashov weekday → that child's `timetable_entry` rows for *that day* → `max(lesson)` →
the matching period from `bellScheduleForStudent` → `endTime + grace`. A run whose
Jerusalem wall clock is before that minute returns `skipped_before_dismissal` and does
nothing else.

The cron widens to `0 11-19 * * *`. The gate now makes the decision, so the cron's only
job is to be awake early enough for the shortest school day — a first-grader dismissed
at 11:20 is reported at around 12:00 rather than waiting for 13:00. The 19:00 end
stays: a child dismissed at the latest period the default schedule knows about (15:00)
still gets four ticks.

This is the first consumer of ADR-0037's bell schedule outside the timetable UI, which
ADR-0037 anticipated: *"Deriving on the server rather than in the grid means the digest
can reuse it."* It is also the first query anywhere in the backend to filter
`timetable_entry` by `day`; `@@index([studentGuid])` covers it adequately at this row
count. Filtering by day rather than taking the week's maximum is the whole point — a
child with eight periods on Monday and four on Friday must be released at lunchtime on
Friday.

**2. The gate sits before `claim()`, and that is the load-bearing invariant.**
A held tick consumes nothing. If it claimed, the items would be marked reported and the
post-dismissal tick would find a quiet day — turning a delay into permanent
suppression. The gate therefore runs before `DigestCheckerService.check`, which also
means a held tick costs no queries and no model call. It has its own test
(`claims nothing while it holds`), because it is the one defect in this change that
would be invisible to a parent and unrecoverable.

Stated positively: **this change can only ever delay a message.** The next tick reports
everything the held one would have.

**3. Missing data does not gate.**
No `timetable_entry` rows for today — Saturday (Mashov day 7 matches no lesson), a
holiday, a child whose timetable has never synced — returns "do not gate", and the run
proceeds exactly as it did before this ADR. Same for a bell schedule with no usable
period. The alternative, holding a child whose data we lack, would silently stop their
digest for as long as the gap lasted, which is the failure mode we are least able to
notice.

**4. A held tick writes no `digest_delivery` row. Logged at `debug`.**
The hold is a scheduling decision, not an outcome. A row per child per held hour would
add roughly three noise rows per child per day and drown the `skipped_empty` /
`skipped_stale` signal that ADR-0026 relies on to tell a quiet child from a broken job.
`GET /api/v1/digest/deliveries` therefore shows nothing for a held tick; the `debug`
line names the release time, the last lesson, its end time and whether the schedule was
the school's or the default.

**5. The manual-run endpoint bypasses the gate.**
`POST /api/v1/digest/runs` passes `ignoreDismissalGate: true`. A parent pressing the
button is asking for the digest *now*; the gate exists to stop unattended noise, not to
refuse an explicit request.

**6. The grace period is an env var: `DIGEST_POST_DISMISSAL_GRACE_MINUTES`, default 30.**
Matching how every other digest knob is exposed. It has its own reader rather than
reusing `digest.service.ts`'s `readDays`, which requires `> 0`: a configured `0` must
mean "no grace, gate on the bell itself", not fall silently back to half an hour.

**7. The wall clock is read through `Intl`, like every other date in this feature.**
`jerusalemClockMinutes` in `digest-deadline.service.ts` returns minutes since Jerusalem
midnight. The process is pinned to UTC (`src/common/process-zone.ts` throws at boot
otherwise), so `now.getHours()` would be two or three hours behind the clock the school
rings its bells on. It uses `hourCycle: 'h23'`, not `hour12: false`: the latter reports
`"24"` for midnight on some ICU builds, which would read as 1440 minutes and hold every
child's digest for a full day. One clock reading is taken per run, so every child in a
tick is judged against the same minute.

Bell times stay zone-less strings end to end. Nothing in the gate converts one to a
`Date` — comparing minutes-since-midnight against minutes-since-midnight is the entire
arithmetic, and introducing a `Date` would reintroduce the DST question ADR-0037's
string storage exists to avoid.

## Consequences

**Good**
- Fewer messages, each one more complete, and the first arrives when the register has
  plausibly been filled in.
- Correct for a short school day *and* a long one, from each child's own data, which no
  single cron window can be.
- The change cannot lose an item. Every refusal path either delays or declines to gate.
- `bell_schedule` now earns its keep beyond one grid, which is what ADR-0037 built it
  for.

**Bad / accepted**
- Both schools probed in ADR-0037 answer `GET /api/bells` with `200 []`, so the gate
  runs on the *bundled default* schedule for every child on this deployment today. The
  `debug` line says `default schedule` so this is visible rather than assumed. A child
  whose real last bell is 13:30 but whose default-schedule period 6 ends at 13:20 is
  released ten minutes early — a smaller error than the fixed 13:00 window it replaces,
  and it disappears the day a school serves real times.
- A child whose timetable is stale in the *other* direction — rows for eight periods on
  a day they actually finish at noon — is held until 15:30. A timetable sync fixes it;
  the gate memo is per run, so the next tick picks the correction up.
- Two of ADR-0026's three suggested refinements remain open: there is still no daily cap
  and no minimum item age. This moves the *start* of the window only.
- Nothing in the UI explains the schedule. A parent sees fewer messages and no reason
  why. Showing the computed start on the digest settings card is a reasonable follow-up.
- One extra pair of queries per child per tick (the day's timetable rows, the bell
  schedule), paid before the checker's work rather than after — and on a held tick it
  replaces the checker's queries entirely.
