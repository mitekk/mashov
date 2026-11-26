import { PrismaService } from '../prisma/prisma.service';
import { FreshnessService } from '../sync/freshness.service';
import { SettingsService } from './settings.service';
import type { SyncOnReadService } from '../sync/sync-on-read.service';
import type { UserDetailsTask } from '../sync/tasks/user-details.task';

function makeMockPrisma(overrides: Partial<Record<string, jest.Mock>>) {
  return {
    student: {
      findMany: overrides.studentFindMany ?? jest.fn().mockResolvedValue([]),
    },
    parentProfile: {
      findFirst: overrides.profileFindFirst ?? jest.fn().mockResolvedValue(null),
      findUnique: overrides.profileFindUnique ?? jest.fn().mockResolvedValue(null),
      findMany: overrides.profileFindMany ?? jest.fn().mockResolvedValue([]),
    },
    appUser: {
      findUnique:
        overrides.appUserFindUnique ??
        jest.fn().mockResolvedValue({ mashovUserId: 'mashov-1', displayName: 'App User' }),
    },
    householdConnection: {
      findFirst: overrides.householdFindFirst ?? jest.fn().mockResolvedValue(null),
      findMany: overrides.householdFindMany ?? jest.fn().mockResolvedValue([]),
    },
    studentConnection: {
      findMany: overrides.studentConnectionFindMany ?? jest.fn().mockResolvedValue([]),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeMockFreshnessService(overrides: Partial<Record<string, jest.Mock>>) {
  return {
    loadSyncRuns:
      overrides.loadSyncRuns ??
      jest.fn().mockResolvedValue({ allRuns: new Map(), successRuns: new Map() }),
    getAllSourceHealth:
      overrides.getAllSourceHealth ?? jest.fn().mockResolvedValue([]),
    computeFreshness:
      overrides.computeFreshness ??
      jest.fn().mockResolvedValue({
        state: 'fresh',
        lastSyncAt: null,
        staleSources: [],
        contentFreshness: {
          expectedSchoolYear: 2027,
          observedSchoolYear: 2027,
          newestContentAt: '2026-11-14T00:00:00.000Z',
          contentAgeDays: 3,
          status: 'current',
        },
      }),
  } as unknown as jest.Mocked<FreshnessService>;
}

/**
 * The read-path freshening dependencies. `ensureFresh` returns early under
 * NODE_ENV=test, so these exist only to satisfy the constructor.
 */
function readPathDeps(): [SyncOnReadService, UserDetailsTask] {
  return [
    { ensureFresh: jest.fn(), deadlineFromNow: () => Date.now() + 4_000 } as unknown as SyncOnReadService,
    { execute: jest.fn() } as unknown as UserDetailsTask,
  ];
}

describe('SettingsService', () => {
  describe('getSourceHealth', () => {
    it('returns contract shape with sources + overallState + lastFullSyncAt', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          studentFindMany: jest.fn().mockResolvedValue([
            { studentGuid: 'guid-1' },
            { studentGuid: 'guid-2' },
          ]),
        }),
        makeMockFreshnessService({
          getAllSourceHealth: jest.fn().mockResolvedValue([
            {
              source: 'notifications',
              status: 'fresh',
              lastSuccessAt: '2026-03-12T10:00:00Z',
              lastAttemptAt: '2026-03-12T10:00:00Z',
              lastErrorMessage: null,
              fetchedCount: 4,
              staleThresholdMinutes: 15,
            },
          ]),
          computeFreshness: jest.fn().mockResolvedValue({
            state: 'fresh',
            lastSyncAt: '2026-03-12T10:00:00Z',
            staleSources: [],
          }),
        }),
        ...readPathDeps(),
      );

      const result = await service.getSourceHealth('conn-1');
      expect(result).toEqual({
        sources: expect.any(Array),
        overallState: 'fresh',
        lastFullSyncAt: '2026-03-12T10:00:00Z',
      });
      expect(result.sources).toHaveLength(1);
    });
  });

  describe('getProfile', () => {
    it('freshens every linked school, not just the first', async () => {
      // `UserDetailsTask.execute` narrows to `context.connectionId`, so with
      // the `user_details` cron gone, freshening only `connections[0]` left a
      // two-school household's second profile never refreshed again.
      const syncOnRead = {
        ensureFresh: jest.fn(),
        deadlineFromNow: () => Date.now() + 4_000,
      } as unknown as SyncOnReadService;
      const service = new SettingsService(
        makeMockPrisma({
          appUserFindUnique: jest
            .fn()
            .mockResolvedValue({ mashovUserId: 'mashov-a', displayName: 'App User' }),
          profileFindMany: jest.fn().mockResolvedValue([]),
          householdFindMany: jest.fn().mockResolvedValue([
            { id: 'conn-b', schoolName: 'School B', schoolYear: 2026, schoolCode: 2222 },
            { id: 'conn-a', schoolName: 'School A', schoolYear: 2026, schoolCode: 1111 },
          ]),
        }),
        makeMockFreshnessService({}),
        syncOnRead,
        { execute: jest.fn() } as unknown as UserDetailsTask,
      );

      await service.getProfile('app-user-1');

      const connectionIds = (syncOnRead.ensureFresh as jest.Mock).mock.calls.map(
        (call) => call[2].connectionId,
      );
      expect(connectionIds).toEqual(['conn-b', 'conn-a']);
      // One shared budget, so a household with more schools cannot make the
      // page wait longer.
      const deadlines = new Set(
        (syncOnRead.ensureFresh as jest.Mock).mock.calls.map((call) => call[2].deadline),
      );
      expect(deadlines.size).toBe(1);
    });

    // One school: the same fields the screen always showed, now in a list and
    // carrying the connection they were read for.
    it('returns one entry per school in contract shape', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          profileFindMany: jest.fn().mockResolvedValue([
            {
              upstreamUserId: 'mashov-1',
              displayName: 'Parent Name',
              email: 'parent@example.com',
              cellphone: '050-1234567',
              detailsState: 2,
              updatedAt: new Date('2026-03-12T09:00:00Z'),
              householdConnectionId: 'conn-1',
            },
          ]),
          householdFindMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'conn-1', schoolName: 'Test School', schoolYear: 2026, schoolCode: 1234 },
            ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      const result = await service.getProfile('app-user-1');
      expect(result).toEqual([
        {
          householdConnectionId: 'conn-1',
          upstreamUserId: 'mashov-1',
          displayName: 'Parent Name',
          email: 'parent@example.com',
          cellphone: '050-1234567',
          schoolName: 'Test School',
          schoolYear: 2026,
          schoolCode: 1234,
          detailsState: 2,
          children: [],
          updatedAt: '2026-03-12T09:00:00.000Z',
        },
      ]);
    });

    // B4. The school label came from a `lastLoginAt`-ordered findFirst while
    // the contact details came from a findUnique on the *creating*
    // credential's upstream id, so a two-school parent was shown school A's
    // phone number under school B's name. Each school's details now travel
    // with their own school.
    it('labels each school with its own contact details', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          appUserFindUnique: jest
            .fn()
            .mockResolvedValue({ mashovUserId: 'mashov-a', displayName: 'App User' }),
          profileFindMany: jest.fn().mockResolvedValue([
            {
              upstreamUserId: 'mashov-a',
              displayName: null,
              email: 'parent@school-a.example',
              cellphone: '050-1111111',
              detailsState: 2,
              updatedAt: new Date('2026-03-12T09:00:00Z'),
              householdConnectionId: 'conn-a',
            },
            {
              upstreamUserId: 'mashov-b',
              displayName: null,
              email: 'parent@school-b.example',
              cellphone: '050-2222222',
              detailsState: 2,
              updatedAt: new Date('2026-03-13T09:00:00Z'),
              householdConnectionId: 'conn-b',
            },
          ]),
          // Newest sign-in first, matching `listLinks`' ordering so the cards
          // and the school rows under them agree.
          householdFindMany: jest.fn().mockResolvedValue([
            { id: 'conn-b', schoolName: 'School B', schoolYear: 2026, schoolCode: 2222 },
            { id: 'conn-a', schoolName: 'School A', schoolYear: 2026, schoolCode: 1111 },
          ]),
          studentConnectionFindMany: jest.fn().mockResolvedValue([
            {
              householdConnectionId: 'conn-a',
              student: {
                studentGuid: 'guid-nelly',
                fullName: 'נלי',
                classCode: 'ד',
                classNum: 3,
              },
            },
            {
              householdConnectionId: 'conn-b',
              student: {
                studentGuid: 'guid-mika',
                fullName: 'מיקה',
                classCode: 'ז',
                classNum: 8,
              },
            },
          ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      const result = await service.getProfile('app-user-1');

      expect(result).toHaveLength(2);
      expect(result.map((entry) => [entry.schoolName, entry.cellphone])).toEqual([
        ['School B', '050-2222222'],
        ['School A', '050-1111111'],
      ]);
      expect(result.map((entry) => entry.householdConnectionId)).toEqual([
        'conn-b',
        'conn-a',
      ]);
      // The creating credential's row must not be relabelled with the other
      // school's name -- that relabelling is the bug.
      expect(
        result.find((entry) => entry.schoolName === 'School B')?.email,
      ).toBe('parent@school-b.example');
    });

    // R8's residual, and the reason both cards read
    // "קורס דמיטרי [מיקה ז8]": `ParentProfile.displayName` is never written,
    // so every card falls through to the one global `AppUser.displayName`,
    // which carries the CREATING credential's child in brackets. Stripped
    // name on both cards; the children come from the roster instead, per
    // school.
    it("strips the credential child tag and lists each school's own children", async () => {
      const service = new SettingsService(
        makeMockPrisma({
          appUserFindUnique: jest.fn().mockResolvedValue({
            mashovUserId: 'mashov-a',
            displayName: 'קורס דמיטרי [מיקה ז8]',
          }),
          profileFindMany: jest.fn().mockResolvedValue([
            {
              upstreamUserId: 'mashov-a',
              displayName: null,
              email: 'parent@school-a.example',
              cellphone: '050-1111111',
              detailsState: 2,
              updatedAt: new Date('2026-03-12T09:00:00Z'),
              householdConnectionId: 'conn-a',
            },
            {
              upstreamUserId: 'mashov-b',
              displayName: null,
              email: 'parent@school-b.example',
              cellphone: '050-2222222',
              detailsState: 2,
              updatedAt: new Date('2026-03-13T09:00:00Z'),
              householdConnectionId: 'conn-b',
            },
          ]),
          householdFindMany: jest.fn().mockResolvedValue([
            { id: 'conn-b', schoolName: 'חטיבת נעורים בראשית', schoolYear: 2027, schoolCode: 2222 },
            { id: 'conn-a', schoolName: 'יצחק נבון', schoolYear: 2027, schoolCode: 1111 },
          ]),
          studentConnectionFindMany: jest.fn().mockResolvedValue([
            {
              householdConnectionId: 'conn-b',
              student: {
                studentGuid: 'guid-mika',
                fullName: 'מיקה',
                classCode: 'ז',
                classNum: 8,
              },
            },
            {
              householdConnectionId: 'conn-a',
              student: {
                studentGuid: 'guid-nelly',
                fullName: 'נלי',
                classCode: 'ד',
                classNum: 3,
              },
            },
          ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      const result = await service.getProfile('app-user-1');

      expect(result.map((entry) => entry.displayName)).toEqual([
        'קורס דמיטרי',
        'קורס דמיטרי',
      ]);
      // Each card carries ONLY its own school's children -- the whole point.
      expect(
        result.map((entry) => [
          entry.schoolName,
          entry.children.map((child) => child.fullName),
        ]),
      ).toEqual([
        ['חטיבת נעורים בראשית', ['מיקה']],
        ['יצחק נבון', ['נלי']],
      ]);
      expect(result[0].children[0]).toEqual({
        studentGuid: 'guid-mika',
        fullName: 'מיקה',
        classCode: 'ז',
        classNum: 8,
      });
    });

    it('counts children over the visibility edge, for active students only', async () => {
      const studentConnectionFindMany = jest.fn().mockResolvedValue([]);
      const service = new SettingsService(
        makeMockPrisma({
          profileFindMany: jest.fn().mockResolvedValue([
            {
              upstreamUserId: 'mashov-1',
              displayName: null,
              email: 'parent@example.com',
              cellphone: '050-1234567',
              detailsState: 2,
              updatedAt: new Date('2026-03-12T09:00:00Z'),
              householdConnectionId: 'conn-1',
            },
          ]),
          householdFindMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'conn-1', schoolName: 'Test School', schoolYear: 2026, schoolCode: 1234 },
            ]),
          studentConnectionFindMany,
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      const result = await service.getProfile('app-user-1');

      // `[]`, not undefined: a school whose first roster sync has not landed
      // renders no children line, and the card must not throw on it.
      expect(result[0].children).toEqual([]);
      expect(studentConnectionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            householdConnectionId: { in: ['conn-1'] },
            student: { isActive: true },
          },
        }),
      );
    });

    it('returns an empty list when no profile exists for any school', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          profileFindMany: jest.fn().mockResolvedValue([]),
          profileFindUnique: jest.fn().mockResolvedValue(null),
          householdFindMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'conn-1', schoolName: 'Test School', schoolYear: 2026, schoolCode: 1234 },
            ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      await expect(service.getProfile('app-user-1')).resolves.toEqual([]);
    });

    // The stamp is legitimately null three ways: the shared-session branch of
    // `user-details.task` passes no connection, the connection-scoping
    // backfill left rows it could not attribute, and `onDelete: SetNull` nulls
    // it on unlink. An unstamped row still has to answer, labelled with the
    // newest connection -- which is exactly what the screen showed before.
    it('falls back to the unstamped row for the newest connection', async () => {
      const profileFindUnique = jest.fn().mockResolvedValue({
        upstreamUserId: 'mashov-1',
        displayName: 'Parent Name',
        email: 'parent@example.com',
        cellphone: '050-1234567',
        detailsState: 2,
        updatedAt: new Date('2026-03-12T09:00:00Z'),
        householdConnectionId: null,
      });

      const service = new SettingsService(
        makeMockPrisma({
          profileFindMany: jest.fn().mockResolvedValue([]),
          profileFindUnique,
          householdFindMany: jest.fn().mockResolvedValue([
            { id: 'conn-new', schoolName: 'Newest School', schoolYear: 2026, schoolCode: 2222 },
            { id: 'conn-old', schoolName: 'Older School', schoolYear: 2026, schoolCode: 1111 },
          ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      const result = await service.getProfile('app-user-1');

      expect(profileFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { upstreamUserId: 'mashov-1' } }),
      );
      // One entry, not two: the unstamped row is one school's details and we
      // do not know which, so it is attributed to the newest sign-in only.
      expect(result).toEqual([
        expect.objectContaining({
          householdConnectionId: 'conn-new',
          schoolName: 'Newest School',
          cellphone: '050-1234567',
        }),
      ]);
    });

    // The fallback reproduced B4 in exactly the population B4 is about. The
    // `connection_scoping` backfill REFUSES to stamp on any database with two
    // or more active connections, so on a real two-school deployment both
    // `parent_profile` rows start unstamped -- and the fallback is keyed on
    // the credential that CREATED the AppUser, i.e. usually the other school.
    // Borrowing it for the newest connection captioned school A's phone
    // number with school B's name all over again, until the next sync stamped
    // the rows. The connection row already carries the `upstreamUserId` that
    // settles it.
    it('does not borrow an unstamped row that belongs to another school', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          appUserFindUnique: jest
            .fn()
            .mockResolvedValue({ mashovUserId: 'mashov-a', displayName: 'App User' }),
          profileFindMany: jest.fn().mockResolvedValue([]),
          profileFindUnique: jest.fn().mockResolvedValue({
            // School A's profile: the credential that created the AppUser.
            upstreamUserId: 'mashov-a',
            displayName: null,
            email: 'parent@school-a.example',
            cellphone: '050-1111111',
            detailsState: 2,
            updatedAt: new Date('2026-03-12T09:00:00Z'),
            householdConnectionId: null,
          }),
          householdFindMany: jest.fn().mockResolvedValue([
            // Newest sign-in is school B, whose own upstream id differs.
            {
              id: 'conn-b',
              schoolName: 'School B',
              schoolYear: 2026,
              schoolCode: 2222,
              upstreamUserId: 'mashov-b',
            },
            {
              id: 'conn-a',
              schoolName: 'School A',
              schoolYear: 2026,
              schoolCode: 1111,
              upstreamUserId: 'mashov-a',
            },
          ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      const result = await service.getProfile('app-user-1');

      // School A's number must not appear under School B's name. It is
      // attributed to School A, whose upstream id it matches.
      expect(result).toEqual([
        expect.objectContaining({
          householdConnectionId: 'conn-a',
          schoolName: 'School A',
          cellphone: '050-1111111',
        }),
      ]);
    });

    it('still borrows an unstamped row when the connection knows no upstream id', async () => {
      // A connection whose `upstreamUserId` is null cannot contradict the
      // row, so this keeps today's behaviour rather than blanking the card.
      const service = new SettingsService(
        makeMockPrisma({
          profileFindMany: jest.fn().mockResolvedValue([]),
          profileFindUnique: jest.fn().mockResolvedValue({
            upstreamUserId: 'mashov-1',
            displayName: 'Parent Name',
            email: 'parent@example.com',
            cellphone: '050-1234567',
            detailsState: 2,
            updatedAt: new Date('2026-03-12T09:00:00Z'),
            householdConnectionId: null,
          }),
          householdFindMany: jest.fn().mockResolvedValue([
            {
              id: 'conn-new',
              schoolName: 'Newest School',
              schoolYear: 2026,
              schoolCode: 2222,
              upstreamUserId: null,
            },
          ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      await expect(service.getProfile('app-user-1')).resolves.toEqual([
        expect.objectContaining({ householdConnectionId: 'conn-new' }),
      ]);
    });

    // A row stamped to a connection outside the caller's active set is not
    // relabelled with the newest school's name. Being keyed on the caller's
    // own `mashovUserId` makes it theirs, but it is not this school's.
    it('does not relabel a row stamped to another connection', async () => {
      const service = new SettingsService(
        makeMockPrisma({
          profileFindMany: jest.fn().mockResolvedValue([]),
          profileFindUnique: jest.fn().mockResolvedValue({
            upstreamUserId: 'mashov-1',
            displayName: 'Parent Name',
            email: 'parent@example.com',
            cellphone: '050-1234567',
            detailsState: 2,
            updatedAt: new Date('2026-03-12T09:00:00Z'),
            householdConnectionId: 'conn-gone',
          }),
          householdFindMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'conn-new', schoolName: 'Newest School', schoolYear: 2026, schoolCode: 2222 },
            ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      await expect(service.getProfile('app-user-1')).resolves.toEqual([]);
    });

    // `parentProfile.findFirst()` with no filter returned *a* profile, not the
    // caller's: any signed-in user got some arbitrary household's displayName,
    // email and cellphone. The household read was unfiltered the same way.
    it("reads profiles only for the caller's own connections", async () => {
      const profileFindMany = jest.fn().mockResolvedValue([
        {
          upstreamUserId: 'mashov-1',
          displayName: 'Parent Name',
          email: 'parent@example.com',
          cellphone: '050-1234567',
          detailsState: 2,
          updatedAt: new Date('2026-03-12T09:00:00Z'),
          householdConnectionId: 'conn-1',
        },
      ]);
      const householdFindMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'conn-1', schoolName: 'Test School', schoolYear: 2026, schoolCode: 1234 },
        ]);
      const appUserFindUnique = jest
        .fn()
        .mockResolvedValue({ mashovUserId: 'mashov-1', displayName: 'App User' });
      const profileFindFirst = jest.fn();

      const service = new SettingsService(
        makeMockPrisma({
          appUserFindUnique,
          profileFindMany,
          profileFindFirst,
          householdFindMany,
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      await service.getProfile('app-user-1');

      expect(appUserFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'app-user-1' } }),
      );
      expect(householdFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'app-user-1', active: true } }),
      );
      // The profile read is bounded by the ids the household read returned --
      // never by a bare lookup over the whole table.
      expect(profileFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { householdConnectionId: { in: ['conn-1'] } },
        }),
      );
      // An unfiltered findFirst is how the leak worked; it must not be reachable.
      expect(profileFindFirst).not.toHaveBeenCalled();
    });

    it('returns an empty list and reads nothing without a caller', async () => {
      const appUserFindUnique = jest.fn();
      const profileFindMany = jest.fn();
      const householdFindMany = jest.fn();
      const service = new SettingsService(
        makeMockPrisma({ appUserFindUnique, profileFindMany, householdFindMany }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      await expect(service.getProfile(null)).resolves.toEqual([]);
      expect(appUserFindUnique).not.toHaveBeenCalled();
      expect(profileFindMany).not.toHaveBeenCalled();
      expect(householdFindMany).not.toHaveBeenCalled();
    });

    it('returns an empty list when the caller no longer exists', async () => {
      const profileFindMany = jest.fn();
      const service = new SettingsService(
        makeMockPrisma({
          appUserFindUnique: jest.fn().mockResolvedValue(null),
          profileFindMany,
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      await expect(service.getProfile('ghost')).resolves.toEqual([]);
      expect(profileFindMany).not.toHaveBeenCalled();
    });

    // `user-details.task` never writes ParentProfile.displayName, so for most
    // callers it is null. Before scoping, the page happened to show whichever
    // profile findFirst returned; scoped to the caller it would go blank, so
    // fall back to the name we do hold for them.
    it("falls back to the app user's display name when the profile has none", async () => {
      const service = new SettingsService(
        makeMockPrisma({
          appUserFindUnique: jest
            .fn()
            .mockResolvedValue({ mashovUserId: 'mashov-1', displayName: 'Real Name' }),
          profileFindMany: jest.fn().mockResolvedValue([
            {
              upstreamUserId: 'mashov-1',
              displayName: null,
              email: 'parent@example.com',
              cellphone: '050-1234567',
              detailsState: 2,
              updatedAt: new Date('2026-03-12T09:00:00Z'),
              householdConnectionId: 'conn-1',
            },
          ]),
          householdFindMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'conn-1', schoolName: 'Test School', schoolYear: 2026, schoolCode: 1234 },
            ]),
        }),
        makeMockFreshnessService({}),
        ...readPathDeps(),
      );

      const result = await service.getProfile('app-user-1');
      expect(result[0]?.displayName).toBe('Real Name');
    });
  });

  describe('getSourceHealth scoping', () => {
    // The leak this method was supposed to close. `student.findMany({ isActive:
    // true })` enumerated every child in the database, and
    // FreshnessService.getAllSourceHealth emits one `<source>:<guid>` entry per
    // guid *unconditionally* -- so foreign child identifiers appeared in the
    // response with status 'never_synced' even when no sync_run row for them
    // existed anywhere. Scoping the sync_run reads alone did nothing about it.
    it('enumerates per-student sources from the caller snapshot, not from every child', async () => {
      // `student.findMany` is still read, but only to *narrow* the snapshot's
      // own guids -- it is bounded by an `in` list and can no longer widen the
      // response to a child the caller's runs never mention.
      const studentFindMany = jest.fn().mockResolvedValue([{ studentGuid: 'mine-1' }]);
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([['homework:mine-1', {}], ['notifications', {}]]),
        successRuns: new Map([['behavior:mine-1', {}]]),
      });

      const service = new SettingsService(
        makeMockPrisma({ studentFindMany }),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
        ...readPathDeps(),
      );

      await service.getSourceHealth('conn-1');

      expect(studentFindMany).toHaveBeenCalledWith({
        where: { studentGuid: { in: ['mine-1'] }, isActive: true },
        select: { studentGuid: true },
      });
      expect(getAllSourceHealth).toHaveBeenCalledWith(['mine-1'], expect.anything());
      const [guids] = getAllSourceHealth.mock.calls[0] as [string[]];
      expect(guids).not.toContain('a-stranger-child');
    });

    // A departed child. `RosterPresenceService` flips `isActive` to false when
    // she stops appearing in any roster, and from that moment every
    // per-student task skips her -- `studentScopeForContext` filters
    // `isActive: true`. Her last run before that was often a failed one, and
    // because no future run can ever supersede it, `errorIsSpent` never fires
    // and `/more` printed a four-day-old red error under a green check,
    // permanently.
    it('drops a guid whose student is no longer active', async () => {
      const studentFindMany = jest.fn().mockResolvedValue([{ studentGuid: 'here-1' }]);
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([
          ['homework:here-1', {}],
          ['homework:departed-1', {}],
        ]),
        successRuns: new Map([['homework:departed-1', {}]]),
      });

      const service = new SettingsService(
        makeMockPrisma({ studentFindMany }),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
        ...readPathDeps(),
      );

      await service.getSourceHealth('conn-1');

      expect(getAllSourceHealth).toHaveBeenCalledWith(['here-1'], expect.anything());
    });

    // Unlike the visibility rule one test below, a *missing* Student row is not
    // "ownership unknown". Nothing will ever sync that guid again, so its
    // frozen status is not news.
    it('drops a guid with no student row at all', async () => {
      const studentFindMany = jest.fn().mockResolvedValue([]);
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([['homework:ghost-1', {}]]),
        successRuns: new Map(),
      });

      const service = new SettingsService(
        makeMockPrisma({ studentFindMany }),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
        ...readPathDeps(),
      );

      await service.getSourceHealth('conn-1');

      expect(getAllSourceHealth).toHaveBeenCalledWith([], expect.anything());
    });

    it('ignores a colon-bearing key that is not a per-student source', async () => {
      // mail_counts writes `mail_counts:<connectionId>` and schoolActivities
      // writes `schoolActivities:<userId>`. Neither suffix is a student guid,
      // and treating them as one would invent per-student rows for them.
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([
          ['mail_counts:conn-1', {}],
          ['schoolActivities:user-9', {}],
          ['history:2025:homework:old-guid', {}],
        ]),
        successRuns: new Map(),
      });

      const service = new SettingsService(
        makeMockPrisma({}),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
        ...readPathDeps(),
      );

      await service.getSourceHealth('conn-1');

      expect(getAllSourceHealth).toHaveBeenCalledWith([], expect.anything());
    });

    it('drops a guid the caller’s own visibility edges do not list', async () => {
      // T13 finding 4, two-school only. An unstamped cron tick writes
      // `homework:<guid>` and `behavior:<guid>` for BOTH children with no
      // connection, and the branch-wide NULL rule admits those rows into every
      // connection's snapshot — deliberately, and that stays. The consequence
      // the leak comment does not name is that the foreign guid then *decides*
      // a row's status: `groups` has no NULL-stamped rows at all, so the other
      // school's guid finds no success for this connection and the row goes
      // `never_synced` minutes after `groups` succeeded.
      const studentConnectionFindMany = jest.fn().mockResolvedValue([
        { studentGuid: 'mine-1', householdConnectionId: 'conn-1' },
        { studentGuid: 'theirs-1', householdConnectionId: 'conn-2' },
      ]);
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const studentFindMany = jest.fn().mockResolvedValue([
        { studentGuid: 'mine-1' },
        { studentGuid: 'theirs-1' },
      ]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([
          ['homework:mine-1', {}],
          ['homework:theirs-1', {}],
        ]),
        successRuns: new Map([['behavior:theirs-1', {}]]),
      });

      const service = new SettingsService(
        makeMockPrisma({ studentConnectionFindMany, studentFindMany }),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
        ...readPathDeps(),
      );

      await service.getSourceHealth('conn-1');

      expect(getAllSourceHealth).toHaveBeenCalledWith(['mine-1'], expect.anything());
    });

    it('keeps a guid no connection lists at all', async () => {
      // Unlinked is readable — ownership unknown is not somebody else's. The
      // same reading as `canSeeStudent` and `connectionStudentWhere`; narrowing
      // it here would hide a child's sources from the parent who has them.
      const studentConnectionFindMany = jest.fn().mockResolvedValue([
        { studentGuid: 'theirs-1', householdConnectionId: 'conn-2' },
      ]);
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const studentFindMany = jest.fn().mockResolvedValue([
        { studentGuid: 'unlinked-1' },
        { studentGuid: 'theirs-1' },
      ]);
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([
          ['homework:unlinked-1', {}],
          ['homework:theirs-1', {}],
        ]),
        successRuns: new Map(),
      });

      const service = new SettingsService(
        makeMockPrisma({ studentConnectionFindMany, studentFindMany }),
        makeMockFreshnessService({ loadSyncRuns, getAllSourceHealth }) as never,
        ...readPathDeps(),
      );

      await service.getSourceHealth('conn-1');

      expect(getAllSourceHealth).toHaveBeenCalledWith(['unlinked-1'], expect.anything());
    });

    // Any signed-in user used to get every household's sources. Per-student
    // source keys embed the student GUID, so that leaked other families'
    // child identifiers through a settings screen.
    it('returns nothing and reads nothing when the caller has no connection', async () => {
      const loadSyncRuns = jest.fn();
      const getAllSourceHealth = jest.fn();
      const computeFreshness = jest.fn();
      const studentFindMany = jest.fn();
      const service = new SettingsService(
        makeMockPrisma({ studentFindMany }),
        makeMockFreshnessService({
          loadSyncRuns,
          getAllSourceHealth,
          computeFreshness,
        }) as never,
        ...readPathDeps(),
      );

      const result = await service.getSourceHealth(null);

      expect(result.sources).toEqual([]);
      expect(result.lastFullSyncAt).toBeNull();
      expect(result.contentFreshness).toBeNull();
      expect(loadSyncRuns).not.toHaveBeenCalled();
      expect(getAllSourceHealth).not.toHaveBeenCalled();
      expect(computeFreshness).not.toHaveBeenCalled();
      expect(studentFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getSourceHealth connection use', () => {
    // Each of these maps was formerly fetched twice -- once here and again
    // inside computeFreshness -- so one response made four full reads of an
    // unbounded table, held four pool connections, and timed out the request.
    it('loads the sync_run maps once and shares them with both reads', async () => {
      const loadSyncRuns = jest.fn().mockResolvedValue({
        allRuns: new Map([['homework:guid-1', {}]]),
        successRuns: new Map(),
      });
      const getAllSourceHealth = jest.fn().mockResolvedValue([]);
      const computeFreshness = jest.fn().mockResolvedValue({
        state: 'fresh',
        lastSyncAt: null,
        staleSources: [],
        contentFreshness: {
          expectedSchoolYear: 2027,
          observedSchoolYear: 2027,
          newestContentAt: null,
          contentAgeDays: null,
          status: 'no_content',
        },
      });

      const service = new SettingsService(
        makeMockPrisma({
          studentFindMany: jest.fn().mockResolvedValue([{ studentGuid: 'guid-1' }]),
        }),
        makeMockFreshnessService({
          loadSyncRuns,
          getAllSourceHealth,
          computeFreshness,
        }) as never,
        ...readPathDeps(),
      );

      await service.getSourceHealth('conn-1', 'user-1');

      expect(loadSyncRuns).toHaveBeenCalledTimes(1);
      // The snapshot stays per connection: source health is a property of the
      // connection whose crons run. Only the content aggregation underneath
      // `computeFreshness` is per household, which is what `userId` bounds.
      expect(loadSyncRuns).toHaveBeenCalledWith('conn-1');
      const snapshot = await loadSyncRuns.mock.results[0].value;
      expect(getAllSourceHealth).toHaveBeenCalledWith(['guid-1'], snapshot);
      expect(computeFreshness).toHaveBeenCalledWith('user-1', snapshot);
    });
  });
});
