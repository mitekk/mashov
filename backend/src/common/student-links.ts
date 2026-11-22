import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Who may see a child, as opposed to whose credentials fetch them.
 *
 * `Student.householdConnectionId` answers the second question and only the
 * second. It cannot answer the first, because the answer is a set: two parents
 * with their own Mashov accounts at one school legitimately list the same
 * children (ADR-0016's "two parents ... independently track what they have
 * read", PRD open question 2's "each user creates their own connection"), and
 * a single stamp meant whichever of them synced second took the child away
 * from the other until the next cycle flipped it back. See ADR-0031.
 *
 * Every per-child table is keyed by `studentGuid` alone, so the child's data
 * is one shared copy and this edge is the only thing that was missing.
 */

/** The connections a user may read through. */
export async function activeConnectionIdsFor(
  prisma: PrismaService,
  userId: string,
): Promise<string[]> {
  const connections = await prisma.householdConnection.findMany({
    where: { userId, active: true },
    select: { id: true },
  });
  return connections.map((connection) => connection.id);
}

/**
 * The `where` fragment restricting a student list to what one user may see.
 *
 * A child with no links is admitted, which is the rule the NULL stamp already
 * had: no links means "ownership unknown, link on the next roster refresh",
 * not "nobody's". The shared env-credential session writes children it cannot
 * attribute, so excluding them would empty the app on a deployment that has
 * not re-synced since the migration.
 */
export async function visibleStudentWhere(
  prisma: PrismaService,
  userId: string,
): Promise<Prisma.StudentWhereInput> {
  const connectionIds = await activeConnectionIdsFor(prisma, userId);

  return {
    OR: [
      { links: { some: { householdConnectionId: { in: connectionIds } } } },
      { links: { none: {} } },
    ],
  };
}

/**
 * The `where` fragment for "the children ONE connection lists".
 *
 * The `inactiveChildren` sweeps use it: `inactiveChildren` is school-local, so
 * one school must not retire a child it does not list. Unlinked children are
 * admitted for the same reason they are everywhere else -- ownership unknown
 * is not somebody else's.
 */
export function connectionStudentWhere(connectionId: string): Prisma.StudentWhereInput {
  return {
    OR: [
      { links: { some: { householdConnectionId: connectionId } } },
      { links: { none: {} } },
    ],
  };
}

/** Whether a user may see one child. The guard behind every per-child route. */
export async function canSeeStudent(
  prisma: PrismaService,
  userId: string,
  studentGuid: string,
): Promise<boolean> {
  const links = await prisma.studentConnection.findMany({
    where: { studentGuid },
    select: { householdConnectionId: true },
  });

  // Unlinked: readable by anyone, and cheap enough to answer without even
  // looking up the caller's connections.
  if (links.length === 0) return true;

  const connectionIds = new Set(await activeConnectionIdsFor(prisma, userId));
  return links.some((link) => connectionIds.has(link.householdConnectionId));
}

/**
 * Whether a user may *act* on one child — a deliberately stricter question
 * than whether they may read them.
 *
 * `canSeeStudent` admits a child with no links at all, and must: on the read
 * side "ownership unknown" means "link on the next roster refresh", and
 * excluding those children would empty the app on a deployment that has not
 * re-synced. The shared env-credential session legitimately writes children it
 * cannot attribute, so that state is normal rather than exceptional.
 *
 * On a write that starts pushing a child's behaviour record out to a messaging
 * app, the safe failure is the other way round. An unattributed child belongs
 * to nobody until a roster refresh says otherwise, so nobody gets to point them
 * at their own phone — because the cost of being wrong is not a row a parent
 * should not have seen, it is another family's children's conduct reports
 * arriving on a stranger's phone every afternoon until somebody notices.
 *
 * The cost of this strictness, stated plainly: on a deployment whose roster has
 * never been attributed, a parent sees their children in the app and cannot
 * subscribe them until the next successful roster sync writes the links. That
 * is the right way round to fail. See ADR-0033.
 */
export async function ownsStudentForDelivery(
  prisma: PrismaService,
  userId: string,
  studentGuid: string,
): Promise<boolean> {
  const links = await prisma.studentConnection.findMany({
    where: { studentGuid },
    select: { householdConnectionId: true },
  });
  if (links.length === 0) return false;

  const connectionIds = new Set(await activeConnectionIdsFor(prisma, userId));
  return links.some((link) => connectionIds.has(link.householdConnectionId));
}

/**
 * Record that a connection's login roster lists these children.
 *
 * Upsert, never replace: the update branch touches `lastSeenInRosterAt` and
 * nothing else. A link is a granted view rather than an observation to be
 * tidied away, so a roster that comes back short -- an upstream hiccup, a
 * partial payload -- must not revoke a parent's access to their own child.
 * `RosterPresenceService` retires a child who stops appearing anywhere, which
 * is the mechanism for that and does not need this one's help.
 */
export async function linkStudentsToConnection(
  prisma: PrismaService,
  connectionId: string,
  studentGuids: string[],
  seenAt: Date = new Date(),
): Promise<void> {
  for (const studentGuid of new Set(studentGuids)) {
    await prisma.studentConnection.upsert({
      where: {
        studentGuid_householdConnectionId: { studentGuid, householdConnectionId: connectionId },
      },
      create: {
        studentGuid,
        householdConnectionId: connectionId,
        firstSeenAt: seenAt,
        lastSeenInRosterAt: seenAt,
      },
      update: { lastSeenInRosterAt: seenAt },
    });
  }
}

/**
 * studentGuid -> the connections that list them, for a set of children.
 *
 * One query for a whole list. Callers that need "which of MY connections"
 * intersect the result with their own set.
 */
export async function linksForStudents(
  prisma: PrismaService,
  studentGuids: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (studentGuids.length === 0) return map;

  const links = await prisma.studentConnection.findMany({
    where: { studentGuid: { in: studentGuids } },
    select: { studentGuid: true, householdConnectionId: true },
  });

  for (const link of links) {
    const bucket = map.get(link.studentGuid);
    if (bucket) bucket.push(link.householdConnectionId);
    else map.set(link.studentGuid, [link.householdConnectionId]);
  }
  return map;
}
