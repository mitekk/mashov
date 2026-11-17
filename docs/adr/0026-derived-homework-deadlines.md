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
that string, so no model output can reword it. A unit test asserts, per bullet, that the
due-date phrasing never appears — scoped to the bullets because the caveat uses that phrase
precisely to deny it.

## Consequences

**Good.** The parent gets the useful half of "what needs attention" with an honest provenance
marker, and the constraint's actual intent — do not state as fact something the data does not
support — is kept. The departure is one labelled string rather than a silent inference.

**Bad.** The estimate will sometimes be wrong: a teacher who writes no deadline and whose group
meets Sunday will have Sunday reported when the real expectation was Thursday. The caveat is
what makes that survivable, and it is a weaker guarantee than the rest of the app offers.

**A known defect, recorded rather than hidden.** The resolved deadline is **not persisted**.
The model re-reads the same text on every run that reaches it, and two runs can in principle
resolve the same item differently. The orchestrator therefore releases — rather than confirms —
the claim on an item whose deadline turns out not to be tomorrow, so that the item is
re-evaluated and *is* reported on the day it is actually near. Confirming it, as the original
plan specified, would have meant that on Wednesday, when a Thursday deadline really is
tomorrow, the item counted as already reported and the parent was never told — silently
defeating the half of the feature this ADR exists to justify.

The cost of that choice is bounded: the model is called once per child per run regardless of
item count, so re-evaluation adds no call that was not already happening. What it does cost is
that a child whose only unreported news is a deferred deadline triggers a model call on each of
the seven runs and sends nothing.

**Persisting the resolved due date is the proper fix** — a `homework_due_date` row keyed by item
and school year, written once and read by the checker — which would remove both the flapping and
the repeated evaluation. It needs a schema change and is deliberately left as follow-up work.
