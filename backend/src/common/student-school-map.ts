import { PrismaService } from '../prisma/prisma.service';
import { resolveSchoolLabels } from './school-label';

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
 * Two queries for a whole list rather than one per item, and the labels are
 * resolved across the set so two schools in one cluster cannot present the
 * same chip (see school-label.ts). A child with no ownership stamp is simply
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

  const connectionIds = [
    ...new Set(
      owned
        .map((student) => student.householdConnectionId)
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
    const school = student.householdConnectionId
      ? byId.get(student.householdConnectionId)
      : undefined;
    if (school) map.set(student.studentGuid, school);
  }
  return map;
}
