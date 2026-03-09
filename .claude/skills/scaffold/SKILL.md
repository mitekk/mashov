# Skill: scaffold

Bootstrap a fullstack application from a requirements document.

## When to Use

Invoke `/scaffold` when starting a new interview challenge. Paste or summarize the requirements in your message. This skill orchestrates the full project setup in the correct order.

## Handoff Artifacts

Each phase produces files in `docs/`. These survive session boundaries and are the source of truth for downstream agents.

| Artifact | Produced by | Consumed by | File |
|----------|-------------|-------------|------|
| Architecture Plan | planner (Step 1) | backend, frontend, qa | `docs/architecture.md` |
| API Contract | planner (initial), backend (updates) | frontend, qa | `docs/api-contract.md` |
| ADRs | adr (Steps 1, 2, 3) | all agents resuming session, reviewers | `docs/adr/` |

### API Contract format (`docs/api-contract.md`)

Required columns: `Method` | `Path` | `Auth?` | `Request Body` | `Response Body` | `Status`

`Status` values: `planned` → `implemented` → `changed`

No vague entries — every field name and type must be explicit. Vague entries ("some user fields") block frontend dispatch.

### Workflow State Marker (`docs/.scaffold-state.json`)

`/scaffold` must create and maintain this file. `/resume` reads this marker only (no git-log or artifact inference fallback).

Schema:

```json
{
  "workflow": "scaffold",
  "schema_version": 1,
  "status": "in_progress",
  "last_completed_step": 1,
  "next_step": 1,
  "updated_at": "2026-03-10T00:00:00Z",
  "blockers": [],
  "last_commit": "abc1234"
}
```

Constraints:
- `workflow` must be `"scaffold"`
- `schema_version` must be `1`
- `status` must be `in_progress`, `blocked`, or `completed`
- `last_completed_step` and `next_step` must be one of: `1, 2, 3, 3.5, 4, 5, 5.5, 5.7, 5.9, 6`
- `blockers` is optional; if present, it must be an array of strings
- `last_commit` is optional; if present, it must be a non-empty string

---

## Execution Steps

Run these steps in sequence. Each step delegates to the appropriate specialist agent.

### State Initialization (before Step 1)

At workflow start, initialize `docs/.scaffold-state.json`:

```bash
mkdir -p docs
cat > docs/.scaffold-state.json <<'EOF'
{
  "workflow": "scaffold",
  "schema_version": 1,
  "status": "in_progress",
  "last_completed_step": 1,
  "next_step": 1,
  "updated_at": "2026-03-10T00:00:00Z",
  "blockers": []
}
EOF
```

### State Transition Rules

Update `docs/.scaffold-state.json` before each scaffold checkpoint commit. Include this file in every scaffold checkpoint commit.

| Event | status | last_completed_step | next_step | blockers |
|---|---|---:|---:|---|
| Step 1 complete | `in_progress` | 1 | 2 | `[]` |
| Step 2+3 dispatched in parallel | `blocked` | 1 | 2 | `["Parallel phase active: wait for both Step 2 and Step 3 completion commits."]` |
| Step 2 complete, Step 3 pending | `blocked` | 1 | 3 | `["Step 2 complete; waiting for Step 3 frontend completion."]` |
| Step 3 complete, Step 2 pending | `blocked` | 1 | 2 | `["Step 3 complete; waiting for Step 2 backend completion."]` |
| Step 2 and Step 3 both complete | `in_progress` | 3 | 3.5 | `[]` |
| Step 3.5 complete | `in_progress` | 3.5 | 4 | `[]` |
| Step 4 complete | `in_progress` | 4 | 5 | `[]` |
| Step 5 complete | `in_progress` | 5 | 5.5 | `[]` |
| Step 5.5 complete | `in_progress` | 5.5 | 5.7 | `[]` |
| Step 5.7 complete | `in_progress` | 5.7 | 5.9 | `[]` |
| Step 5.9 complete | `in_progress` | 5.9 | 6 | `[]` |
| Step 6 complete | `completed` | 6 | 6 | `[]` |

