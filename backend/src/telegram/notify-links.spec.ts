import {
  behaviorItemUrl,
  boardNoticesUrl,
  childSectionUrl,
  childUrl,
  homeworkItemUrl,
  inboxConversationUrl,
} from './notify-links';

const BASE = 'https://app.example.test';
const GUID = '1234567890abcdef';

describe('notify-links', () => {
  it('links a behaviour item to its own detail route', () => {
    // Both the route and getBehaviorDetail key on the DB id, so this is the
    // page the parent lands on -- not the home page they then have to search.
    expect(behaviorItemUrl(BASE, GUID, 'beh-7')).toBe(
      `${BASE}/children/${GUID}/behavior/beh-7`,
    );
  });

  it('links a homework item to its own detail route', () => {
    expect(homeworkItemUrl(BASE, GUID, 'hw-3')).toBe(
      `${BASE}/children/${GUID}/homework/hw-3`,
    );
  });

  it('links a board notice to the notices section, since no detail route exists', () => {
    expect(boardNoticesUrl(BASE, GUID)).toBe(
      `${BASE}/children/${GUID}?section=notices&behavior=all`,
    );
  });

  it('links an early release to the child, because it lives in a dialog with no URL', () => {
    expect(childUrl(BASE, GUID)).toBe(`${BASE}/children/${GUID}`);
  });

  it('links a section header to that section of the child page', () => {
    // Each section header anchors its own link, so the message carries no bare
    // URL and the parent taps the heading they are reading.
    expect(childSectionUrl(BASE, GUID, 'homework')).toBe(
      `${BASE}/children/${GUID}?section=homework&behavior=all`,
    );
  });

  it('carries the behaviour filter so the heading matches what opens', () => {
    // A praise heading that opened the attention list would contradict itself.
    expect(childSectionUrl(BASE, GUID, 'behavior', 'positive')).toBe(
      `${BASE}/children/${GUID}?section=behavior&behavior=positive`,
    );
    expect(childSectionUrl(BASE, GUID, 'behavior', 'attention')).toBe(
      `${BASE}/children/${GUID}?section=behavior&behavior=attention`,
    );
  });

  it('falls back to the all filter the frontend defaults to', () => {
    expect(childSectionUrl(BASE, GUID, 'notices')).toBe(boardNoticesUrl(BASE, GUID));
  });

  it('links mail to its conversation', () => {
    expect(inboxConversationUrl(BASE, 'conv-9')).toBe(`${BASE}/inbox/conv-9`);
  });

  describe('when there is nothing safe to link to', () => {
    it.each([null, undefined, ''])('renders no link for a base of %p', (base) => {
      // resolvePublicBaseUrl already returns null for an unset PUBLIC_BASE_URL;
      // a base of undefined would put "undefined/children/..." in a chat.
      expect(behaviorItemUrl(base, GUID, 'beh-7')).toBeNull();
      expect(homeworkItemUrl(base, GUID, 'hw-3')).toBeNull();
      expect(boardNoticesUrl(base, GUID)).toBeNull();
      expect(childUrl(base, GUID)).toBeNull();
      expect(childSectionUrl(base, GUID, 'homework')).toBeNull();
      expect(inboxConversationUrl(base, 'conv-9')).toBeNull();
    });

    it.each([null, undefined, '', '   ', 'a/b'])('renders no link for a guid of %p', (guid) => {
      // A guid carrying a slash would walk the path to another route. The
      // frontend builders refuse it the same way, which is the point of
      // mirroring them.
      expect(behaviorItemUrl(BASE, guid, 'beh-7')).toBeNull();
      expect(homeworkItemUrl(BASE, guid, 'hw-3')).toBeNull();
      expect(boardNoticesUrl(BASE, guid)).toBeNull();
      expect(childUrl(BASE, guid)).toBeNull();
      expect(childSectionUrl(BASE, guid, 'homework')).toBeNull();
    });

    it.each([null, undefined, '', '   ', 'a/b'])('renders no link for an item id of %p', (id) => {
      expect(behaviorItemUrl(BASE, GUID, id)).toBeNull();
      expect(homeworkItemUrl(BASE, GUID, id)).toBeNull();
      expect(inboxConversationUrl(BASE, id)).toBeNull();
    });
  });

  it('percent-encodes a guid or an id that carries a URL-significant character', () => {
    expect(homeworkItemUrl(BASE, 'g u id', 'hw #3')).toBe(
      `${BASE}/children/g%20u%20id/homework/hw%20%233`,
    );
  });

  it('trims whitespace the way the frontend builders do', () => {
    expect(behaviorItemUrl(BASE, `  ${GUID}  `, ' beh-7 ')).toBe(
      `${BASE}/children/${GUID}/behavior/beh-7`,
    );
  });

  it('produces paths the sign-in bounce will restore', () => {
    // PHASE1_ROUTE_PATTERNS admits /children/** and /inbox/<id>, so a parent
    // who follows a link while signed out lands on the item after signing in
    // rather than on the home page.
    const paths = [
      behaviorItemUrl(BASE, GUID, 'beh-7'),
      homeworkItemUrl(BASE, GUID, 'hw-3'),
      boardNoticesUrl(BASE, GUID),
      childSectionUrl(BASE, GUID, 'behavior', 'attention'),
      childUrl(BASE, GUID),
      inboxConversationUrl(BASE, 'conv-9'),
    ].map((url) => url!.slice(BASE.length));

    const childrenPattern = /^\/children(?:\/[^/?#]+(?:\/[^/?#]+)*)?(?:[/?#].*)?$/;
    const inboxPattern = /^\/inbox(?:\/[^/?#]+)?(?:[/?#].*)?$/;
    for (const path of paths) {
      expect(childrenPattern.test(path) || inboxPattern.test(path)).toBe(true);
    }
  });
});
