import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The minimum a per-student task knows about a child. */
export interface FanoutStudent {
  studentGuid: string;
  householdConnectionId: string | null;
}

/** The minimum a per-student task knows about a connection. */
export interface FanoutConnection {
  id: string;
  schoolCode: number;
  schoolYear: number;
}

/**
 * The connections to try for a child, owner first.
 *
 * Roughly a dozen per-student tasks fan out across every active connection and
 * keep the first successful response. With one school that is one call. With
 * two it is one guaranteed 403 per student per run, per task, before the right
 * connection is reached -- ten tasks every twelve minutes against an upstream
 * that rate-limits. Trying the owner first makes a stamped child cost one call
 * instead of N.
 *
 * Ordering, never filtering: every connection stays in the list. A stamp can
 * be stale -- a child who moved school -- and dropping the others would turn a
 * recoverable wrong guess into a permanently failing student. An unstamped
 * child keeps the caller's order exactly, so behaviour on a deployment whose
 * ownership backfill has not run is unchanged.
 */
export function orderConnectionsForStudent<T extends FanoutConnection>(
  student: FanoutStudent,
  connections: T[],
): T[] {
  const ownerId = student.householdConnectionId;
  if (!ownerId || connections.length < 2) return [...connections];

  const owner = connections.find((conn) => conn.id === ownerId);
  if (!owner) return [...connections];

  return [owner, ...connections.filter((conn) => conn.id !== ownerId)];
}

/**
 * Record which connection actually answered for a child.
 *
 * Called on every success, so it writes only on a change: ten tasks per
 * student every twelve minutes would otherwise be an UPDATE storm that churns
 * `updatedAt` on every pass.
 *
 * A change from one connection to another is a child who moved school, and is
 * logged at warn because nothing else in the schema records that. Filling in a
 * missing stamp is not a move and is silent, or the first sync after the
 * ownership migration would shout once per child.
 *
 * Failure is swallowed. The stamp is an optimisation and an isolation key, not
 * the payload: losing it costs one extra upstream call next run, while
 * throwing would turn a successful fetch into a failed sync run.
 */
export async function stampOwnershipIfChanged(
  prisma: PrismaService,
  student: FanoutStudent,
  connection: FanoutConnection,
  logger: Logger,
  /**
   * Whether the response actually proves this connection knows the child.
   *
   * An empty 200 does not. At least one of the eleven per-student endpoints
   * plausibly answers `[]` rather than 403 for a guid outside the account, and
   * treating that as proof lets the WRONG school claim a child the moment the
   * right school's password goes stale: the year written becomes the claimant's
   * (hiding the child's rows), the chip names the wrong school, release writes
   * route to the wrong Mashov account, and on a shared deployment the claiming
   * household gains read access.
   *
   * Defaults true so a caller that genuinely has no payload to judge -- the
   * roster path, where the login response IS the evidence -- behaves as before.
   */
  hasEvidence = true,
): Promise<void> {
  if (!hasEvidence) return;
  if (student.householdConnectionId === connection.id) return;

  if (student.householdConnectionId) {
    logger.warn(
      `Child ${student.studentGuid} answered on connection ${connection.id} but was stamped ` +
        `${student.householdConnectionId}; re-stamping ownership (they have likely moved school)`,
    );
  }

  try {
    await prisma.student.update({
      where: { studentGuid: student.studentGuid },
      data: { householdConnectionId: connection.id },
    });
    student.householdConnectionId = connection.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not stamp ownership for ${student.studentGuid}: ${message}`);
  }
}
