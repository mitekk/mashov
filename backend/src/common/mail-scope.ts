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

/**
 * The unread badge: ONE rule for which conversations a number counts (R15).
 *
 * **Each `cachedNewCount` stays its own connection's mailbox, and the reader
 * adds the unattributed rows once, live.**
 *
 * The badge used to be a pure sum of `cachedNewCount`, each of which counts
 * `householdConnectionId: conn.id` only, while `householdMailScope` admits
 * `householdConnectionId: null`. A NULL-stamped unread conversation was
 * therefore listed by the inbox and counted by nothing — and permanently, for
 * a row upstream has stopped returning: a stamp is only written in an upsert's
 * `update` branch, which such a row never reaches again, and the sweep is
 * scoped per connection so it cannot clear `isUnread` either. A badge
 * disagreeing with the list beside it is the class of bug `283c053` was about,
 * with the opposite sign.
 *
 * The rejected alternative was to have the writers count "their own stamps
 * plus NULL". That double-counts every NULL row on a household with two
 * connections, because the badge sums those rows — the exact inflation
 * ADR-0030 and `283c053` set out to remove. Counting them once, here, cannot
 * inflate however many connections a household has.
 *
 * Lives beside `householdMailScope` because the identical six lines existed in
 * `MailService.getSummary` and `DashboardService.getSummary`, and two copies
 * of one rule is how this asymmetry survived batch 1 in the first place.
 */
export async function unreadBadge(
  prisma: PrismaService,
  userId: string | undefined,
  mailScope: Prisma.MailConversationWhereInput,
): Promise<number> {
  const unread: Prisma.MailConversationWhereInput = {
    isUnread: true,
    NOT: { labels: { array_contains: ['archived'] } },
  };

  const [household, unattributed, local] = await Promise.all([
    // The caller's own mailboxes, each already counted by its own writer.
    prisma.householdConnection.aggregate({
      where: { active: true, ...(userId ? { userId } : {}) },
      _sum: { cachedNewCount: true },
      _count: { _all: true },
    }),
    // The rows no connection owns. Not scoped by caller, because NULL means
    // "ownership unknown" and the read scope shows them to everyone on
    // exactly those terms — the badge has to answer the same question the
    // list does, or it is back to disagreeing with it.
    prisma.mailConversation.count({ where: { householdConnectionId: null, ...unread } }),
    // The fallback, for a caller between unlinking and re-linking: no
    // connection rows to sum, so the live count over their own scope. It
    // already includes the unattributed rows, which is why it is not added to.
    prisma.mailConversation.count({ where: { ...mailScope, ...unread } }),
  ]);

  // `_count` separates "no connections, so fall back to the live count" from
  // "connections whose counts genuinely sum to zero": `_sum` is null in both
  // cases, and without the distinction an emptied inbox would fall back to a
  // count that need not be zero — a badge that will not clear.
  return household._count._all > 0
    ? (household._sum.cachedNewCount ?? 0) + unattributed
    : local;
}
