# ADR-0020: Auth Controller — NestJS Passthrough Mode with Exception-Based Error Paths

- **Date**: 2026-03-17
- **Status**: Accepted
- **Deciders**: Backend agent, Smoke test verifier

## Context and Problem Statement

The login endpoint was decorated with `@Res({ passthrough: true })` so the handler could set an httpOnly cookie via `res.cookie()` while still returning a DTO object for NestJS to serialize. However, error branches inside the same handler called `res.status(401).json({ ... })` directly. With passthrough mode active, NestJS attempts a second write to the response after the handler returns, causing `ERR_HTTP_HEADERS_SENT` on concurrent or consecutive failed login attempts. The backend process remained alive, but the request was partially written and the crash surfaced in logs on every invalid credential submission.

## Decision Drivers

- `security.md` requires JWT to be stored in httpOnly cookies — the `@Res({ passthrough: true })` pattern is the NestJS-idiomatic way to set cookies while preserving framework serialization
- The smoke test phase (Step 5.7) detected the crash by submitting rapid invalid login attempts and observing `ERR_HTTP_HEADERS_SENT` in container logs
- Response interceptors and serialization guards must remain active; bypassing them to resolve the crash is not acceptable
- The backend must handle concurrent authentication failures without the process recycling via `restart: unless-stopped`

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Replace direct `res.json()` error writes with `throw new HttpException(...)` | Error paths delegate to NestJS exception filter; passthrough mode functions correctly; interceptors stay active | Requires auditing all error branches in the controller | **Selected** |
| Remove `passthrough: true`; write the full response (cookie + body) manually in every branch | No dual-write risk; complete control | Bypasses NestJS serialization, response interceptors, and class-transformer exclusions; duplicates response logic | Rejected |
| Add a custom exception filter to catch `ERR_HTTP_HEADERS_SENT` and suppress it | No code changes to controller | Masks the root cause; partial responses are already written when the filter fires; does not prevent the double-write | Rejected |

## Decision Outcome

**Chosen**: Replace all direct `res.status().json()` calls in error paths with `throw new UnauthorizedException(...)` and `throw new HttpException(...)`.

**Rationale**: Passthrough mode is a deliberate NestJS contract: the handler sets cookies via `res.cookie()` and returns a value; the framework owns the final response write. Violating that contract by also calling `res.json()` in error paths is the sole cause of the double-write. Throwing exceptions instead hands control back to the framework's exception filter pipeline, which owns the single authoritative response write. This preserves serialization, interceptors, and class-transformer exclusions — all of which are required for the cookie-auth flow documented in ADR-0018 and ADR-0019. Writing the response manually (Option B) would achieve the same crash fix but at the cost of re-implementing serialization logic that NestJS already provides and that other controllers depend on. Adding a suppression filter (Option C) is the worst outcome: it hides a symptom while the underlying race remains.

**Positive Consequences**:
- Login endpoint survives concurrent invalid credential submissions without crashing
- Backend process no longer requires `restart: unless-stopped` as a liveness crutch (though it remains as defense-in-depth)
- Exception filter pipeline produces consistent `{ error: { code, message } }` envelopes for auth failures, matching the API error shape defined in `api.md`

**Negative Consequences / Risks**:
- Any future controller that adopts `@Res({ passthrough: true })` must follow the same discipline — direct `res.json()` in error branches must never be introduced; this constraint is not enforced by TypeScript or ESLint and relies on code review
- The `@Res` decorator in the method signature is a leaky abstraction: it signals that the handler touches the response object, but the rule "only use it for cookies, throw for errors" is implicit

## Links

- Related: [ADR-0018](0018-direct-mashov-credential-login.md) — authentication mechanism that requires the cookie-setting handler
- Related: [ADR-0019](0019-session-strategy-db-with-redis-cache.md) — session strategy that depends on cookie delivery
- Implemented in: `backend/src/auth/auth.controller.ts`
