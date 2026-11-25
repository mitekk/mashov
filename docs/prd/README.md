# PRD Versions

| Version | Date (UTC) | Notes |
|---|---|---|
| v0 | 2026-03-10 | Placeholder before first scaffold run |
| v1 | 2026-03-11 | Full PRD from requirements-v3.md + 18 API docs; Phase 1 (no auth) + Phase 2 (magic-link auth); CSRF bootstrap resolved; messageBoard + mail actions added; timetable deferred to Phase 2 |
| v2 | 2026-03-16 | Phase 2 PRD: magic-link auth, per-user data scoping, multi-household, school account connection/management, user_item_state migration from item-level flags, new DB tables (app_user, app_session, magic_link_token, user_item_state) |
| v3 | 2026-11-20 | Phase 2 + 2.1: corrects v2's "one parent = one household = one school" model. Child visibility becomes a set of connections (two parents at one school see shared children), up to 4 schools per household, sign-in adoption, the confirmed household merge, per-school contact details and item-level school labels. Removes `me.connectedSchool`, `DashboardResponse.school` and the `/connection` aliases. Resolves all four open questions — #2 in the opposite direction to v2's default |
| v4 | 2026-11-25 | Phase 2 + 2.1 + 2.2: adds the read-only grades view. Grades move out of Out of Scope into FR-39 … FR-44 — ציונים as a sixth child-workspace section, synced into `grade_item` on a 12-minute cron, grouped by subject with a plain-mean average. Narrows the exclusion to analytics, trends and report cards, and names the eight things that stay out (read-state, feed, digest, detail route, term filtering, historical years, teacher name). Opens Question #5 on `denyStudentsRegularGrades` / `textualGradesClasses`. v3's FR-1 … FR-38 and DoD 1–21 unchanged |

## Update Protocol

1. Add a new `PRD-vN.md` file.
2. Copy or update `PRD-current.md` to match that version.
3. Append a row to this table with date and summary.
4. Update `docs/.scaffold-state.json` fields `prd_version` and `prd_path`.
5. Re-run Step 1 planning if the PRD changed after implementation started.
