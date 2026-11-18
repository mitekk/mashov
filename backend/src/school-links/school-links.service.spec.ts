import { PrismaService } from '../prisma/prisma.service';
import { SchoolLinksService } from './school-links.service';

function conn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-a',
    schoolCode: 540175,
    schoolYear: 2026,
    username: 'parent-a',
    encryptedPassword: 'enc:secret-password',
    schoolName: 'אורט רמון',
    displayLabel: null,
    active: true,
    userId: 'user-1',
    lastLoginAt: new Date('2026-11-18T08:00:00Z'),
    createdAt: new Date('2026-09-01T08:00:00Z'),
    mashovUniqueId: 'uniq',
    upstreamUserId: 'mashov-1',
    cachedNewCount: 3,
    schoolYears: [2026],
    linkedByUserId: null,
    linkedAt: null,
    updatedAt: new Date('2026-11-18T08:00:00Z'),
    ...overrides,
  };
}

function makePrisma(options: {
  connections?: Array<Record<string, unknown>>;
  studentCounts?: Array<{ householdConnectionId: string; _count: { _all: number } }>;
  lastRuns?: Array<{ householdConnectionId: string; _max: { endedAt: Date | null } }>;
} = {}) {
  const findMany = jest.fn().mockResolvedValue(options.connections ?? [conn()]);
  const studentGroupBy = jest.fn().mockResolvedValue(options.studentCounts ?? []);
  const syncRunGroupBy = jest.fn().mockResolvedValue(options.lastRuns ?? []);

  return {
    prisma: {
      householdConnection: { findMany },
      student: { groupBy: studentGroupBy },
      syncRun: { groupBy: syncRunGroupBy },
    } as unknown as PrismaService,
    findMany,
    studentGroupBy,
  };
}

describe('SchoolLinksService', () => {
  describe('listLinks', () => {
    it('never returns the password in any form', async () => {
      // The one assertion that must not be allowed to rot. A link row is the
      // only place the management screen reads a connection, and the row it
      // comes from holds the encrypted Mashov password.
      const { prisma } = makePrisma();
      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      const serialised = JSON.stringify(links);
      expect(serialised).not.toContain('enc:secret-password');
      expect(serialised).not.toContain('encryptedPassword');
      expect(serialised).not.toContain('password');
      expect(Object.keys(links[0])).not.toContain('encryptedPassword');
    });

    it("scopes to the caller's own active connections", async () => {
      const { prisma, findMany } = makePrisma();
      await new SchoolLinksService(prisma).listLinks('user-1');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', active: true } }),
      );
    });

    it('returns an empty list, and no further queries, for a household with none', async () => {
      const { prisma, studentGroupBy } = makePrisma({ connections: [] });
      await expect(new SchoolLinksService(prisma).listLinks('user-1')).resolves.toEqual([]);
      expect(studentGroupBy).not.toHaveBeenCalled();
    });

    it('counts each school\'s children', async () => {
      const { prisma } = makePrisma({
        connections: [conn(), conn({ id: 'conn-b', schoolCode: 999999, username: 'parent-b', schoolName: 'תיכון רמון' })],
        studentCounts: [
          { householdConnectionId: 'conn-a', _count: { _all: 2 } },
          { householdConnectionId: 'conn-b', _count: { _all: 1 } },
        ],
      });

      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      expect(links.map((link) => link.childrenCount)).toEqual([2, 1]);
    });

    it('reports zero children rather than omitting a school with none', async () => {
      // A school linked a moment ago has no children yet. It still has to
      // appear, or the parent cannot unlink the thing they just created.
      const { prisma } = makePrisma({ studentCounts: [] });

      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      expect(links).toHaveLength(1);
      expect(links[0].childrenCount).toBe(0);
    });

    it('leaves lastSyncAt null until a run has SUCCEEDED', async () => {
      // The UI shows "מסנכרן נתונים…" while this is null. A failed run must
      // not read as a finished sync -- a parent watching a school that cannot
      // sync should keep seeing that, not a reassuring timestamp.
      const { prisma } = makePrisma({ lastRuns: [] });

      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      expect(links[0].lastSyncAt).toBeNull();
    });

    it('reports the newest successful run as lastSyncAt', async () => {
      const endedAt = new Date('2026-11-18T09:30:00Z');
      const { prisma } = makePrisma({
        lastRuns: [{ householdConnectionId: 'conn-a', _max: { endedAt } }],
      });

      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      expect(links[0].lastSyncAt).toBe(endedAt.toISOString());
    });

    it('marks only the most recently used school as primary', async () => {
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-b', username: 'parent-b', lastLoginAt: new Date('2026-11-18T10:00:00Z') }),
          conn({ id: 'conn-a' }),
        ],
      });

      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      expect(links.map((link) => link.isPrimary)).toEqual([true, false]);
    });

    it('resolves short labels as a set, so two schools never share one', async () => {
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-a', schoolName: 'אורט רמון - חטיבת ביניים' }),
          conn({ id: 'conn-b', username: 'parent-b', schoolName: 'אורט רמון - חטיבה עליונה' }),
        ],
      });

      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      expect(links[0].shortLabel).not.toBe(links[1].shortLabel);
    });

    it('falls back to the semel when a school has no name', async () => {
      const { prisma } = makePrisma({ connections: [conn({ schoolName: null })] });

      const links = await new SchoolLinksService(prisma).listLinks('user-1');

      expect(links[0].schoolName).toBe('540175');
      expect(links[0].shortLabel).toBe('540175');
    });
  });

  describe('listMeSchools', () => {
    it('carries only what a badge needs, and no management fields', async () => {
      const { prisma } = makePrisma();

      const schools = await new SchoolLinksService(prisma).listMeSchools('user-1');

      expect(Object.keys(schools[0]).sort()).toEqual([
        'id',
        'schoolName',
        'schoolYear',
        'semel',
        'shortLabel',
      ]);
    });

    it('agrees with listLinks about which schools exist and in what order', async () => {
      // Both come from one method deliberately: two implementations of "which
      // schools are these" would drift, and the badge and the management
      // screen would disagree in front of the user.
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-b', username: 'parent-b', lastLoginAt: new Date('2026-11-18T10:00:00Z') }),
          conn({ id: 'conn-a' }),
        ],
      });
      const service = new SchoolLinksService(prisma);

      const [links, schools] = await Promise.all([
        service.listLinks('user-1'),
        service.listMeSchools('user-1'),
      ]);

      expect(schools.map((school) => school.id)).toEqual(links.map((link) => link.id));
      expect(schools.map((school) => school.shortLabel)).toEqual(
        links.map((link) => link.shortLabel),
      );
    });
  });
});
