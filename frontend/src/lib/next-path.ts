import { isPhase1Route } from './phase1-routes';

/**
 * Sanitise a `?next=` value before handing it to the router.
 *
 * An allowlist, not a denylist: `middleware.ts` only ever puts a parent-facing
 * route in `next`, and that set is exactly what `isPhase1Route` describes --
 * so anything else is either an attack (`https://evil.com`, `//evil.com`,
 * `javascript:alert(1)`) or a route the parent has no business being bounced
 * to (`/admin/feedback`), and both answer with the app's own entry point.
 *
 * `/` is safe to return: `app/page.tsx` redirects it to `/home`.
 */
export function safeNextPath(raw: string | null | undefined): string {
  return isPhase1Route(raw) ? raw! : '/';
}
