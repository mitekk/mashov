import { PrismaService } from '../prisma/prisma.service';
import { resolveSchoolLabels } from './school-label';
import { activeConnectionIdsFor } from './student-links';

/** One school, as a chip and a per-child school field need it. */
export interface SchoolChip {
  schoolId: string;
  semel: number;
  schoolName: string;
  shortLabel: string;
}

/**
 * connectionId -> that school's chip, for the caller's WHOLE connection set.
 *
 * The set is the point. `resolveSchoolLabels` is a whole-list decision: two
 * schools in one cluster routinely share everything up to a " - …" qualifier,
 * and a collision reverts both sides to their full names, which only a view of
 * every school can decide. Resolving over the schools that happen to appear in
 * one response instead gave the same school a short colliding label on a page
 * listing one of them and its expanded full name on a page listing both --
 * three readers disagreeing about one chip.
 *
 * So the label is resolved here, once, over the household, and every reader
 * takes it from this map rather than labelling its own page.
 *
 * Requires a caller on purpose. "The caller's whole connection set" has no
 * meaning without one, and the readers that also serve a caller-less,
 * deliberately global path keep that path explicitly rather than having it
 * fall out of an absent argument.
 *
 * Delegates the "which connections" half to `activeConnectionIdsFor`, so this
 * is not a second definition of the household that could drift from the
 * student visibility edge.
 */
export async function schoolChipsForUser(
  prisma: PrismaService,
  userId: string,
): Promise<Map<string, SchoolChip>> {
  const connectionIds = await activeConnectionIdsFor(prisma, userId);
  if (connectionIds.length === 0) return new Map();

  const connections = await prisma.householdConnection.findMany({
    where: { id: { in: connectionIds } },
    select: { id: true, schoolCode: true, schoolName: true, displayLabel: true },
  });
  const labels = resolveSchoolLabels(connections);

  return new Map(
    connections.map((connection) => [
      connection.id,
      {
        schoolId: connection.id,
        semel: connection.schoolCode,
        // A blank chip is unpressable, so the semel stands in -- a connection
        // created before the login response carried schoolSettings has no name.
        schoolName: connection.schoolName ?? String(connection.schoolCode),
        shortLabel: labels.get(connection.id) ?? String(connection.schoolCode),
      },
    ]),
  );
}
