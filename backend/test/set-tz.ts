/**
 * Pin the test-run timezone to match production.
 *
 * The suite asserts behaviour that depends on how naive Mashov timestamps parse
 * (`src/mail/unread.spec.ts`, `src/common/process-zone.spec.ts`), and production runs
 * UTC (`backend/Dockerfile`, `src/common/process-zone.ts`). Without this, Jest inherits
 * the dev machine's zone and those tests prove nothing about production. Unlike
 * `TZ=UTC jest` in the npm script, a bare `npx jest` cannot bypass it.
 *
 * This must be `globalSetup`, not `setupFiles`: Node invalidates its zone cache when
 * `process.env.TZ` is assigned, but a `setupFiles` module runs *inside* the vm realm
 * Jest already built for the test file, whose `Date` keeps the zone the process started
 * with -- measured, the offset stays put. `globalSetup` runs in the parent before any
 * realm or worker exists, so both workers and `--runInBand` pick the zone up.
 */
export default function globalSetup(): void {
  process.env.TZ = 'UTC';
}
