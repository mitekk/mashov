# Project Instructions

## What This Is

Fullstack interview coding challenge workspace. Requirements arrive as specs; output is a working fullstack app, ready to run and reviewed against a Definition of Done.

## Stack

| Layer | Default choices |
|-------|----------------|
| Frontend | React + Vite + TypeScript |
| Backend | Node/Fastify + TypeScript **or** Python/FastAPI |
| Database | PostgreSQL **or** MongoDB |
| Cache | Redis (when needed) |
| Infrastructure | Docker Compose |
| CI | GitHub Actions |

## Key Directories

```
frontend/        React app
backend/         API server
tests/
  integration/   Integration tests
  e2e/           Playwright end-to-end tests
.github/
  workflows/     CI pipelines
```

## Golden Commands

```bash
docker compose up --build    # Lift full stack
npm run dev                  # Frontend dev server
npm run test                 # Unit + integration tests
npm run test:coverage        # With coverage report
npx playwright test          # E2E suite
npm run lint                 # Lint check
npm run typecheck            # TypeScript check
```

## Interview Workflow

1. **Intake** — paste requirements; delegate to `planner` to ask clarifying questions and produce architecture
2. **Backend** — delegate to `backend` for API, DB schema, migrations, Docker service
3. **Frontend** — delegate to `frontend` for pages, routing, API client, state
4. **QA** — delegate to `qa` for unit, integration, and e2e tests; CI workflow
5. **Review** — run `/review` skill for pre-submission checklist
6. **Ship** — run `/test` to verify full suite is green

## Definition of Done

- [ ] All unit and integration tests pass
- [ ] TypeScript compiles / Python types valid (`mypy --strict`)
- [ ] Lint clean (no errors)
- [ ] `docker compose up --build` succeeds and stack is healthy
- [ ] E2E suite passes against dockerized stack
- [ ] No `.env` committed; `.env.example` provided
- [ ] No secrets or credentials in source code
- [ ] `npm audit --audit-level=high` (or `pip-audit`) passes — no high/critical CVEs
- [ ] README has: setup steps, env vars, how to run tests

## Time-Boxing

Ask the planner: **"How much time do you have?"** If unspecified, assume 3 hours.

Tag every task **[MVP]** or **[NICE]**:
- **[MVP]**: must ship to satisfy stated requirements and pass the DoD
- **[NICE]**: polish, extras, edge cases — only if time allows

When time is tight, cut **[NICE]** tasks before cutting tests or Docker. A working, tested, containerized app beats a feature-rich one that doesn't run.

## Skills

| Invoke | Use when |
|--------|----------|
| `/scaffold` | Starting a new challenge — intake, architecture, full stack setup |
| `/review` | Pre-submission DoD checklist |
| `/test` | Full test suite run with layered failure report |
| `/debug` | Stack won't start, tests fail unexpectedly, CI is red |
| `/vercel-react-best-practices` | React/Next.js performance deep-dive (58 rules) |

## Agents

Delegate tasks to the appropriate specialist agent:

| Agent | Use when |
|-------|----------|
| `frontend` | Building any web UI — pages, components, dashboards, forms, web apps, HTML/CSS/JS |
| `backend` | APIs, databases, auth, business logic, data models, migrations, infrastructure |
| `qa` | Writing tests, finding bugs, reviewing code for correctness, auditing coverage |
| `planner` | Planning features, designing architecture, breaking down tasks, evaluating approaches |
