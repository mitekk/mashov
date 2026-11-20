import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService, PER_STUDENT_SOURCES } from '../sync/freshness.service';
import type { SyncRunSnapshot } from '../sync/freshness.service';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
  ) {}

  /**
   * Source health for one caller's connection.
   *
   * This read was unscoped: any signed-in user got every household's sources,
   * and because per-student source keys are `<name>:<studentGuid>`, that
   * handed them other families' child identifiers. The connection now filters
   * both `sync_run` reads.
   *
   * The per-student source keys are derived from the caller's own snapshot
   * rather than from `student.findMany`. That matters more than the query
   * filter: `getAllSourceHealth` emits one `<source>:<guid>` row per guid it is
   * handed *whether or not any run exists*, so passing every active child
   * listed every household's child identifiers — with `status: 'never_synced'`
   * — no matter how the sync_run reads were scoped.
   *
   * Known residual, and the reason this is a narrowing rather than a fix:
   * `Student` carries no household column, so per-student tasks iterate every
   * child in the database and stamp those runs with whichever connection
   * triggered the refresh (and cron runs are stamped with none). A caller whose
   * refresh has run can therefore still see a guid that is not theirs. Closing
   * that needs `Student` scoped to a household — a schema change with its own
   * ADR. What is gone is the unconditional enumeration, which leaked every
   * child in the database to every user regardless of sync activity.
   */
  /**
   * One connection's source health, with the household's content freshness.
   *
   * Two scopes on purpose: the sync-run snapshot is this connection's, because
   * source health is a property of the connection that runs the syncs, while
   * the content aggregation is the caller's whole household -- a parent with
   * two schools has one freshness card. `userId` is what bounds the second
   * one; without it, it was every household in the database (R4).
   */
  async getSourceHealth(householdConnectionId: string | null, userId?: string) {
    if (!householdConnectionId) {
      return {
        sources: [],
        overallState: 'stale' as const,
        lastFullSyncAt: null,
        contentFreshness: null,
      };
    }

    // One load of the sync_run maps, shared by both reads below. Fetching them
    // per call meant four round trips for this one response.
    const snapshot = await this.freshnessService.loadSyncRuns(householdConnectionId);
    const studentGuids = this.studentGuidsIn(snapshot);

    const [sources, freshness] = await Promise.all([
      this.freshnessService.getAllSourceHealth(studentGuids, snapshot),
      this.freshnessService.computeFreshness(userId, snapshot),
    ]);

    return {
      sources,
      overallState: freshness.state,
      lastFullSyncAt: freshness.lastSyncAt,
      // The age of the content, not of the sync — the only field here that
      // would have caught the frozen school year.
      contentFreshness: freshness.contentFreshness,
    };
  }

  /**
   * The students a snapshot actually mentions, read back out of its run keys.
   *
   * Only an exact `<perStudentSource>:<guid>` shape counts. `mail_counts:<connId>`
   * and `schoolActivities:<userId>` carry a colon too but no student, and a
   * `history:<year>:…` backfill key is not a live source at all.
   */
  private studentGuidsIn(snapshot: SyncRunSnapshot): string[] {
    const guids = new Set<string>();

    for (const key of [...snapshot.allRuns.keys(), ...snapshot.successRuns.keys()]) {
      const separator = key.indexOf(':');
      if (separator === -1) continue;

      const base = key.slice(0, separator);
      if (!(PER_STUDENT_SOURCES as readonly string[]).includes(base)) continue;

      const guid = key.slice(separator + 1);
      if (guid.length > 0 && !guid.includes(':')) guids.add(guid);
    }

    return [...guids];
  }

  /**
   * The caller's profile at every school they have linked, one entry each.
   *
   * This was `parentProfile.findFirst()` and
   * `householdConnection.findFirst({ active: true })` -- neither filtered by
   * user. Any signed-in parent received *a* profile: some arbitrary
   * household's `displayName`, `email` and `cellphone`, plus their school.
   * More sensitive than the student identifiers that
   * `getSourceHealth` was leaking, and on the same controller.
   *
   * Scoping it to the caller fixed the leak but left B4: the contact details
   * were read by `appUser.mashovUserId` -- the credential that *created* the
   * AppUser, i.e. the first school signed into -- while the school name, year
   * and code came from a separate `lastLoginAt`-ordered read. The two can name
   * different schools, so a two-school parent was shown school A's phone
   * number under school B's name, on a screen where they will assume the
   * school holds the number displayed. `ParentProfile.householdConnectionId`
   * exists for exactly this: `upstreamUserId` is a per-school id, so a
   * two-school household has two rows and both are correct.
   *
   * The caller's own active connections bound the profile read -- never a bare
   * `findFirst`, which is how the original leak worked. Ordering matches
   * `SchoolLinksService.listLinks` so the cards and the school rows beneath
   * them agree.
   */
  async getProfile(userId: string | null) {
    if (!userId) return [];

    const appUser = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: { mashovUserId: true, displayName: true },
    });
    if (!appUser) return [];

    const connections = await this.prisma.householdConnection.findMany({
      where: { userId, active: true },
      orderBy: [{ lastLoginAt: 'desc' }, { createdAt: 'asc' }],
    });
    if (connections.length === 0) return [];

    const profiles = await this.prisma.parentProfile.findMany({
      where: { householdConnectionId: { in: connections.map((conn) => conn.id) } },
    });
    const stamped = new Map(profiles.map((profile) => [profile.householdConnectionId, profile]));

    // The stamp is legitimately null three ways, so a missing one is not a
    // missing profile: `user-details.task`'s shared-session branch passes no
    // connection, the `connection_scoping` backfill left rows it could not
    // attribute, and `onDelete: SetNull` nulls it on unlink. Fall back to the
    // row keyed on the creating credential, and only for the newest
    // connection -- that is what the screen showed before, now labelled with
    // the school it is being shown under rather than an unrelated one. A row
    // stamped to some *other* connection is deliberately not borrowed: it is
    // the caller's own profile, but relabelling it with this school's name is
    // the bug itself.
    let fallback: Awaited<ReturnType<typeof this.prisma.parentProfile.findUnique>> | undefined;
    const newestConnectionId = connections[0].id;

    const entries = [];
    for (const connection of connections) {
      let profile = stamped.get(connection.id) ?? null;

      if (!profile && connection.id === newestConnectionId) {
        if (fallback === undefined) {
          fallback = await this.prisma.parentProfile.findUnique({
            where: { upstreamUserId: appUser.mashovUserId },
          });
        }
        if (fallback && fallback.householdConnectionId === null) profile = fallback;
      }

      if (!profile) continue;

      entries.push({
        householdConnectionId: connection.id,
        upstreamUserId: profile.upstreamUserId,
        // `user-details.task` never writes ParentProfile.displayName, so for
        // most callers it is null. Unscoped, the page showed whichever profile
        // findFirst happened to return; scoped, it would go blank -- so fall
        // back to the name login already recorded for this user. That name is
        // the one the *creating* credential set, which is R8's residual and
        // not fixed here.
        displayName: profile.displayName ?? appUser.displayName ?? '',
        email: profile.email ?? '',
        cellphone: profile.cellphone ?? '',
        schoolName: connection.schoolName ?? '',
        schoolYear: connection.schoolYear ?? new Date().getFullYear(),
        schoolCode: connection.schoolCode ?? 0,
        detailsState: profile.detailsState,
        updatedAt: profile.updatedAt.toISOString(),
      });
    }

    return entries;
  }
}
