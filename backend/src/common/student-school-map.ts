import { PrismaService } from '../prisma/prisma.service';
import { resolveSchoolLabels } from './school-label';
import { linksForStudents } from './student-links';
import { schoolChipsForUser } from './school-chips';

/** Which school a child belongs to, as a response field needs it. */
export interface StudentSchool {
  schoolId: string;
  semel: number;
  schoolName: string;
  shortLabel: string;
}

/**
 * studentGuid -> that child's school, for a list of children.
 *
 * Resolved through the visibility links rather than the routing stamp alone
 * (ADR-0031): a child two parents share is stamped to one of them, and the
 * other parent would otherwise get no badge at all. Any link answers
 * correctly, because a child is at one school and every connection listing
 * them is at that school -- so the stamp is preferred when it is among the
 * links purely to keep a single-school deployment's output byte-identical.
 *
 * With a `userId` the answer is restricted to that caller's own connections
 * (R5). Without it, a shared child resolved to whichever link came back first
 * and handed the caller the OTHER parent's connection UUID and their
 * parent-chosen `displayLabel` -- an id the client then cannot resolve against
 * `me.schools`, so the chip could never match it either. The caller-less path
 * is unchanged: it is the digest and the unauthenticated reads, and there is
 * no caller to intersect against.
 *
 * A few queries for a whole list rather than per item, and the labels are
 * resolved across the set so two schools in one cluster cannot present the
 * same chip (see school-label.ts). A child none of the caller's connections
 * lists is simply absent from the map, which callers read as "no badge".
 */
export async function buildStudentSchoolMap(
  prisma: PrismaService,
  students: Array<{ studentGuid: string; householdConnectionId?: string | null }>,
  userId?: string,
): Promise<Map<string, StudentSchool>> {
  const map = new Map<string, StudentSchool>();
  if (students.length === 0) return map;

  // The caller's rows may not carry the column -- several reads select only
  // what they render -- so it is fetched when missing rather than assumed.
  const owned = students.every((student) => student.householdConnectionId !== undefined)
    ? students
    : await prisma.student.findMany({
        where: { studentGuid: { in: students.map((student) => student.studentGuid) } },
        select: { studentGuid: true, householdConnectionId: true },
      });

  const linksByStudent = await linksForStudents(
    prisma,
    owned.map((student) => student.studentGuid),
  );

  // The caller's whole connection set, already labelled as a set. `null`
  // means "no caller, so nothing to intersect against" -- not an empty map,
  // which is a real caller who has connected no school and gets no badge on
  // any child.
  //
  // Two things come from it: which connections the caller may be answered
  // from, and the chip labels. The labels have to be resolved over the
  // household rather than over the schools in THIS list, because a collision
  // reverts both sides to their full names and a list holding one of two
  // colliding schools cannot see the collision at all.
  const chips = userId ? await schoolChipsForUser(prisma, userId) : null;
  const own = chips ? new Set(chips.keys()) : null;

  /**
   * The connection this child's school should be read from, for this caller.
   *
   * The caller's own links first, then the stamp among them, then the first of
   * them. A child whose links are all somebody else's gets no answer rather
   * than a foreign one.
   */
  const resolvedFor = (studentGuid: string, stamp?: string | null): string | undefined => {
    const all = linksByStudent.get(studentGuid) ?? [];
    const links = own ? all.filter((id) => own.has(id)) : all;

    if (stamp && links.includes(stamp)) return stamp;
    if (links.length > 0) return links[0];
    // Links exist, just none of the caller's: that is somebody else's child,
    // and the right answer is no badge.
    if (all.length > 0) return undefined;
    // No links recorded yet: fall back to the stamp so a database whose
    // backfill has not run keeps showing the badge it showed before -- but
    // only when the stamp is one the caller owns.
    if (!own) return stamp ?? undefined;
    return stamp && own.has(stamp) ? stamp : undefined;
  };

  const connectionIds = [
    ...new Set(
      owned
        .map((student) => resolvedFor(student.studentGuid, student.householdConnectionId))
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  if (connectionIds.length === 0) return map;

  // With a caller the chip map already holds every connection `resolvedFor`
  // could have returned -- it cannot return anything outside `own` -- so there
  // is nothing left to look up.
  const byId = chips ?? (await connectionsById(prisma, connectionIds));

  for (const student of owned) {
    const resolved = resolvedFor(student.studentGuid, student.householdConnectionId);
    const school = resolved ? byId.get(resolved) : undefined;
    if (school) map.set(student.studentGuid, school);
  }
  return map;
}

/**
 * The same shape as a chip, for the caller-less read.
 *
 * Here the labels genuinely can only be resolved over the connections in the
 * list, because there is no household to resolve them over. Unchanged
 * behaviour for the digest and the unauthenticated reads.
 */
async function connectionsById(
  prisma: PrismaService,
  connectionIds: string[],
): Promise<Map<string, StudentSchool>> {
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
        schoolName: connection.schoolName ?? String(connection.schoolCode),
        shortLabel: labels.get(connection.id) ?? String(connection.schoolCode),
      },
    ]),
  );
}
