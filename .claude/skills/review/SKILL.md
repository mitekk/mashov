# Skill: review

Pre-submission checklist for interview coding challenges.

## When to Use

Invoke `/review` before declaring a task complete. Works through every item in the Definition of Done and surfaces anything that needs fixing.

## Checklist

Work through each item in order. For each check, run the relevant command or inspect the relevant files. Report pass/fail with specific details on failures.

### Tests

- [ ] `npm test` (or `pytest`) exits 0 — all unit and integration tests pass
- [ ] Coverage is at or above 80% — check coverage report output
- [ ] No skipped or `.only` tests left in the codebase

### Types & Lint

- [ ] `npm run typecheck` (or `mypy`) exits 0 — no type errors
- [ ] `npm run lint` exits 0 — no lint errors or warnings

### API Conventions

> Standards defined in `.claude/rules/api.md` — check compliance before marking review passed.

- [ ] All API endpoints under `/api/v1/` prefix (no unversioned routes)
- [ ] Every error response uses the required shape: `{ error: { code, message, details } }`
- [ ] All list endpoints return the pagination envelope: `{ data, pagination: { page, limit, total, totalPages } }`
- [ ] No JWT or auth tokens stored in `localStorage` — `git grep -r "localStorage" -- 'frontend/src'` returns nothing auth-related
- [ ] CORS origin is an explicit allow-list — no `Access-Control-Allow-Origin: *` in backend config

### Docker

- [ ] `docker compose build` exits 0 — all images build successfully
- [ ] `docker compose up --wait` exits 0 — all services reach healthy state
- [ ] `GET /health` returns HTTP 200 `{ "status": "ok" }` on the running stack
- [ ] `docker compose down -v` cleans up without errors

### E2E

- [ ] `npx playwright test` passes against the Dockerized stack
- [ ] No flaky tests (run twice if unsure)

### Security / Secrets

- [ ] No `.env` file committed (check `git status` and `git log`)
- [ ] `.env.example` exists with placeholder values for all required vars
- [ ] No hardcoded credentials, API keys, or secrets in source code
- [ ] `git grep -r "password\|secret\|api_key" -- '*.ts' '*.py' '*.js'` returns nothing sensitive
- [ ] `npm audit --audit-level=high` exits 0 — no high or critical vulnerabilities
- [ ] (Python) `pip-audit` exits 0 — no known vulnerabilities in dependencies

### README

- [ ] README exists with: project description, prerequisites, setup steps, how to run tests, environment variables table

## Output Format

Report results as a checklist with pass/fail status. For each failure, include:
- What failed
- The exact error or file location
- What needs to be fixed

Do not mark the review as passed until all items are checked.