Rollback/re-entry rule:
- When routing a failure back to an earlier phase, set `status` to `blocked`, set `next_step` to the corrective re-entry step, and set `blockers` to the failure summary before re-dispatching.

### Step 1 — Intake & Architecture (planner)

Delegate to the `planner` agent with the full requirements text. The planner will:
1. Ask clarifying questions (auth, real-time, DB choice, caching, existing codebase)
2. Wait for your answers
3. Produce: Goal, Scope, Architecture diagram, ordered task list, Risks, Open questions

### Architecture Confirmation Protocol

The planner must present this checklist to the human before Step 2 is dispatched:

- [ ] Goal statement agreed
- [ ] Stack choices confirmed (language, DB, cache)
- [ ] All 5 intake questions answered (auth, real-time, DB, caching, existing code)
- [ ] API contract table complete — no TBD entries, all field names and types explicit
- [ ] Task list tagged [MVP] / [NICE]
- [ ] Time budget confirmed

Do not proceed until the human replies with explicit confirmation.

#### ADR — Strategic Decisions

Once the human confirms, invoke the `adr` agent with the contents of `docs/architecture.md`. Ask it to produce ADRs for:
- Stack selection (language, framework, runtime)
- Database choice and schema approach
- Auth strategy
- Caching strategy (if applicable)

ADRs go in `docs/adr/`. Include them in the Step 1 committer commit — rename it to: `docs: add architecture plan, API contract, and initial ADRs`

### Parallelism Gate

Before dispatching backend and frontend, evaluate all of the following:

- [ ] Every endpoint has a concrete request body (field names + types — no TBDs)
- [ ] Every endpoint has a concrete response body
- [ ] Auth requirements per endpoint are explicit (Yes/No — no TBD)
- [ ] DB schema is decided (engine choice, table/collection names)

**If ALL checked:** use `superpowers:dispatching-parallel-agents` to dispatch Steps 2 and 3 simultaneously.

**If ANY unchecked:** route the gaps back to the planner — fill them — re-evaluate the checklist — then dispatch in parallel. Never default to serial; always resolve gaps and parallelize.

### Step 2 — Backend (backend)

Delegate to the `backend` agent with:
- The architecture doc from Step 1
- Specific tasks from the task list tagged as backend work

The backend agent delivers:
- Project structure (`backend/`)
- DB schema + migration files
- API routes with validation and error handling
- Auth implementation (if required)
- Redis caching layer (if required)
- `Dockerfile` + `docker-compose.yml` (owns the full compose file: db, redis, backend services)
- `GET /health` endpoint
- Unit tests for business logic

> **docker-compose.yml ownership**: backend owns the root `docker-compose.yml`. It defines all infrastructure services (db, redis) and the backend service. The frontend agent does NOT touch `docker-compose.yml` — it only produces its `Dockerfile`.

#### ADR — Backend Implementation Decisions

Once backend is complete, invoke the `adr` agent with context from the implementation. Document:
- ORM / query builder choice (if a real trade-off existed)
- Migration tool selection
- Any schema design decisions that had alternatives
- Rate limiting approach and library

Only write ADRs where a real alternative existed — skip trivial or forced choices. Include `docs/adr/` in the `feat(backend)` committer commit.

### Step 3 — Frontend (frontend)

Delegate to the `frontend` agent with:
- The architecture doc (`docs/architecture.md`)
- The API contract (`docs/api-contract.md`) from the planner
- Frontend-specific tasks from the task list

The frontend agent delivers:
- Project structure (`frontend/`)
- Page components and routing
- API client (typed, with error handling)
- State management
- `Dockerfile` only — the frontend service entry is added to `docker-compose.yml` in Step 3.5
- `data-testid` attributes on all interactive elements

#### ADR — Frontend Architecture Decisions

