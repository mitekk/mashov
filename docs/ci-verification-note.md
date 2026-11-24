# CI selection verification

Throwaway file. Exercises the docs-only path of `scripts/select-tests.mjs`:
`docs/**` maps to no test layer, so every test job should skip and `ci-ok`
should still report success.

Appended to exercise the on-demand full-run trigger: the diff is still
docs-only, so a full run can only come from the commit message.
