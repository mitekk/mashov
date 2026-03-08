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

### API Contract format (`docs/api-contract.md`)

Required columns: `Method` | `Path` | `Auth?` | `Request Body` | `Response Body` | `Status`

`Status` values: `planned` → `implemented` → `changed`

No vague entries — every field name and type must be explicit. Vague entries ("some user fields") block frontend dispatch.

---

## Execution Steps

Run these steps in sequence. Each step delegates to the appropriate specialist agent.

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
- `Dockerfile` + `docker-compose.yml` service entry
- `GET /health` endpoint
- Unit tests for business logic

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
- `Dockerfile` + `docker-compose.yml` service entry
- `data-testid` attributes on all interactive elements

### Step 3.5 — API Contract Reconciliation

Before running `/review`, check whether the backend updated the contract during parallel dispatch:

```bash
grep -i "changed" docs/api-contract.md
```

If any `Status = changed` entries exist:
1. Identify which endpoints changed (path, method, request/response fields)
2. Delegate to the `frontend` agent with the specific changed entries — fix only those routes
3. Once confirmed green, proceed to Step 4

If no `changed` entries: proceed directly to Step 4.

### Step 4 — Review (/review)

Run `/review` to check Docker, TypeScript, lint, secrets, and README before the test suite runs. Fixing these first gives QA a clean baseline.

**On failure:**
- Surface issues (missing README section, lint errors, un-committed `.env.example`) → fix directly → `committer` (`fix`) → re-run `/review`
- Deep issues (Docker build broken, type errors) → invoke `/debug` → read the structured output:
  - **Owning agent: `backend`** → re-enter Step 2 with the recommended fix as context
  - **Owning agent: `frontend`** → re-enter Step 3 with the recommended fix as context
  - **Owning agent: `qa`** → re-enter Step 5 with the recommended fix as context
  - Run the **Verification command** from the debug output to confirm the fix → `committer` (`fix`) → re-run `/review`
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

### Step 6 — Ship (committer)

1. Run `/test` — all layers must be green (final confirmation)
2. Verify README is complete: setup steps, env vars table, how to run tests
3. `committer`: `chore: verify ship — tests green, docs complete`

---

## Rollback Protocol

When Step 4 (/review) or Step 5 (QA) surfaces a deep failure, use this table to re-enter the correct phase:

| Failure type | Re-enter | Agent |
|---|---|---|
| Docker build broken | Step 2 or 3 | `backend` or `frontend` |
| TypeScript / lint errors | Step 2 or 3 | `backend` or `frontend` |
| Missing `.env.example` / incomplete README | Step 4 in place | direct edit |
| Test coverage < 80% | Step 5 | `qa` |
| E2E tests failing | Step 5, then Step 3 if UI issue | `qa`, then `frontend` |
| High CVE in dependencies | Step 2 | `backend` |

Rules:
1. Fix the specific failure only — no adjacent refactoring
2. Commit the fix before re-running `/review`
3. Re-run `/review` from the top — never skip items that passed before
4. Maximum 2 rollback cycles; if still failing, escalate to the human for scope reduction

---

## Resuming an Interrupted Session

If the challenge was interrupted (context cleared, session ended), determine which step was last completed and re-enter there.

### Step 1: Check existing artifacts

```bash
ls docs/                   # architecture.md and/or api-contract.md present?
git log --oneline -10      # what was last committed?
```

### Step 2: Map last commit to workflow step

| Last commit message contains | Re-enter at |
|------------------------------|-------------|
| `docs: add architecture` | Step 2 (Backend) |
| `feat(backend)` | Step 3 (Frontend) — check if it was also dispatched |
| `feat(frontend)` | Step 3.5 (Contract reconciliation) |
| `fix: address review` | Step 5 (QA) |
| `test: add test suite` | Step 6 (Ship) |

### Step 3: Re-enter with context

When delegating to an agent mid-workflow, provide:
- The relevant `docs/` artifact(s) as context
- The git log showing what's already complete
- The specific tasks remaining (from the architecture plan task list)
