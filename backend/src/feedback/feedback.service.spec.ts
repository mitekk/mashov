import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  FEEDBACK_MAX_PER_HOUR,
  FEEDBACK_SUBJECTS,
  FEEDBACK_USER_AGENT_MAX,
  FeedbackService,
} from './feedback.service';

interface MockConnection {
  id: string;
  schoolCode: number;
  schoolName: string | null;
  displayLabel: string | null;
  schoolYear: number;
}

function makeMockPrisma(options: {
  count?: number;
  user?: { mashovUserId: string; username: string; displayName: string } | null;
  connections?: MockConnection[];
}) {
  const create = jest.fn().mockImplementation(({ data }) =>
    Promise.resolve({ id: 'feedback-1', subject: data.subject, createdAt: new Date(0) }),
  );
  return {
    create,
    prisma: {
      feedback: {
        count: jest.fn().mockResolvedValue(options.count ?? 0),
        create,
      },
      appUser: {
        findUnique: jest.fn().mockResolvedValue(
          options.user === undefined
            ? { mashovUserId: 'mashov-1', username: 'parent', displayName: 'קורס דמיטרי' }
            : options.user,
        ),
      },
      householdConnection: {
        findMany: jest.fn().mockResolvedValue(options.connections ?? []),
      },
    } as unknown as jest.Mocked<PrismaService>,
  };
}

/** The payload every test starts from; each one overrides only what it is about. */
function input(overrides: Record<string, unknown> = {}) {
  return { subject: 'bug' as const, content: 'הציון בחשבון שגוי', ...overrides };
}

