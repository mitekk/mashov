# Skill: scaffold

Bootstrap a fullstack application from a requirements document.

## When to Use

Invoke `/scaffold` when starting a new interview challenge. Paste or summarize the requirements in your message. This skill orchestrates the full project setup in the correct order.

## Execution Steps

Run these steps in sequence. Each step delegates to the appropriate specialist agent.

### Step 1 — Intake & Architecture (planner)

Delegate to the `planner` agent with the full requirements text. The planner will:
1. Ask clarifying questions (auth, real-time, DB choice, caching, existing codebase)
2. Wait for your answers
3. Produce: Goal, Scope, Architecture diagram, ordered task list, Risks, Open questions

Do not proceed to Step 2 until the architecture is confirmed.

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
- The architecture doc
- The API contract (routes + request/response shapes) from Step 2
- Frontend-specific tasks from the task list

The frontend agent delivers:
- Project structure (`frontend/`)
- Page components and routing
- API client (typed, with error handling)
- State management
- `Dockerfile` + `docker-compose.yml` service entry
- `data-testid` attributes on all interactive elements

### Step 4 — QA & CI (qa)

Delegate to the `qa` agent with:
- The full codebase from Steps 2 and 3
- The architecture doc

The QA agent delivers:
- Integration tests (`tests/integration/`)
- E2E tests with Playwright (`tests/e2e/`) using page object model
- `.github/workflows/ci.yml`
- `playwright.config.ts`
- Coverage configuration

### Step 5 — Verify

Run `/review` to check the full Definition of Done before declaring the scaffold complete.
