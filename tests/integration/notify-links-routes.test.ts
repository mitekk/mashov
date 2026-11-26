import {
  behaviorItemUrl,
  boardNoticesUrl,
  childSectionUrl,
  childUrl,
  homeworkItemUrl,
  inboxConversationUrl,
} from '../../backend/src/telegram/notify-links';
import { PHASE1_ROUTE_PATTERNS, isPhase1Route } from '../../frontend/src/lib/phase1-routes';

/**
 * The drift guard between the two copies of the route builders.
 *
 * `backend/src/telegram/notify-links.ts` has to mirror
 * `frontend/src/lib/child-routes.ts` because the backend cannot import from
 * `frontend/` -- and the backend's own spec cannot close that gap either, since
 * the unit container is built from `./backend` alone and has no `frontend/` in
 * the image. The integration container mounts the whole repo at `/work`, so
 * this is the ONLY place both trees are available at once.
 *
 * Needs no database: it is a pure assertion about strings, and it lives here
 * for the mount, not for the data.
 *
 * What it buys: change a route in the frontend router and narrow
 * `PHASE1_ROUTE_PATTERNS` to match, and this goes red instead of a parent
 * silently landing on the home page after a sign-in bounce. See ADR-0047.
 */
const BASE = 'https://mashov.example';
const GUID = 'stu-abc-123';

describe('Telegram deep links against the frontend routes', () => {
  const built = {
    'behaviour item': behaviorItemUrl(BASE, GUID, 'beh-7'),
    'homework item': homeworkItemUrl(BASE, GUID, 'hw-3'),
    'board notices': boardNoticesUrl(BASE, GUID),
    'behaviour section': childSectionUrl(BASE, GUID, 'behavior', 'attention'),
    'praise section': childSectionUrl(BASE, GUID, 'behavior', 'positive'),
    'homework section': childSectionUrl(BASE, GUID, 'homework'),
    'child page': childUrl(BASE, GUID),
    'mail conversation': inboxConversationUrl(BASE, 'conv-9'),
  };

  it.each(Object.entries(built))('%s survives a sign-in bounce', (_name, url) => {
    expect(url).not.toBeNull();
    const path = url!.slice(BASE.length);
    // The frontend's own patterns, imported -- not a copy of them.
    expect(isPhase1Route(path)).toBe(true);
  });

  it('reads the frontend patterns rather than redeclaring them', () => {
    // If this import ever stops resolving, the assertions above silently stop
    // guarding anything, so the guard asserts it has the real thing.
    expect(Array.isArray(PHASE1_ROUTE_PATTERNS)).toBe(true);
    expect(PHASE1_ROUTE_PATTERNS.length).toBeGreaterThan(0);
    expect(PHASE1_ROUTE_PATTERNS.every((pattern) => pattern instanceof RegExp)).toBe(true);
  });
});
