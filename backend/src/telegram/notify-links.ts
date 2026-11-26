/**
 * Deep links from a Telegram message into the app.
 *
 * ## Why these carry a studentGuid
 *
 * They used not to. The digest's only link was `${publicBaseUrl}/home`, and
 * the reasoning was that a Telegram chat is a shared, forwardable artifact, so
 * a studentGuid in someone else's hands outlives the message it arrived in.
 *
 * That reasoning was already only half-held: the inbox notifier has always
 * linked to `/inbox/<conversationId>`. And it bought very little. The chat is
 * one the parent proved they control (ADR-0033's link wizard), the guid is
 * useless without a session that owns the child, and the cost was paid on
 * every message: a parent told their child had an unexcused absence landed on
 * the home page and had to find the child and the note themselves. See
 * ADR-0047.
 *
 * ## Why this file duplicates `frontend/src/lib/child-routes.ts`
 *
 * Because it has to. The backend cannot import from `frontend/`, and these
 * paths must match the ones the app actually routes -- so the shapes and the
 * guid/id normalisation are mirrored deliberately rather than approximated.
 * `PHASE1_ROUTE_PATTERNS` (`frontend/src/lib/phase1-routes.ts`) already admits
 * `/children/**` and `/inbox/<id>`, so a parent who follows one of these while
 * signed out lands on the item after the sign-in bounce rather than on the
 * home page. Changing a route over there means changing it here; the spec
 * asserts the paths against those patterns so the two cannot drift silently.
 *
 * Every builder returns `null` rather than a broken URL. An unset
 * `PUBLIC_BASE_URL` resolves to null, and a base of `undefined` would put the
 * literal "undefined/children/..." in a parent's chat.
 */

/**
 * One path segment, or null.
 *
 * A value carrying a `/` is refused rather than encoded, exactly as
 * `normalizeStudentGuid` and `normalizeItemId` refuse it in the frontend: a
 * slash would walk the path to a different route, and a segment that needs one
 * is not an id this project issued.
 */
function segment(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('/')) return null;
  return encodeURIComponent(trimmed);
}

/** Already validated and trailing-slash-free, or null. See `resolvePublicBaseUrl`. */
function origin(baseUrl: string | null | undefined): string | null {
  if (typeof baseUrl !== 'string') return null;
  const trimmed = baseUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The child's page. Where an early release points: it lives in a dialog with no URL. */
export function childUrl(
  baseUrl: string | null | undefined,
  studentGuid: string | null | undefined,
): string | null {
  const base = origin(baseUrl);
  const guid = segment(studentGuid);
  if (!base || !guid) return null;
  return `${base}/children/${guid}`;
}

/** The sections the child page routes, mirroring `CHILD_SECTIONS`. */
export type ChildSection = 'homework' | 'behavior' | 'subjects' | 'grades' | 'notices' | 'timetable';

/** The behaviour list's filter, mirroring `CHILD_BEHAVIOR_FILTERS`. */
export type ChildBehaviorFilter = 'all' | 'attention' | 'positive' | 'neutral';

/**
 * One section of the child's page -- what a section HEADER links to.
 *
 * Both query params are always set, in this order, because that is what
 * `buildChildSectionHref` produces and what the page reads back. The behaviour
 * filter matters for more than tidiness: a praise heading that opened the
 * attention list would contradict the heading the parent just read.
 */
export function childSectionUrl(
  baseUrl: string | null | undefined,
  studentGuid: string | null | undefined,
  section: ChildSection,
  behavior: ChildBehaviorFilter = 'all',
): string | null {
  const child = childUrl(baseUrl, studentGuid);
  return child === null ? null : `${child}?section=${section}&behavior=${behavior}`;
}

/**
 * The notices section. Board notices have no detail route, so a notice's own
 * line links here too -- as close as the message can get.
 */
export function boardNoticesUrl(
  baseUrl: string | null | undefined,
  studentGuid: string | null | undefined,
): string | null {
  return childSectionUrl(baseUrl, studentGuid, 'notices');
}

/** The behaviour note itself. The route and `getBehaviorDetail` both key the DB id. */
export function behaviorItemUrl(
  baseUrl: string | null | undefined,
  studentGuid: string | null | undefined,
  behaviorId: string | null | undefined,
): string | null {
  const child = childUrl(baseUrl, studentGuid);
  const id = segment(behaviorId);
  if (child === null || !id) return null;
  return `${child}/behavior/${id}`;
}

/** The assignment itself. `children.service` looks it up by `where: { id }`. */
export function homeworkItemUrl(
  baseUrl: string | null | undefined,
  studentGuid: string | null | undefined,
  homeworkId: string | null | undefined,
): string | null {
  const child = childUrl(baseUrl, studentGuid);
  const id = segment(homeworkId);
  if (child === null || !id) return null;
  return `${child}/homework/${id}`;
}

/** The mail thread. Unchanged -- the notifier has always linked here. */
export function inboxConversationUrl(
  baseUrl: string | null | undefined,
  conversationId: string | null | undefined,
): string | null {
  const base = origin(baseUrl);
  const id = segment(conversationId);
  if (!base || !id) return null;
  return `${base}/inbox/${id}`;
}

/**
 * A consent form has deliberately no builder.
 *
 * There is no web surface for one at all -- no route, no dialog, no section --
 * so any link would take the parent somewhere that cannot answer the form.
 * The consent section stays link-free, and stays template-owned (ADR-0035).
 */
