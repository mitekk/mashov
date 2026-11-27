import {
  behaviorItemUrl,
  boardNoticesUrl,
  gradesSectionUrl,
  childSectionUrl,
  childUrl,
  homeworkItemUrl,
  inboxConversationUrl,
} from '../../backend/src/telegram/notify-links';
import { PHASE1_ROUTE_PATTERNS, isPhase1Route } from '../../frontend/src/lib/phase1-routes';
import {
  buildBehaviorDetailHref,
  buildChildSectionHref,
  buildHomeworkDetailHref,
} from '../../frontend/src/lib/child-routes';

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
 * Two assertions, and the second is the one that does the work. Surviving
 * `PHASE1_ROUTE_PATTERNS` only proves a path is admitted through the sign-in
 * bounce, and that pattern takes `/children/<anything>/<anything>` at any
 * depth -- so renaming the frontend's `/homework/` segment to `/assignments/`
 * would leave it green while every homework link in every message 404s. The
 * paths are therefore also compared for EQUALITY against the frontend's own
 * builders, which is what makes this a drift guard rather than a smoke test.
 * See ADR-0047.
 */
const BASE = 'https://mashov.example';
const GUID = 'stu-abc-123';

describe('Telegram deep links against the frontend routes', () => {
  const built = {
    'behaviour item': behaviorItemUrl(BASE, GUID, 'beh-7'),
    'homework item': homeworkItemUrl(BASE, GUID, 'hw-3'),
    'board notices': boardNoticesUrl(BASE, GUID),
    'grades section': gradesSectionUrl(BASE, GUID),
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

  // Built by the frontend's own functions, so a renamed segment, a reordered
  // query string or a changed default filter shows up here as a diff.
  const mirrored: [string, string | null, string | null][] = [
    ['behaviour item', behaviorItemUrl(BASE, GUID, 'beh-7'), buildBehaviorDetailHref(GUID, 'beh-7')],
    ['homework item', homeworkItemUrl(BASE, GUID, 'hw-3'), buildHomeworkDetailHref(GUID, 'hw-3')],
    ['board notices', boardNoticesUrl(BASE, GUID), buildChildSectionHref(GUID, 'notices')],
    ['grades section', gradesSectionUrl(BASE, GUID), buildChildSectionHref(GUID, 'grades')],
    [
      'behaviour section',
      childSectionUrl(BASE, GUID, 'behavior', 'attention'),
      buildChildSectionHref(GUID, 'behavior', { behavior: 'attention' }),
    ],
    [
      'praise section',
      childSectionUrl(BASE, GUID, 'behavior', 'positive'),
      buildChildSectionHref(GUID, 'behavior', { behavior: 'positive' }),
    ],
    ['homework section', childSectionUrl(BASE, GUID, 'homework'), buildChildSectionHref(GUID, 'homework')],
  ];

  it.each(mirrored)('%s is the path the frontend itself builds', (_name, built, expected) => {
    expect(expected).not.toBeNull();
    expect(built).toBe(`${BASE}${expected}`);
  });

  it('reads the frontend patterns rather than redeclaring them', () => {
    // If this import ever stops resolving, the assertions above silently stop
    // guarding anything, so the guard asserts it has the real thing.
    expect(Array.isArray(PHASE1_ROUTE_PATTERNS)).toBe(true);
    expect(PHASE1_ROUTE_PATTERNS.length).toBeGreaterThan(0);
    expect(PHASE1_ROUTE_PATTERNS.every((pattern) => pattern instanceof RegExp)).toBe(true);
  });
});
