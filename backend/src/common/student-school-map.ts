import { PrismaService } from '../prisma/prisma.service';
import { resolveSchoolLabels } from './school-label';
import { linksForStudents } from './student-links';

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
 * A few queries for a whole list rather than per item, and the labels are
 * resolved across the set so two schools in one cluster cannot present the
 * same chip (see school-label.ts). A child no connection lists is simply
 * absent from the map, which callers read as "no badge".
 */
export async function buildStudentSchoolMap(
  prisma: PrismaService,
  students: Array<{ studentGuid: string; householdConnectionId?: string | null }>,
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

  /** The stamp when it still names a connection that lists the child. */
  const resolvedFor = (studentGuid: string, stamp?: string | null): string | undefined => {
    const links = linksByStudent.get(studentGuid) ?? [];
    if (stamp && links.includes(stamp)) return stamp;
    if (links.length > 0) return links[0];
    // No links recorded yet: fall back to the stamp so a database whose
    // backfill has not run keeps showing the badge it showed before.
    return stamp ?? undefined;
  };

  const connectionIds = [
    ...new Set(
      owned
        .map((student) => resolvedFor(student.studentGuid, student.householdConnectionId))
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  if (connectionIds.length === 0) return map;

  const connections = await prisma.householdConnection.findMany({
    where: { id: { in: connectionIds } },
    select: { id: true, schoolCode: true, schoolName: true, displayLabel: true },
  });
  const labels = resolveSchoolLabels(connections);
  const byId = new Map(
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

  for (const student of owned) {
    const resolved = resolvedFor(student.studentGuid, student.householdConnectionId);
    const school = resolved ? byId.get(resolved) : undefined;
    if (school) map.set(student.studentGuid, school);
  }
  return map;
}
