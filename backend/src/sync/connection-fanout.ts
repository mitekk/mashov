import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { connectionStudentWhere, linkStudentsToConnection } from '../common/student-links';
import type { SyncRunService } from './sync-run.service';
import type { SyncExecutionContext, SyncTaskRunResult } from './sync.types';

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
 * What one task's per-student loop iterates: the refreshing connection's children.
 *
 * Every per-student task used to read `{ isActive: true }` -- the whole table,
 * not the connection being refreshed. So `POST /sync/refresh?schoolId=A` asked
 * A's Mashov account about school B's children, collected a 403 for each
 * across seven per-student endpoints, and reported `partial` for a school that
 * had synced perfectly. `/auth/syncing` shows the parent that, and each
 * foreign child left a failed `sync_run` that `FreshnessService` reads as
 * source ill-health.
 *
 * Scoped by the ADR-0031 visibility edge rather than by `householdConnectionId`,
 * which is the rule the `inactiveChildren` sweeps already use: it admits a
 * child no connection lists, because no links means "ownership unknown, link on
 * the next roster refresh" and not "nobody's". That edge is deliberate and must
 * stay -- excluding unlinked children would stop fetching for every child on a
 * deployment whose ownership backfill has not run.
 *
 * The global `@Cron` path passes no `connectionId` and so keeps every active
 * child, unchanged.
 */
export function studentScopeForContext(context: SyncExecutionContext): Prisma.StudentWhereInput {
  return {
    isActive: true,
    // Nested under `AND`, not spread as a bare `OR`. Prisma treats the two
    // identically, but a bare `OR` is a footgun for the next caller: writing
    // `where: { ...studentScopeForContext(ctx), OR: [...] }` silently drops one
    // of the two, and the loss widens the scope back to the whole table in one
    // direction and narrows it in the other -- neither of which would fail a
    // typecheck or a test.
    ...(context.connectionId ? { AND: [connectionStudentWhere(context.connectionId)] } : {}),
  };
}

/**
 * A connection-scoped run with no usable target: reported, never silently green.
 *
 * In the tasks whose loop IS the connection loop, `useSharedSession` is
 * `!context.connectionId && connections.length === 0`, so it is `false` once a
 * connection is named -- but the target list is then `[]` if that connection is
 * inactive or has `userId: null`. The loop body never ran: no `syncRun`,
 * nothing fetched, `status: 'success'` with every count zero. A targeted
 * refresh of a just-deactivated connection reported a clean sync and left no
 * trace anywhere, which is a silent success that makes a real failure
 * undiagnosable. The pre-branch code fell through to the shared env session and
 * opened a run either way.
 *
 * Reported as a `sync_run` closed `failed` rather than as a new `skipped`
 * status: `skipped` would have to be threaded through `SyncTaskStatus`,
 * `ManualSyncTaskResult`, `RefreshTaskProgress` and the frontend's mirror
 * types, and would put a fourth value into `sync_run.status`, which every
 * reader -- `getAllSourceHealth`, `getLatestSuccessfulRuns`, the retention rule
 * -- partitions as success/not-success. `failed` needs no type surgery, and for
 * a connection that cannot be used "this source is unhealthy for this
 * connection" is true. The parent then sees `partial` rather than a clean sync.
 */
export async function reportNoConnectionTarget(
  syncRunService: SyncRunService,
  logger: Logger,
  source: string,
  connectionId: string,
): Promise<SyncTaskRunResult> {
  const message =
    `${source}: connection ${connectionId} is not an active, user-owned connection; ` +
    `nothing was fetched`;

  // Suffixed per connection, which is the shape the loop body would have
  // written for a usable one. The bare key is what
  // `FreshnessService.getAllSourceHealth` reads as
  // `latestRun = allRuns.get(source)`, while `latestSuccess` resolves across
  // `source` AND `source:*` -- so a bare failed row left the settings page
  // showing the source `fresh` with a `lastAttemptAt` and `lastErrorMessage`
  // belonging to a connection that cannot be used. That is the one surface R11
  // exists to make readable, so it must not be the one it muddies. The run
  // stays queryable either way; what it must not do is stand in for the
  // source's own health.
  const syncRun = await syncRunService.openRun(`${source}:${connectionId}`, connectionId);
  await syncRunService.closeRun(syncRun.id, 'failed', { errorMessage: message });
  logger.warn(message);

  return {
    status: 'failed',
    summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 1 },
    errorMessages: [message],
  };
}

/**
 * No connections exist at all: nothing to attempt, and nothing to report.
 *
 * The sibling of `reportNoConnectionTarget`, for the opposite case. That one
 * fires when a *requester named a connection* -- a targeted refresh -- where
 * silence would be a user-visible lie, so it writes a `failed` run under
 * `${source}:${connectionId}`. This one fires only when the caller named no
 * connection and `household_connection` has no active, user-owned row: the
 * empty-deployment state. There is no requester, no student any connection can
 * claim, and nothing was skipped -- there is nothing.
 *
 * Deliberately opens NO `syncRun`, which is the whole point. A row here could
 * only be keyed on the bare `source`, and `getAllSourceHealth`'s own comment
 * records what that caused last time (T13 finding 3): the branch-wide NULL
 * rule admits a connectionless run into *every* connection's snapshot, so a
 * bare `failed` row put "Missing required Mashov credentials..." underneath a
 * green row for every household on a shared deployment. The reader was fixed
 * to pull status and attempt from the same variant-key set, but the row would
 * still be a failure attributed to nobody, shown to everybody. `success` with
 * zero counts is the honest shape: on an empty deployment every source then
 * reads `never_synced`, which is exactly what it is.
 *
 * Logged at `warn`, not `debug`: once the per-task crons are gone this is
 * close to unreachable -- the scheduler only selects active connections and a
 * login always has one -- so reaching it means something upstream of here
 * picked a target it should not have.
 */
export function skipNoConnections(logger: Logger, source: string): SyncTaskRunResult {
  logger.warn(`${source}: no active, user-owned connection exists; nothing to sync`);

  return {
    status: 'success',
    summary: { fetchedCount: 0, createdCount: 0, updatedCount: 0, failedCount: 0 },
    errorMessages: [],
  };
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
    // A non-empty response is proof this account knows the child, so the
    // connection also earns a VIEW of them (ADR-0031) -- the half the stamp
    // cannot carry, since a child two parents share needs both. Written only
    // when the stamp changes: the login roster maintains the set in the steady
    // state, and re-asserting it on every successful fetch would be ten
    // pointless writes per student every twelve minutes.
    await linkStudentsToConnection(prisma, connection.id, [student.studentGuid]);
    student.householdConnectionId = connection.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not stamp ownership for ${student.studentGuid}: ${message}`);
  }
}
