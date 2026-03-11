# PRD Versions

| Version | Date (UTC) | Notes |
|---|---|---|
| v0 | 2026-03-10 | Placeholder before first scaffold run |
| v1 | 2026-03-11 | Full PRD from requirements-v3.md + 18 API docs; Phase 1 (no auth) + Phase 2 (magic-link auth); CSRF bootstrap resolved; messageBoard + mail actions added; timetable deferred to Phase 2 |

## Update Protocol

1. Add a new `PRD-vN.md` file.
2. Copy or update `PRD-current.md` to match that version.
3. Append a row to this table with date and summary.
4. Update `docs/.scaffold-state.json` fields `prd_version` and `prd_path`.
5. Re-run Step 1 planning if the PRD changed after implementation started.
