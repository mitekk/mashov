/**
 * Flags for paths that exist in the codebase but are not yet known to work.
 *
 * Plain constants, deliberately, not environment variables. The sign-in page is
 * statically prerendered (`.next/server/app/auth/sign-in.html`), so a
 * `process.env` read is baked at `next build` whether it happens in a client
 * component via `NEXT_PUBLIC_*` inlining or in the server component above it —
 * the runtime values in `docker-compose.yml` would be ignored, silently. The
 * repo already has one knob in that state: `NEXT_PUBLIC_SYNCING_HARD_CAP_MS`
 * and `NEXT_PUBLIC_SYNCING_SKIP_DELAY_MS` are read in a client component and
 * set nowhere in compose.
 *
 * A constant says what is true — flipping this needs a rebuild — and costs
 * nothing, because each of these flips exactly once, together with the code and
 * tests that make the path real.
 *
 * ADR-0042 §8 took the same line on Cloudflare Turnstile: "dead configuration
 * invites someone to 'finish' a path that cannot work."
 */

/**
 * Passwordless sign-in by one-time code (`email` / `sms`).
 *
 * **Off because it does not work.** Every upstream contract in this surface was
 * read out of Mashov's Angular bundle rather than observed on the wire — see
 * the "Source: reverse-engineered, not captured" banner in
 * `apis/post-api-user-otp.md`, which says outright that the request field names
 * are the least certain part of it. In production, step 1
 * (`POST /api/user/otp/request`) is refused by Mashov on both channels, so a
 * parent could pick "קוד לאימייל", press send, and be told their code was
 * invalid before they had been sent one.
 *
 * The lying error message is fixed. The contract is not. Flip this to `true`
 * only once a real capture of Mashov's own login page proves the request shape,
 * and the integration test asserting that shape is green — a working sign-in,
 * not a plausible one.
 *
 * The backend routes stay live and ungated: they are metered per IP and per
 * identity, they refuse a school with no stored credential before sending
 * anything, and verifying the corrected contract needs them reachable. This
 * flag's job is only to stop parents walking into a dead end.
 */
export const PASSWORDLESS_SIGN_IN_ENABLED = false;
