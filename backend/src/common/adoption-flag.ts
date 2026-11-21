/**
 * The kill switch for attaching a sign-in to an existing household.
 *
 * Default ON: the flag exists so adoption can be turned OFF in an emergency if
 * it ever proves to be the wrong call, not as an opt-in. Anything other than a
 * literal `false` (case-insensitive) leaves it enabled, and an unset or blank
 * value is enabled.
 *
 * Read from two places, which is why it lives here rather than as a private
 * method on `AuthService`: sign-in adoption (`AuthService.login`) and the
 * household merge (`SchoolLinksService.createLink`). The merge is a strictly
 * MORE invasive form of the same trust model -- it revokes the other
 * household's sessions and moves its rows -- so a switch that covered only
 * sign-in would go inert for exactly the households that had merged, since
 * `mergedIntoUserId` then routes their next sign-in regardless.
 */
export function householdAdoptionEnabled(): boolean {
  const raw = process.env.MASHOV_ENABLE_SCHOOL_LINK_ADOPTION;
  if (raw === undefined || raw.trim().length === 0) return true;
  return raw.trim().toLowerCase() !== 'false';
}
