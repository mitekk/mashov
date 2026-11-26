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
 *
 * The coupling to `isPhase1Route` is deliberate but not self-maintaining: a
 * parent-facing route added OUTSIDE `/home`, `/children`, `/inbox` and `/more`
 * would be put in `next` by middleware and silently collapsed to `/` here, so
 * a deep link to it would land on the wrong page with no test failing. Adding
 * such a route means adding it to `PHASE1_ROUTE_PATTERNS` as well.
 */
export function safeNextPath(raw: string | null | undefined): string {
  return isPhase1Route(raw) ? raw! : '/';
}
