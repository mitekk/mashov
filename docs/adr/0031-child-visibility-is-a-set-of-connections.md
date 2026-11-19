# ADR-0031: A Child's Visibility Is a Set of Connections, Not the One That Answered

- **Date**: 2026-11-18
- **Status**: Accepted
- **Deciders**: User, Backend agent
- **Amends**: [ADR-0030](0030-per-connection-data-scoping.md) ("Two known defects"), first defect
- **Implements the decision B1 was waiting on**: `docs/plans/merged-household-access-followups.md`
- **Implemented by**: `1dcb60e`, migration
  `20261122000000_student_connection_links`, and
  `tests/integration/household-isolation.test.ts`

## Context and Problem Statement

ADR-0030 shipped `Student.householdConnectionId` as the ownership discriminator for every
per-child read, and recorded in the same breath that it is wrong for two parents. It is wrong
because that one column was made to carry two different jobs:

1. **Routing** — whose Mashov credentials to use upstream for this child. One value is
   correct: any connection that lists the child will serve, and a wrong guess self-corrects
   on the next sync (`stampOwnershipIfChanged`).
2. **Visibility** — which users may reach this child
   (`ChildrenService.householdStudentWhere` / `ownsStudent`,
   `DashboardService.householdStudentWhere`, the guid→year map in `school-year.scope.ts`).
   One value is **wrong**: a child can legitimately belong to more than one user.

The supported shape — two `AppUser`s, two Mashov accounts, one school, the same children —
is required by **ADR-0016** ("two parents in the same household must be able to independently
track what they have read") and described by **PRD open question 2** ("each user creates their
own connection"). Today the second parent to sync re-stamps the shared `studentGuid` rows and
the first parent's children vanish until their own next sync flips it back.

The decisive constraint is one the schema already states: **every per-child table is keyed by
`studentGuid` alone** — `homeworkItem`, `behaviorItem`, `timetableEntry`, `subjectEnrollment`,
`messageBoardItem`, `studentRelease`, `digestRecipient`, `digestReportedItem`,
`digestDelivery` — and `Student.studentGuid` is globally `@unique`. The data model already
holds one shared copy of a child's data, fetched once and read by whoever may see that child.
`UserItemState` is keyed `(userId, item)`, so per-user read state is already independent of
all of this. What is missing is only the **visibility edge**.

## Decision

**Visibility becomes a many-to-many edge; routing stays on the column.**

A new join table records which connections' login rosters list a child:

```prisma
model StudentConnection {
  studentGuid           String
  householdConnectionId String
  firstSeenAt           DateTime @default(now())
  lastSeenInRosterAt    DateTime

  @@id([studentGuid, householdConnectionId])
  @@index([householdConnectionId])
  @@map("student_connection")
}
```

`Student.householdConnectionId` **keeps its single remaining job, routing**, and its doc
comment is rewritten to say only that. `ConnectionScopeService.targetForStudent`,
`orderConnectionsForStudent` and `stampOwnershipIfChanged` are untouched, so a stamped child
still costs exactly one upstream call per task.

**Amended (`3afde47`).** `targetForStudent` is no longer untouched: a stamp outside the
caller's own connections is now treated as no stamp (**R16**). Routing still reads the
stamp, so the one-call-per-task property above still holds.

The four visibility readers move from "the stamp is one of mine" to "a link to one of mine
exists". The three roster writers that already stamp — `MashovSessionService.persistRoster`,
`AuthService.persistLoginRoster`, `SchoolLinksService.persistLink` — upsert a link row beside
the stamp they already write.

**Unlink changes meaning, and this is the consequence that needs stating plainly.**
`ConnectionService.deleteOneConnection` today deletes this connection's children and all
their per-child rows. Under this decision it deletes **the link row**, and the `Student` plus
its per-child data **only when no link remains**. A child two parents share survives one
parent unlinking. Getting this wrong deletes the other parent's children and their whole
history — the same failure class the branch already fixed once for the `NULL`-stamp
predicate, which is why it is called out here rather than left to the implementation.

`NULL`/no-link keeps its established meaning: a child with no links is readable by any
caller, because "ownership unknown, re-stamp on the next roster refresh" is not "nobody's".
That is `ownsStudent`'s existing rule, carried over unchanged.

## Consequences

**Good**

- The stated requirement works: both parents see the shared children at the same time, with
  no dependence on sync ordering.
- `householdConnectionId` means one thing, and the owner-first fan-out that depends on it
  keeps working untouched.
- The change is additive to the schema, so it pushes onto populated tables.
- Each affected read already goes through a single helper, so there are four predicates to
  change, not forty call sites.

**Bad / accepted**

- Two tables now encode a student→connection relationship, and they can disagree. Accepted
  because they answer different questions; see the alternative below.
- One extra write per child per roster refresh, and a join on the children list.
- The unlink rewrite is the risky part of the work and carries the data-loss blast radius.

**Neutral**

- A child's data is shared, not duplicated per parent. Two parents at one school cost one
  upstream fetch, not two. This was already true; the decision makes it intentional.

## Alternatives considered

- **Derive visibility from a retained per-connection roster instead of storing an edge.**
  Rejected as the same table with a worse name: retaining the roster *is*
  `(connectionId, studentGuid, seenAt)`. A row that means "was last seen in a roster" invites
  pruning on a sync hiccup, and pruning it silently revokes a parent's access to their child.
  An explicit visibility edge with `firstSeenAt` says what it is for.

- **Drop `Student.householdConnectionId` entirely and derive routing from the links** (prefer
  the link that last answered). One source of truth instead of two that can drift, and the
  better end state. Rejected *for now* because it additionally rewrites
  `ConnectionScopeService` and the fan-out, which this decision deliberately leaves alone.
  Revisit if the stamp and the links are ever observed to disagree in a way that matters.
  **That condition was met once** (**R16**: a parent's release request went upstream under
  the other parent's credentials) and was answered in `3afde47` by bounding the stamp to the
  caller and preferring their connection at the stamped school — a `schoolCode` proxy inside
  the existing resolver, not the link-derived rewrite this alternative proposes. The
  rejection therefore still stands.

- **A real `Household` entity above `AppUser`, with several users sharing one connection
  set.** Rejected **because it does not fix the defect.** Two parents who have not
  deliberately joined a household still hold distinct connections listing the same
  `studentGuid`, against one global `Student` row with one stamp — so they still evict each
  other. A `Household` would only help the parents who explicitly merge, while needing an
  invite flow, a new trust boundary, and a rewrite of what `userId` means in every service
  signature (invalidating the reasoning in ADR-0015/0019/0020). Whether two people can share
  one household is a real product question, but it is orthogonal to this one and strictly
  larger: this edge is needed either way, and a later `Household` is a backfill from it.

- **Composite `(studentGuid, householdConnectionId)` key on `Student` and every per-child
  table.** Rejected: it duplicates a child's homework, behaviour and timetable per parent,
  doubles the upstream fetch, and rewrites the key of nine tables — the limitation the plan
  already recorded as risk 6 rather than taking on.
