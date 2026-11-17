# ADR-0026: Derived Homework Deadlines — Label the Estimate, Never Promise a Due Date

- **Date**: 2026-11-17
- **Status**: Accepted
- **Deciders**: Backend agent, Planner

## Context and Problem Statement

`school-parent-portal-requirements-v3.md` constraint 4 is explicit:

> Homework has no proven due date field… must not promise overdue or due-soon logic.

That constraint is correct. `apis/get-api-students-studentguid-homework.md` exposes exactly one
date, `lessonDate`, and it is when the homework was **given**, not when it is wanted. There is
no due-date field to read, infer from, or fall back to.

The digest nonetheless wants to answer "what needs attention", and "this is probably needed
tomorrow" is most of the value a parent gets from a daily briefing. Reporting only what was
assigned today tells a parent what they could already see; it does not help them at 19:00 on
the evening before.

## Decision

**Derive an estimate, from two sources in a fixed order, and label it as an estimate everywhere
it appears.**

1. **An explicit deadline written in the Hebrew text**, when the teacher wrote one
   ("להגיש עד יום חמישי"). Extracted by the summarizer and returned per item.
2. **Otherwise, the group's next lesson** from `timetable_entry` — walk forward from tomorrow
   up to 14 days and take the first day the group meets.

Explicit beats the timetable. An item with no resolvable deadline at all is left out of the
section rather than reported with a guess.

**A cheap regex gates nothing; it widens.** The checker runs seven times a day per child and
must stay free of model calls, so it cannot ask the model which items have deadlines. Instead
`hasDeadlineHint()` deliberately over-matches (`מחר`, `עד יום`, `להגיש`, a bare date) to pull
candidates *in*, and the model narrows them again afterwards. Over-collecting is safe because
dedup is by content hash; under-collecting would be invisible.

**The label is the whole point.** The report says `צפי הגשה` ("estimated submission"), never
`תאריך הגשה` ("due date"), and a section carrying an estimate is followed by a caveat stating
outright that Mashov supplies no due date and how the estimate was derived. The template owns
that string, so no model output can reword it.

It originally lived on each item bullet. The bullets were later removed — they repeated, line for
line, the facts the prose above them already gave, which made the message read like a record
rather than something written to a person. The label did **not** move into the prose with them:
it is appended by the template to the section's line as `(צפי הגשה: DD/MM/YYYY)`, because this is
the one factual claim in the report that a model must not be trusted to carry. The date is safe
to state once there because narrowing has already reduced the section to items whose estimate is
tomorrow. A unit test asserts that the section line never contains the due-date phrasing, scoped
to that line because the caveat beneath it uses the phrase precisely to deny it.

## Consequences

**Good.** The parent gets the useful half of "what needs attention" with an honest provenance
marker, and the constraint's actual intent — do not state as fact something the data does not
support — is kept. The departure is one labelled string rather than a silent inference.

**Bad.** The estimate will sometimes be wrong: a teacher who writes no deadline and whose group
meets Sunday will have Sunday reported when the real expectation was Thursday. The caveat is
what makes that survivable, and it is a weaker guarantee than the rest of the app offers.

### The resolved deadline is persisted, and why that was not optional

The implementation plan offered a dichotomy for an item the model dates to some day other than
tomorrow: either confirm it as reported (so the model is not asked again) or release the claim
(so it is looked at again). Review established that **neither is acceptable**.

Confirming buries the warning. A homework item reading `יש להגיש עד יום חמישי`, surfaced on
Tuesday by the text hint, would be marked reported — and on Wednesday, when Thursday genuinely
is tomorrow, the checker filters it out and the parent is never told. That defeats the half of
the feature this ADR exists to justify. It is also the common case rather than the exotic one:
the burying only happens when something *else* is in the report, which on a school day it
usually is.

Releasing avoids that but re-asks the model on every run for as long as the item stays in the
14-day lookback. `hasDeadlineHint` is deliberately broad, so an ordinary `יש להגיש בשיעור הבא`
qualifies, and seven runs a day for a fortnight is on the order of a hundred model calls per
item that produce no message at all.

So `digest_reported_item` carries **`resolvedDueDate`**. A confirmed row with it null means
fully reported; with it set, it means deferred to that date. The checker re-admits the item on
the day that date is tomorrow, and the orchestrator takes the row over when it does. One
resolution per item, no burying.

An item with no resolvable date at all — no explicit date in the text and no timetable rows for
its group — is released instead. There is nothing to defer to, and confirming it would bury it
permanently, because the content hash does not include the estimate: a later timetable sync
that finally gave the group a lesson tomorrow would never resurface it.

**What remains imperfect.** The model still re-reads the text on the runs before a resolution is
recorded, and two runs could in principle resolve the same item differently. That is benign in
the message itself — an item is shown only when its resolution *equals* tomorrow, and the date
displayed is that same value, so a wrong reading can cause a spurious "due tomorrow" but can
never print a date the model did not resolve to. A deterministic Hebrew date parser for the
common forms (`עד יום <weekday>`, `d/m`) would remove most of the model's involvement here and
is worthwhile follow-up.