describe('FeedbackService', () => {
  /**
   * The list is duplicated in the frontend (separate tsconfig roots, no shared
   * package). Pinning the literal here makes a server-side change to it a
   * failing test rather than a 400 the parent discovers.
   */
  it('offers exactly the seven agreed subjects, in order', () => {
    expect(FEEDBACK_SUBJECTS).toEqual([
      'bug',
      'suggestion',
      'data',
      'account',
      'notifications',
      'timetable',
      'other',
    ]);
  });

  describe('create', () => {
    it('stores the parent-written label when the subject is other', async () => {
      const { prisma, create } = makeMockPrisma({});
      const service = new FeedbackService(prisma);

      await service.create('user-1', input({ subject: 'other', subjectOther: 'הדף נטען לאט' }));

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ subject: 'other', subjectOther: 'הדף נטען לאט' }),
        }),
      );
    });

    /**
     * `whitelist: true` strips only UNDECORATED properties, and `@ValidateIf`
     * makes the validator skip `subjectOther` while the value still lands in
     * the payload. Without this, `{subject: 'bug', subjectOther: 'x'}` would
     * persist a label that belongs to no subject.
     */
    it('nulls the label when the subject is not other', async () => {
      const { prisma, create } = makeMockPrisma({});
      const service = new FeedbackService(prisma);

      await service.create('user-1', input({ subject: 'bug', subjectOther: 'stray' }));

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ subject: 'bug', subjectOther: null }),
        }),
      );
    });

    /**
     * The short label is a set-resolved rule, not the raw nullable
     * `displayLabel`: two schools in one cluster share everything up to the
     * " - …" qualifier, so a collision must revert BOTH to their full names.
     * Snapshotting `displayLabel` instead would file both reports under the
     * same unreadable name.
     */
    it('snapshots both full names when two schools would share one short label', async () => {
      const { prisma, create } = makeMockPrisma({
        connections: [
          {
            id: 'conn-a',
            schoolCode: 111,
            schoolName: 'אורט רמון - חינוך מיוחד',
            displayLabel: null,
            schoolYear: 2027,
          },
          {
            id: 'conn-b',
            schoolCode: 222,
            schoolName: 'אורט רמון - תיכון',
            displayLabel: null,
            schoolYear: 2026,
          },
        ],
      });
      const service = new FeedbackService(prisma);

      await service.create('user-1', input());

      const { schoolsSnapshot } = create.mock.calls[0][0].data;
      expect(schoolsSnapshot).toEqual([
        {
          id: 'conn-a',
          schoolCode: 111,
          schoolName: 'אורט רמון - חינוך מיוחד',
          label: 'אורט רמון - חינוך מיוחד',
          schoolYear: 2027,
        },
        {
          id: 'conn-b',
          schoolCode: 222,
          schoolName: 'אורט רמון - תיכון',
          label: 'אורט רמון - תיכון',
          schoolYear: 2026,
        },
      ]);
    });

    it('asks only for the active connections of this household', async () => {
      const { prisma } = makeMockPrisma({});
      const service = new FeedbackService(prisma);

      await service.create('user-1', input());

      expect(prisma.householdConnection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', active: true } }),
      );
    });

    it('snapshots an empty list when the household has no active connection', async () => {
      const { prisma, create } = makeMockPrisma({ connections: [] });
      const service = new FeedbackService(prisma);

      await service.create('user-1', input());

      expect(create.mock.calls[0][0].data.schoolsSnapshot).toEqual([]);
    });

    /**
     * `AppUser.displayName` is one credential's per-school string, so it
     * carries ONE of that school's children: `"קורס דמיטרי [מיקה ז8]"`.
     * Persisting it raw would file every report of a multi-child household
     * under the same child's name.
     */
    it('strips the child tag from the stored display name', async () => {
      const { prisma, create } = makeMockPrisma({
        user: {
          mashovUserId: 'mashov-1',
          username: 'parent',
          displayName: 'קורס דמיטרי [מיקה ז8]',
        },
      });
      const service = new FeedbackService(prisma);

      await service.create('user-1', input());

      expect(create.mock.calls[0][0].data).toMatchObject({
        mashovUserId: 'mashov-1',
        username: 'parent',
        displayName: 'קורס דמיטרי',
      });
    });

    /**
     * `parentDisplayName('')` returns `''` and the column is NOT NULL, so a
     * household whose credential never carried a name would file every report
     * under a blank one -- unreadable in exactly the table whose point is
     * telling you who sent it.
     */
    it('falls back to the username when the parent has no display name', async () => {
      const { prisma, create } = makeMockPrisma({
        user: { mashovUserId: 'mashov-1', username: 'parent', displayName: '' },
      });
      const service = new FeedbackService(prisma);

      await service.create('user-1', input());

      expect(create.mock.calls[0][0].data.displayName).toBe('parent');
    });

    /**
     * `schoolName` is nullable -- a connection created before the login
     * response carried schoolSettings has none -- and `resolveSchoolLabels`
     * stands the semel in so a label is never blank.
     */
    it('labels a nameless school by its semel rather than leaving it blank', async () => {
      const { prisma, create } = makeMockPrisma({
        connections: [
          {
            id: 'conn-nameless',
            schoolCode: 987654,
            schoolName: null,
            displayLabel: null,
            schoolYear: 2027,
          },
        ],
      });
      const service = new FeedbackService(prisma);

      await service.create('user-1', input());

      expect(create.mock.calls[0][0].data.schoolsSnapshot).toEqual([
        {
          id: 'conn-nameless',
          schoolCode: 987654,
          schoolName: null,
          label: '987654',
          schoolYear: 2027,
        },
      ]);
    });

    it('truncates an over-long user agent rather than refusing the report', async () => {
      const { prisma, create } = makeMockPrisma({});
      const service = new FeedbackService(prisma);

      await service.create('user-1', input(), 'U'.repeat(FEEDBACK_USER_AGENT_MAX + 50));

      expect(create.mock.calls[0][0].data.userAgent).toHaveLength(FEEDBACK_USER_AGENT_MAX);
    });

    it('stores no user agent when the request carried none', async () => {
      const { prisma, create } = makeMockPrisma({});
      const service = new FeedbackService(prisma);

      await service.create('user-1', input(), undefined);

      expect(create.mock.calls[0][0].data.userAgent).toBeNull();
    });

    /**
     * Per USER, not per IP. The global ThrottlerGuard keys on IP, which would
     * lock out a whole school NAT or both parents of one household.
     */
    it('accepts the tenth report of the hour', async () => {
      const { prisma, create } = makeMockPrisma({ count: FEEDBACK_MAX_PER_HOUR - 1 });
      const service = new FeedbackService(prisma);

      await service.create('user-1', input());

      expect(create).toHaveBeenCalled();
    });

    it('refuses the eleventh report of the hour with 429', async () => {
      const { prisma, create } = makeMockPrisma({ count: FEEDBACK_MAX_PER_HOUR });
      const service = new FeedbackService(prisma);

      await expect(service.create('user-1', input())).rejects.toBeInstanceOf(HttpException);
      await expect(service.create('user-1', input())).rejects.toMatchObject({ status: 429 });
      expect(create).not.toHaveBeenCalled();
    });

    it('counts only this household and only the last hour', async () => {
      const { prisma } = makeMockPrisma({});
      const service = new FeedbackService(prisma);
      const before = Date.now();

      await service.create('user-1', input());

      const where = (prisma.feedback.count as jest.Mock).mock.calls[0][0].where;
      expect(where.userId).toBe('user-1');
      const since = where.createdAt.gte as Date;
      expect(since.getTime()).toBeGreaterThanOrEqual(before - 3_600_000);
      expect(since.getTime()).toBeLessThanOrEqual(Date.now() - 3_600_000 + 1_000);
    });

    /**
     * The client's `NEXT_PUBLIC_APP_VERSION` is inlined at build time, so a
     * build that was never given one sends nothing. The server knows its own
     * build, and a null is worse than useless here -- it is the field that
     * tells us whether the bug is still in the current release.
     */
    describe('app version', () => {
      const original = process.env.APP_VERSION;
      afterEach(() => {
        if (original === undefined) delete process.env.APP_VERSION;
        else process.env.APP_VERSION = original;
      });

      it('falls back to the version the server knows when the client sends none', async () => {
        process.env.APP_VERSION = '2026.11.23';
        const { prisma, create } = makeMockPrisma({});
        const service = new FeedbackService(prisma);

        await service.create('user-1', input());

        expect(create.mock.calls[0][0].data.appVersion).toBe('2026.11.23');
      });

      it('prefers what the client actually ran', async () => {
        process.env.APP_VERSION = '2026.11.23';
        const { prisma, create } = makeMockPrisma({});
        const service = new FeedbackService(prisma);

        await service.create('user-1', input({ appVersion: '2026.11.01' }));

        expect(create.mock.calls[0][0].data.appVersion).toBe('2026.11.01');
      });

      /**
       * `docker-compose.yml` sets `APP_VERSION: ${APP_VERSION:-}`, so on a
       * stack whose operator never set the variable the backend receives a SET
       * empty string -- which `??` passes straight through. Every row would
       * then carry `''`, and a reader filtering `appVersion IS NULL` would
       * find nothing and could not tell "unknown" from "known to be blank".
       */
      it('stores null when the environment sets an empty version', async () => {
        process.env.APP_VERSION = '';
        const { prisma, create } = makeMockPrisma({});
        const service = new FeedbackService(prisma);

        await service.create('user-1', input());

        expect(create.mock.calls[0][0].data.appVersion).toBeNull();
      });

      it('stores null when the client sends an empty version', async () => {
        delete process.env.APP_VERSION;
        const { prisma, create } = makeMockPrisma({});
        const service = new FeedbackService(prisma);

        await service.create('user-1', input({ appVersion: '' }));

        expect(create.mock.calls[0][0].data.appVersion).toBeNull();
      });

      it('stores null when neither side knows the build', async () => {
        delete process.env.APP_VERSION;
        const { prisma, create } = makeMockPrisma({});
        const service = new FeedbackService(prisma);

        await service.create('user-1', input());

        expect(create.mock.calls[0][0].data.appVersion).toBeNull();
      });
    });

    it('returns the row the parent can be told about, with no stored content echoed', async () => {
      const { prisma } = makeMockPrisma({});
      const service = new FeedbackService(prisma);

      const receipt = await service.create('user-1', input({ subject: 'timetable' }));

      expect(receipt).toEqual({
        id: 'feedback-1',
        subject: 'timetable',
        createdAt: new Date(0).toISOString(),
      });
    });

    it('rejects a report from a household that no longer exists', async () => {
      const { prisma, create } = makeMockPrisma({ user: null });
      const service = new FeedbackService(prisma);

      await expect(service.create('ghost', input())).rejects.toMatchObject({ status: 401 });
      expect(create).not.toHaveBeenCalled();
    });
  });
});
