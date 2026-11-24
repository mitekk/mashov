# Branch-protection verification

Throwaway file. A `docs/**` change maps to no test layer, so `unit-test`,
`integration-test`, `e2e` and `build` are all skipped. The point of this PR is
whether it is *mergeable* in that state when `CI OK` is the only required
check — a skipped job reports neither success nor failure to branch protection.
