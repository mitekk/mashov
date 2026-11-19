import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { activeConnectionIdsFor } from './student-links';

/**
 * Restricts a mail read to the caller's own mailboxes.
 *
 * Unstamped conversations are included, as everywhere else: NULL means
 * "ownership unknown", and excluding them would empty the inbox on a
 * deployment that has not re-synced since the ownership migration.
 *
 * No caller means no filter. Every mail route runs behind `AppSessionGuard`
 * and none is `@Public()`, so on real traffic there is always a caller; the
 * unscoped path is for a server-side caller with no user to speak of, and
 * today the only thing that drives it is `tests/integration/api.test.ts`,
 * whose requests are unauthenticated. Nothing in the crons or the digest
 * reaches a mail read at all -- `MailCountsTask` and `MailInboxTask` own their
 * own queries. Said plainly here because an optional `userId` whose absence
 * means "whole table" is only safe while that stays true.
 *
 * Lives in `common/` rather than on `MailService` because the dashboard and
 * the feed render mail too (R3), and a second scoping path for the same table
 * is how the first one came to be missed.
 *
 * Delegates to `activeConnectionIdsFor` rather than issuing its own query, so
 * mail's notion of "the caller's connections" is the same one the student
 * visibility edge uses and the two cannot drift.
 */
export async function householdMailScope(
  prisma: PrismaService,
  userId?: string,
): Promise<Prisma.MailConversationWhereInput> {
  // `null` is not an empty list: it means "unscoped", for a caller-less
  // server-side read. An empty array is a real caller who has connected no
  // school, and admits only the unstamped rows.
  if (!userId) return {};

  const own = await activeConnectionIdsFor(prisma, userId);
  return {
    OR: [{ householdConnectionId: { in: own } }, { householdConnectionId: null }],
  };
}