Once frontend is complete, invoke the `adr` agent with context from the implementation. Document:
- State management scope decision (what was kept local vs. Zustand)
- Form validation library choice (if alternatives were considered)
- Any significant component architecture trade-offs

Include `docs/adr/` in the `feat(frontend)` committer commit.

### Step 3.5 — Compose Assembly + API Contract Reconciliation

**First: add the frontend service to docker-compose.yml**

The frontend agent produced only a `Dockerfile` — its compose entry must be added now:
1. Inspect `frontend/Dockerfile` to confirm the exposed port
2. Add the frontend service entry to the existing `docker-compose.yml` following `.claude/rules/docker.md`
3. Set `depends_on: backend: condition: service_healthy`

**Then: check for API contract drift**

```bash
grep -i "changed" docs/api-contract.md
```

If any `Status = changed` entries exist:
1. Identify which endpoints changed (path, method, request/response fields)
2. Delegate to the `frontend` agent with the specific changed entries — fix only those routes
3. Once confirmed green, proceed to Step 4

If no `changed` entries: proceed directly to Step 4.

If `changed` entries existed and were resolved: invoke the `adr` agent to document the design decision that drove the contract change and why the updated design was accepted.

### Step 4 — Static Review (/review --static)

Run `/review --static` — lint, types, API conventions, security, README. No running stack needed. Fixes here give QA a type-clean, API-correct baseline.

**On failure:**
- Surface issues (missing README section, lint errors, un-committed `.env.example`) → fix directly → `committer` (`fix: address static review`) → re-run `/review --static`
- Type errors or API convention violations → invoke `/debug` → read the structured output:
  - **Owning agent: `backend`** → re-enter Step 2 with the recommended fix as context
  - **Owning agent: `frontend`** → re-enter Step 3 with the recommended fix as context
  - Run the **Verification command** from the debug output to confirm the fix → `committer` (`fix`) → re-run `/review --static`
- See Rollback Protocol for failure-type routing table

### Step 5 — QA & CI (qa)

Delegate to the `qa` agent with:
- The full codebase from Steps 2 and 3
- The architecture doc and updated `docs/api-contract.md`

The QA agent delivers:
- Integration tests (`tests/integration/`)
- E2E tests with Playwright (`tests/e2e/`) using page object model
- `.github/workflows/ci.yml`
- `playwright.config.ts`
- Coverage configuration

**On test failure:** run `/test` for a structured failure report. Then invoke `/debug` and read the structured output:
- **Owning agent: `backend`** → re-enter Step 2 with the recommended fix as context
- **Owning agent: `frontend`** → re-enter Step 3 with the recommended fix as context
- **Owning agent: `qa`** → fix directly in the test files
- Run the **Verification command** from the debug output to confirm the fix → re-run `/test`

For E2E failures, pass Playwright trace + Docker logs to `/debug` for evidence.

The qa agent confirms all layers green. `committer` commits only when `/test` passes: `test: add test suite and CI workflow`

### Step 5.5 — Full Review (/review)

Run `/review` (full mode, no flag) after QA completes. Now all checks are meaningful: tests exist, Docker images are built, E2E suite is written.

**On failure:**
- Surface issues → fix directly → `committer` (`fix: address full review`) → re-run `/review`
- Deep issues → invoke `/debug` → read the structured output:
  - **Owning agent: `backend`** → re-enter Step 2 with the recommended fix as context
  - **Owning agent: `frontend`** → re-enter Step 3 with the recommended fix as context
  - **Owning agent: `qa`** → fix directly in the test files
  - Run the **Verification command** from the debug output to confirm the fix → re-run `/review`
- See Rollback Protocol for failure-type routing table

### Step 5.7 — Smoke Test (/smoke-test)

Run `/smoke-test` after the full review passes. This is a **runtime verification** step — the `verifier` agent boots the Docker stack, interacts with the app via Playwright MCP, and finds bugs that automated tests missed.

