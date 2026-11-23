import { Prisma } from '@prisma/client';

/**
 * True when a Prisma failure is specifically a username-uniqueness collision.
 *
 * `HouseholdConnection` is uniquely keyed on `[schoolCode, username]`, so two
 * paths can hit it: linking an account already linked, and CHANGING a username
 * to one that school already has -- the other parent's account, or an orphan row
 * an earlier unlink left behind.
 *
 * Narrowed to that one constraint on purpose. The writes that can raise this
 * also set `encryptedPassword`, `lastLoginAt` and `mashovUniqueId`, and a
 * blanket `P2002 -> 409 username taken` would one day label an unrelated
 * constraint as a username problem and send the parent to fix the wrong thing.
 *
 * Extracted from `ConnectionService`, which had the only copy, when the
 * credential-change path turned out to need the same reading -- a raw P2002
 * reaching the exception filter is a 500, which tells the parent nothing at all.
 */
export function isTakenUsernameConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return target.some((field) => String(field).toLowerCase().includes('username'));
  }
  if (typeof target === 'string') {
    return target.toLowerCase().includes('username');
  }
  return false;
}
