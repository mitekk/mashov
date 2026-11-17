# ADR-0023: Bounding Mashov Egress — `AbortSignal` in a Shared Axios Factory

- **Date**: 2026-11-16
- **Status**: Accepted
- **Deciders**: Backend agent, Smoke test verifier

## Context and Problem Statement

Mashov blocks the production server's IP: `GET https://web.mashov.info/api/schools` returns
403 in ~110ms from the server and 200 in ~90ms from a residential IP. Production therefore
egresses through an HTTP proxy configured via `HTTPS_PROXY` (`HttpsProxyAgent`).

The proxy host dropped off the tailnet when its node key expired. A dead tailnet node
**blackholes** traffic — ping is 100% loss and TCP connects to the proxy port hang
indefinitely rather than being refused with an RST.

Under that condition `GET /api/v1/auth/schools` hung past 125s and ended in a Cloudflare 524,
even though the call declared `timeout: 10000`. The school dropdown never populated, so nobody
could sign in. The cause is that axios arms its `timeout` with `req.setTimeout()`, which only
starts counting **once a socket is assigned**; `HttpsProxyAgent` defers socket assignment until
its CONNECT completes. Against a blackhole, CONNECT never completes, so the timeout never arms.

Measured locally against a blackholed proxy, `timeout: 5000` in every case:

| Case | Config | Rejected after |
|---|---|---|
| A | `HttpsProxyAgent` → blackhole | **>20,000 ms** (full hang measured at ~75s) |
| B | direct, no agent | **5,023 ms** |
| FIX1 | `+ signal: AbortSignal.timeout(5000)` | **5,003 ms** |
| FIX2 | `+ new HttpsProxyAgent(url, { timeout: 4000 })` | **75,011 ms** |

So the proxy going away was the trigger; the unbounded stall was the amplifier that turned a
recoverable upstream failure into a total outage with no error message.

### What the recovery confirmed

The expired key took egress down **twice, by two different mechanisms** — confirmed from the
host's own journal while recovering:

1. **Key expiry.** The node left the tailnet, so the proxy's address became unreachable from the
   backend. The proxy process itself kept running, already bound. This is when sign-in broke.
2. **Next reboot, ~6 weeks later.** The proxy config said `Listen <tailnet-ip>`. With the node
   logged out, that address never came up, so tinyproxy lost a boot race against the VPN daemon,
   exited `71/OSERR`, and — with no `Restart=` in its unit — stayed dead. Even re-joining the
   tailnet would no longer have been enough.

Two lessons went into `ops/install-egress-proxy.sh`: bind `0.0.0.0` and restrict by ACL rather
than binding the VPN address (the tighter-looking option is the one that fails closed on boot),
and set `Restart=on-failure`, because `systemctl enable` only covers a clean boot.

The blackhole-vs-refusal distinction was then demonstrated in production rather than only in the
local harness. Re-joining the host to the tailnet, with the proxy service still absent, changed
the live endpoint from **524 after ~125s** to **502 in 1.1s** with no deploy: a reachable host
refuses a closed port, and the existing error mapping handled the refusal correctly all along.
The hang was never about a misconfigured port — it was about packets vanishing instead of being
rejected. That is the failure the `AbortSignal` bound exists for, and the only one axios' own
`timeout` cannot see.

## Decision Drivers

- A dependency failure must degrade to a fast error with the project's error envelope, not to a
  CDN gateway timeout with no body — a user-facing outage must be distinguishable from a hang
- The bound has to hold regardless of socket-assignment state, which rules out any mechanism
  that only starts counting after a connection exists
- Three call sites bypassed the shared `createMashovAxios` factory and used bare `axios`, so
  any fix applied only to the factory would have missed exactly the two endpoints that broke
- Operational recovery (re-joining the proxy to the tailnet) fixes the trigger but not the
  amplifier; the amplifier must be fixed in code or the next egress failure repeats the outage

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| `AbortSignal.timeout()` attached by a request interceptor in `createMashovAxios` | Starts counting immediately, independent of socket assignment; one place covers every Mashov call; measured at 5,003ms against the blackhole | Rejects with `ERR_CANCELED` rather than axios' `ECONNABORTED`, so timeout-sensitive retry predicates must be read with that in mind | **Selected** |
| `new HttpsProxyAgent(url, { timeout })` | Would keep the bound inside the proxy layer where the stall occurs | **Measured and does not work** — 75,011ms against the blackhole; the option does not bound the TCP connect | Rejected |
| Lower the existing axios `timeout` values | No new mechanism | Does not address the defect at all: the timeout never arms, so its value is irrelevant | Rejected |
| Per-call-site `signal` at each `await` | Explicit at the point of use | Three call sites today and growing; the next new call site silently reintroduces the outage | Rejected |
| Drop the proxy and call Mashov directly | Removes the failing hop entirely | Mashov returns 403 to the server's IP — the proxy is the reason the feature works at all | Rejected |

