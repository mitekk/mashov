/** A connection, as far as labelling is concerned. */
export interface LabelledConnection {
  id: string;
  schoolName: string | null;
  displayLabel: string | null;
  schoolCode?: number;
}

/** What a chip row can carry on a 360px phone without wrapping. */
const MAX_LABEL_LENGTH = 12;

/**
 * Short, distinct labels for a household's schools.
 *
 * Resolved as a set, not one name at a time. Two schools in the same cluster
 * routinely share everything up to a " - …" qualifier, and two chips reading
 * the same thing are worse than two long ones: the parent cannot tell which
 * filter they pressed. So a collision reverts BOTH sides to their full names,
 * which only a whole-list view can decide.
 *
 * Pure, and server-side only. Deriving it in the client would put this rule in
 * two languages and let them disagree about which school a chip names.
 */
export function resolveSchoolLabels(
  connections: LabelledConnection[],
): Map<string, string> {
  const full = new Map<string, string>();
  const short = new Map<string, string>();

  for (const connection of connections) {
    // schoolName is nullable -- a connection created before the login response
    // carried schoolSettings has none -- and a blank chip is unpressable, so
    // the semel stands in.
    const fullName =
      connection.schoolName?.trim() ||
      (connection.schoolCode !== undefined ? String(connection.schoolCode) : connection.id);

    full.set(connection.id, fullName);
    short.set(
      connection.id,
      connection.displayLabel?.trim() || shorten(fullName),
    );
  }

  // Any label claimed by more than one connection is useless to both.
  const counts = new Map<string, number>();
  for (const label of short.values()) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const resolved = new Map<string, string>();
  for (const [id, label] of short) {
    resolved.set(id, (counts.get(label) ?? 0) > 1 ? (full.get(id) as string) : label);
  }
  return resolved;
}

/**
 * One name, shortened: drop a trailing qualifier, then trim to whole words.
 *
 * Trimming on a word boundary matters more than hitting the length exactly --
 * a label cut mid-word reads as a typo, and a parent cannot tell a truncated
 * school name from a wrong one.
 */
function shorten(name: string): string {
  const withoutQualifier = name.split(' - ')[0].trim() || name;
  if (withoutQualifier.length <= MAX_LABEL_LENGTH) return withoutQualifier;

  const words = withoutQualifier.split(/\s+/);
  let label = '';
  for (const word of words) {
    const candidate = label ? `${label} ${word}` : word;
    if (candidate.length > MAX_LABEL_LENGTH) break;
    label = candidate;
  }

  // A single word longer than the limit has no boundary to cut on. An ellipsis
  // is honest about the truncation; a hard slice is not.
  if (!label) return `${withoutQualifier.slice(0, MAX_LABEL_LENGTH - 1)}…`;
  return label;
}
