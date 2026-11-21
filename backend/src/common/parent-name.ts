/**
 * The parent's own name, without the per-school child tag Mashov appends.
 *
 * `credential.displayName` is a per-school string, and for a parent it comes
 * back as `"קורס דמיטרי [מיקה ז8]"` -- their name plus ONE of that school's
 * children. Login captures it into the single global `AppUser.displayName`,
 * so whichever credential created the user decides which child is quoted, and
 * every surface that renders the name then shows that one child under every
 * school. The children themselves come from `StudentConnection`, the
 * visibility edge (ADR-0031), which knows all of them per school.
 *
 * So the bracket is dropped at the API boundary rather than at write time: the
 * stored value is the credential's own and nothing else reads it, and
 * rewriting it would make the two schools' rows disagree about what Mashov
 * said.
 *
 * Never returns an empty string where the input had one: a blank name renders
 * as a blank header, which is worse than a name with a child in it.
 */
export function parentDisplayName(raw: string | null | undefined): string {
  if (!raw) return '';

  const collapsed = raw.replace(/\s+/g, ' ').trim();

  // Trailing groups only, and all of them. A bracket mid-name is part of the
  // name as far as we can tell, and an unbalanced `[` matches nothing here --
  // both are left exactly as Mashov sent them.
  const stripped = collapsed.replace(/(?:\[[^[\]]*\]\s*)+$/, '').trim();

  return stripped || collapsed;
}
