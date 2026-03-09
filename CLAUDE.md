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
docs/
  architecture.md   Architecture plan (produced by planner, consumed by backend/frontend/qa)
  api-contract.md   API contract (planner → backend updates → frontend, qa)
  .scaffold-state.json  Scaffold workflow checkpoint marker (source of truth for /resume)
  adr/              Architecture Decision Records (one per significant decision)
    README.md       ADR index
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

Run `/scaffold` — it orchestrates the full sequence (intake → backend → frontend → review → QA → smoke test → retrospective → ship). See `.claude/skills/scaffold/SKILL.md` for the authoritative steps and commit sequence.
If the workflow is interrupted, run `/resume` to get the exact re-entry step from `docs/.scaffold-state.json`.

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
- [ ] Smoke test passes — verifier agent finds no critical/high issues
- [ ] Data integrity verified — unique constraints, no NULLs in required fields
- [ ] Hot reload works in Docker (docker-compose.override.yml provided)

## Time-Boxing

Managed by the `planner` agent. See [`.claude/agents/planner.md`](.claude/agents/planner.md) for the [MVP]/[NICE] protocol, the 3-hour default, and the execution sequence.

## Skills

| Invoke | Use when |
|--------|----------|
| `/scaffold` | Starting a new challenge — intake, architecture, full stack setup |
| `/resume` | Resume an interrupted scaffold workflow from the committed marker state |
| `/review` | Pre-submission DoD checklist |
| `/test` | Full test suite run with layered failure report |
| `/debug` | Stack won't start, tests fail unexpectedly, CI is red |
| `/smoke-test` | Runtime verification — boot the app, interact with it, find bugs tests missed |
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
| `adr` | Documenting architecture decisions — stack selection, auth strategy, key trade-offs |
| `verifier` | Runtime smoke testing — adversarial user interaction via Playwright MCP |