## Decision Outcome

**Chosen**: Register a request interceptor in `createMashovAxios` that attaches
`config.signal ??= AbortSignal.timeout(MASHOV_TIMEOUT_MS)` (default 10000), and route the three
bare `axios` call sites (`auth.service.getSchools`, `auth.service.login`,
`connection.service.updateConnection`) through the factory so they are covered.

**Rationale**: `AbortSignal` is the only mechanism measured to bound this failure — the agent's
own `timeout` option was tested and rejected, which is the single most important fact in this
record. Centralizing it in the factory rather than at each call site means a new Mashov call is
bounded by default; the alternative made the safety property opt-in, and the outage happened
precisely because two call sites had opted out of the shared factory. The existing axios
`timeout` stays as a second layer for the ordinary case where a socket does get assigned.
`??=` means a caller that supplies its own signal keeps control.

The frontend's `/api/v1/[...path]` proxy carries an independent `PROXY_TIMEOUT_MS` bound
(default 15000, above the backend bound and far below Cloudflare's ~100s), so the site degrades
with a real 502/504 even if a future backend dependency stalls somewhere this ADR does not cover.

**Positive Consequences**:
- A blackholed egress proxy now yields `502 UPSTREAM_ERROR` in ~10s (measured 10.03s) instead of
  a 524 after ~125s; the frontend bound yields `504 GATEWAY_TIMEOUT` in ~15s (measured 15.02s)
- Every Mashov call — including the sync tasks that already used the factory — is bounded
- `MASHOV_TIMEOUT_MS` makes the bound tunable without a code change if Mashov gets slower
- The egress hop itself is now reproducible from the repo (`ops/install-egress-proxy.sh`) and
  diagnosable in one command (`ops/check-egress.sh`). It previously existed only as
  undocumented state on one host, which is why diagnosing a dead proxy took hours rather than
  minutes: every hop had to be re-derived from live machines

An abort is not a credential failure. `isUpstreamUnreachable()` (an abort, or any axios error
with no response) is classified in the shared module, and both `auth.service.login` and
`connection.service.updateConnection` map it to `502 UPSTREAM_ERROR` instead of
`INVALID_CREDENTIALS`. Without that, bounding the stall would have converted a silent hang into
a confident lie — telling users their password was wrong during an upstream outage and sending
them round a loop of retyping a password that was correct.

**Negative Consequences / Risks**:
- The bound applies uniformly, so sync-task calls that previously had a 30s axios `timeout` now
  have a 10s wall-clock budget. No sync call has been observed near that, and the limit is
  env-tunable, but a slow Mashov day will surface here first
- Aborts reject with `ERR_CANCELED`, which the retry predicate in `mashov-http.client.ts`
  (`ECONNABORTED` / `/timeout/`) does not classify as a timeout. That is deliberate — retrying
  into a blackhole doubles the stall — but it means an abort is not retried even when the cause
  was transient slowness. The predicate carries a comment saying so, because it now reads as
  live code that cannot fire
- The frontend proxy's bound is per-path: `/api/v1/sync/*` gets a much larger budget (90s,
  `PROXY_SLOW_TIMEOUT_MS`) because `POST /sync/refresh` runs every sync task before responding.
  A bound that ignored this would 504 a slow-but-successful refresh, and since the mutation's
  query invalidation only runs `onSuccess`, the user would be left on stale data with the
  spinner stopped and no error shown. Any future synchronous long-running endpoint must be added
  to `SLOW_PATH_PREFIXES` or it inherits the 15s bound
- The guard relocation in the same change made `frontend/src/middleware.ts` live for the first
  time, which initially swallowed `/robots.txt`, `/sitemap.xml` and `/favicon.svg` into a 307 to
  the sign-in page. They are now in `PUBLIC_FILES`, with a regression test in the
  unauthenticated Playwright project — `seo.spec.ts` cannot catch this class of bug because it
  runs with a session cookie

## Links

- Related: [ADR-0018](0018-direct-mashov-credential-login.md) — the auth flow that depends on this egress path
- Related: [ADR-0020](0020-auth-controller-passthrough-response.md) — the 502 envelope the bounded failure surfaces through
- Implemented in: `backend/src/common/http/mashov-http.ts`, `backend/src/auth/auth.service.ts`,
  `backend/src/connection/connection.service.ts`, `frontend/src/app/api/v1/[...path]/route.ts`
- Egress hop provisioning and diagnosis: `ops/install-egress-proxy.sh`, `ops/check-egress.sh`
