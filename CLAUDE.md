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

1. **Intake** — paste requirements; delegate to `planner` → architecture + `docs/api-contract.md` → `committer` (`docs`)
2/3. **Backend + Frontend** — parallel if API contract is complete; if gaps exist, resolve with planner first then parallelize
   - `backend` → `committer` (`feat(backend)`)
   - `frontend` → `committer` (`feat(frontend)`)
4. **Review** — run `/review` (pre-QA gate: Docker, types, lint, secrets, README) → `committer` (`fix`, if needed)
5. **QA** — delegate to `qa` → all test layers green → `committer` (`test`)
6. **Ship** — `committer` after `/test` green + docs verified (`chore: verify ship`)

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

Managed by the `planner` agent. See [`.claude/agents/planner.md`](.claude/agents/planner.md) for the [MVP]/[NICE] protocol, the 3-hour default, and the execution sequence.

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
| `committer` | Documenting completed work, staging files, writing conventional commits with context |
