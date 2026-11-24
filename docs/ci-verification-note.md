# Branch-protection verification

Throwaway file. A `docs/**` change maps to no test layer, so `unit-test`,
`integration-test`, `e2e` and `build` all skip. This PR exists to confirm that
such a PR is genuinely mergeable against the real `master` protection rule,
which requires only the `CI OK` check.
