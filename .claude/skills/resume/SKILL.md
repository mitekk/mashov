# Skill: resume

Recover an interrupted scaffold workflow using the committed marker file.

## When to Use

Invoke `/resume` when a `/scaffold` run was interrupted (context cleared, session ended, or handoff to another session) and you need a deterministic re-entry step.

Scope: scaffold workflow only.

## Source of Truth

Use only `docs/.scaffold-state.json`.

No fallback inference from:
- `git log`
- commit message patterns
- ad hoc artifact guesses

If the marker file is missing, fail with:
- `Resume unavailable: docs/.scaffold-state.json is missing. Start with /scaffold to initialize workflow state.`

## Validation

Validate the marker before any recommendation:

1. JSON is valid
2. `workflow === "scaffold"`
3. `schema_version === 1`
4. `status` is one of: `in_progress`, `blocked`, `completed`
5. `last_completed_step` and `next_step` are one of: `1, 2, 3, 3.5, 4, 5, 5.5, 5.7, 5.9, 6`
6. `blockers` (if present) is an array of strings
7. `last_commit` (if present) is a non-empty string

If validation fails, stop and return:
- exactly which field is invalid
- the expected values/shape
- repair action: update `docs/.scaffold-state.json`, then run `/resume` again

## Required Artifact Checks by `next_step`

Before producing final guidance, validate artifacts for the marker `next_step`.

| next_step | Required artifacts |
|---:|---|
| 1 | none |
| 2 | `docs/architecture.md`, `docs/api-contract.md` |
| 3 | `docs/architecture.md`, `docs/api-contract.md` |
| 3.5 | `frontend/Dockerfile`, `docs/api-contract.md`, `docker-compose.yml` |
| 4 | `docs/api-contract.md` |
| 5 | `docs/architecture.md`, `docs/api-contract.md` |
| 5.5 | `.github/workflows/ci.yml` |
| 5.7 | `.github/workflows/ci.yml`, `tests/e2e/` |
| 5.9 | none |
| 6 | `README.md` |

If any required artifact is missing:
- keep the same `next_step`
- mark result as blocked in report output
- list exact missing path(s)
- recommend creating/fixing missing artifacts first

## Resume Report Output

Always output this structure:

```markdown
## Resume Report
- Workflow: scaffold
- Status: <in_progress|blocked|completed>
- Last completed step: <value>
- Next step: <value>
- Updated at: <timestamp>
- Last commit: <hash|not set>

### Artifact Check
- PASS: <path>
- FAIL: <path> (missing)

### Required Context for Re-entry
- <exact docs/files to pass to the next agent or command>

### Recommended Next Action
<exact command or delegation payload>
```

## Next Action Mapping

Use this mapping for the final recommendation:

| next_step | Recommended next action |
|---:|---|
| 1 | Run `/scaffold` and start Step 1 intake with the requirements text |
| 2 | Delegate Step 2 to `backend` with `docs/architecture.md` + backend-tagged tasks |
| 3 | Delegate Step 3 to `frontend` with `docs/architecture.md` + `docs/api-contract.md` |
| 3.5 | Run Step 3.5 compose assembly + API contract reconciliation |
| 4 | Run `/review --static` |
| 5 | Delegate Step 5 to `qa` with architecture + API contract context |
| 5.5 | Run `/review` |
| 5.7 | Run `/smoke-test` |
| 5.9 | Run retrospective: ADR updates for smoke findings, then checkpoint commit if needed |
| 6 | Run ship verification with `committer` |

Completed workflow rule:
- If `status` is `completed` and `last_completed_step` is `6`, output: `No actionable resume path: scaffold workflow is complete.`

## Behavior Constraints

- Recommendation-only: never auto-dispatch agents
- Never mutate files during `/resume`
- Stop after guidance and wait for user action