The verifier runs 5 phases:
1. Infrastructure health (Docker services, Redis memory, DB connectivity, error logs)
2. Data integrity (unique constraints, required fields, FK references)
3. API contract compliance (hit every endpoint, verify response shapes match `docs/api-contract.md`)
4. UI interaction testing (search/filter behavior, image loading, state consistency, navigation)
5. Cross-cutting concerns (loading states, error recovery, empty states)

**On PASS:** proceed to Step 5.9.

**On FAIL:** each issue includes an owning agent. Route fixes:
- **Owning agent: `backend`** → re-enter Step 2 with the specific issue
- **Owning agent: `frontend`** → re-enter Step 3 with the specific issue
- **Owning agent: `qa`** → fix directly (e.g., shallow E2E tests flagged)
- **Owning agent: `infrastructure`** → fix in `docker-compose.yml` or Dockerfiles

After fixes, re-run `/smoke-test`. Maximum 2 fix cycles; escalate to human if still failing.

### Step 5.9 — Retrospective & Fix ADRs

This step always runs, even if smoke test passed clean.

1. **If smoke test found issues that were fixed:** invoke the `adr` agent to document each significant fix as an ADR — what went wrong, why it wasn't caught earlier, what was changed. `committer`: `fix: address smoke test findings`
2. **If smoke test passed clean:** proceed directly to Step 6 — no commit needed.

The retrospective ADRs serve two purposes:
- Document the fix decisions for reviewers
- Surface process gaps (e.g., "search filter bug wasn't caught because E2E tests were too shallow") that should feed back into agent/skill improvements

### Step 6 — Ship (committer)

1. Verify README is complete: setup steps, env vars table, how to run tests
2. `committer`: `chore: verify ship — tests green, docs complete`

---

## Rollback Protocol

When Step 4 (/review) or Step 5 (QA) surfaces a deep failure, use this table to re-enter the correct phase:

| Failure type | Surfaces at | Re-enter | Agent |
|---|---|---|---|
| TypeScript / lint errors | Step 4 | Step 2 or 3 | `backend` or `frontend` |
| API convention violations | Step 4 | Step 2 or 3 | `backend` or `frontend` |
| Missing `.env.example` / incomplete README | Step 4 | Step 4 in place | direct edit |
| Docker build broken | Step 5.5 | Step 2 or 3 | `backend` or `frontend` |
| Test coverage < 80% | Step 5.5 | Step 5 | `qa` |
| E2E tests failing | Step 5.5 | Step 5, then Step 3 if UI issue | `qa`, then `frontend` |
| High CVE in dependencies | Step 5.5 | Step 2 | `backend` |
| Stale UI state / cache bugs | Step 5.7 | Step 3 | `frontend` |
| Data integrity (duplicates, NULLs) | Step 5.7 | Step 2 | `backend` |
| Infrastructure (Redis OOM, disk full) | Step 5.7 | Step 3.5 | direct edit (compose/config) |
| API response doesn't match contract | Step 5.7 | Step 2 | `backend` |
| Shallow E2E tests flagged | Step 5.7 | Step 5 | `qa` |

Rules:
1. Before re-entering any step, update `docs/.scaffold-state.json` to `status: "blocked"` with the corrective `next_step` and blocker summary
2. Fix the specific failure only — no adjacent refactoring
3. Commit the fix before re-running `/review`
4. Re-run `/review` from the top — never skip items that passed before
5. Maximum 2 rollback cycles; if still failing, escalate to the human for scope reduction

---

## Resume Command Contract (`/resume`)

Use `/resume` for all interrupted scaffold workflows.

`/resume` must:
1. Read only `docs/.scaffold-state.json` (no fallback inference)
2. Validate schema and step values exactly
3. Validate required artifacts for the marker `next_step`
4. Output a **Resume Report** with:
   - Current marker fields (`status`, `last_completed_step`, `next_step`, `updated_at`, optional `last_commit`)
   - Artifact check results
   - Required re-entry context
   - Exact next command/delegation payload
5. Stop after guidance (never auto-dispatch)
