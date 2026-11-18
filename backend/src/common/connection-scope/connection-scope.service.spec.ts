import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../session/encryption.service';
import { ConnectionScopeService } from './connection-scope.service';

interface ConnRow {
  id: string;
  schoolCode: number;
  schoolYear: number;
  username: string;
  encryptedPassword: string;
  schoolName: string | null;
  active: boolean;
  userId: string | null;
  lastLoginAt: Date | null;
}

function conn(overrides: Partial<ConnRow> = {}): ConnRow {
  return {
    id: 'conn-a',
    schoolCode: 540175,
    schoolYear: 2026,
    username: 'parent-a',
    encryptedPassword: 'enc:pw-a',
    schoolName: 'אורט רמון',
    active: true,
    userId: 'user-1',
    lastLoginAt: new Date('2026-11-17T10:00:00Z'),
    ...overrides,
  };
}

/**
 * An in-memory stand-in for the three tables this service reads. Hand-rolled
 * rather than mocked call-by-call because the fallback behaviour is the whole
 * point: a NULL stamp has to resolve to *something*, and asserting that means
 * letting the service run its real second query.
 */
function makePrisma(state: {
  connections?: ConnRow[];
  students?: Array<{ studentGuid: string; householdConnectionId: string | null }>;
  conversations?: Array<{ conversationId: string; householdConnectionId: string | null }>;
  messages?: Array<{ messageId: string; householdConnectionId: string | null }>;
}) {
  const connections = state.connections ?? [];
  const students = state.students ?? [];
  const conversations = state.conversations ?? [];
  const messages = state.messages ?? [];

  const matches = (row: ConnRow, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'active') return row.active === value;
      if (key === 'userId') return row.userId === value;
      if (key === 'id') return row.id === value;
      return true;
    });

  const studentUpdate = jest.fn();

  return {
    prisma: {
      householdConnection: {
        findMany: jest.fn(({ where } = {}) =>
          Promise.resolve(
            connections
              .filter((row) => matches(row, where))
              .sort(
                (a, b) => (b.lastLoginAt?.getTime() ?? 0) - (a.lastLoginAt?.getTime() ?? 0),
              ),
          ),
        ),
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(connections.find((row) => row.id === where.id) ?? null),
        ),
        findFirst: jest.fn(({ where } = {}) =>
          Promise.resolve(
            connections
              .filter((row) => matches(row, where))
              .sort(
                (a, b) => (b.lastLoginAt?.getTime() ?? 0) - (a.lastLoginAt?.getTime() ?? 0),
              )[0] ?? null,
          ),
        ),
      },
      student: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(students.find((row) => row.studentGuid === where.studentGuid) ?? null),
        ),
        findMany: jest.fn(({ where } = {}) => {
          const ids: string[] | undefined = where?.householdConnectionId?.in;
          return Promise.resolve(
            ids === undefined
              ? students
              : students.filter(
                  (row) => row.householdConnectionId && ids.includes(row.householdConnectionId),
                ),
          );
        }),
        update: studentUpdate.mockResolvedValue(undefined),
      },
      mailConversation: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(
            conversations.find((row) => row.conversationId === where.conversationId) ?? null,
          ),
        ),
        findMany: jest.fn(({ where } = {}) => {
          const ids: string[] = where?.conversationId?.in ?? [];
          return Promise.resolve(conversations.filter((row) => ids.includes(row.conversationId)));
        }),
      },
      mailMessage: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(messages.find((row) => row.messageId === where.messageId) ?? null),
        ),
      },
    } as unknown as PrismaService,
    studentUpdate,
  };
}

const encryption = {
  decrypt: (value: string) => value.replace(/^enc:/, ''),
} as unknown as EncryptionService;

describe('ConnectionScopeService', () => {
  describe('targetForStudent', () => {
    it("returns the stamped connection's target with the password decrypted", async () => {
      const { prisma } = makePrisma({
        connections: [conn(), conn({ id: 'conn-b', schoolCode: 999999, username: 'parent-b' })],
        students: [{ studentGuid: 'guid-1', householdConnectionId: 'conn-a' }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetForStudent('guid-1')).resolves.toEqual({
        id: 'conn-a',
        schoolCode: 540175,
        schoolYear: 2026,
        username: 'parent-a',
        password: 'pw-a',
        schoolName: 'אורט רמון',
      });
    });

    it('falls back to the most recently used active connection when the stamp is NULL', async () => {
      // NULL means "ownership unknown", not "no owner" — the shared env-session
      // path writes unowned rows and the backfill refuses to guess above one
      // connection. Throwing here would take a single-school deployment that
      // never ran the backfill from working to broken.
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-old', lastLoginAt: new Date('2026-01-01T00:00:00Z') }),
          conn({
            id: 'conn-recent',
            username: 'parent-b',
            lastLoginAt: new Date('2026-11-18T00:00:00Z'),
          }),
        ],
        students: [{ studentGuid: 'guid-1', householdConnectionId: null }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetForStudent('guid-1')).resolves.toMatchObject({
        id: 'conn-recent',
      });
    });

    it('falls back when the stamped connection has gone away', async () => {
      const { prisma } = makePrisma({
        connections: [conn({ id: 'conn-live' })],
        students: [{ studentGuid: 'guid-1', householdConnectionId: 'conn-deleted' }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetForStudent('guid-1')).resolves.toMatchObject({
        id: 'conn-live',
      });
    });

    it('throws when there is no connection to fall back to', async () => {
      const { prisma } = makePrisma({
        students: [{ studentGuid: 'guid-1', householdConnectionId: null }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetForStudent('guid-1')).rejects.toThrow(/no active connection/i);
    });

    it('throws for a student that does not exist', async () => {
      const { prisma } = makePrisma({ connections: [conn()] });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetForStudent('nope')).rejects.toThrow(/nope/);
    });
  });

  describe('targetFor', () => {
    it('throws for an unknown id', async () => {
      const { prisma } = makePrisma({ connections: [conn()] });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetFor('conn-missing')).rejects.toThrow(/conn-missing/);
    });

    it('throws for an inactive connection', async () => {
      // A deactivated connection's credentials are no longer trusted to talk
      // upstream; silently using them would resurrect a school the parent
      // unlinked.
      const { prisma } = makePrisma({ connections: [conn({ active: false })] });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetFor('conn-a')).rejects.toThrow(/inactive/i);
    });
  });

  describe('targetForConversation and targetForMessage', () => {
    it('resolves a conversation and a message to their own connection', async () => {
      const { prisma } = makePrisma({
        connections: [conn(), conn({ id: 'conn-b', username: 'parent-b', schoolCode: 999999 })],
        conversations: [{ conversationId: 'conv-1', householdConnectionId: 'conn-b' }],
        messages: [{ messageId: 'msg-1', householdConnectionId: 'conn-b' }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetForConversation('conv-1')).resolves.toMatchObject({ id: 'conn-b' });
      await expect(service.targetForMessage('msg-1')).resolves.toMatchObject({ id: 'conn-b' });
    });

    it('falls back for an unstamped conversation', async () => {
      const { prisma } = makePrisma({
        connections: [conn()],
        conversations: [{ conversationId: 'conv-1', householdConnectionId: null }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.targetForConversation('conv-1')).resolves.toMatchObject({
        id: 'conn-a',
      });
    });
  });

  describe('groupConversationsByConnection', () => {
    it('splits a mixed list into one entry per connection', async () => {
      const { prisma } = makePrisma({
        conversations: [
          { conversationId: 'c1', householdConnectionId: 'conn-a' },
          { conversationId: 'c2', householdConnectionId: 'conn-b' },
          { conversationId: 'c3', householdConnectionId: 'conn-a' },
        ],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      const grouped = await service.groupConversationsByConnection(['c1', 'c2', 'c3']);

      expect([...grouped.keys()].sort()).toEqual(['conn-a', 'conn-b']);
      expect(grouped.get('conn-a')).toEqual(['c1', 'c3']);
      expect(grouped.get('conn-b')).toEqual(['c2']);
    });

    it('drops ids with no row and groups unstamped ones under null', async () => {
      // An unstamped conversation still has to be actionable: before the
      // backfill runs, every row is unstamped, and dropping them would make
      // archive silently do nothing.
      const { prisma } = makePrisma({
        conversations: [
          { conversationId: 'c1', householdConnectionId: null },
          { conversationId: 'c2', householdConnectionId: 'conn-a' },
        ],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      const grouped = await service.groupConversationsByConnection(['c1', 'c2', 'gone']);

      expect(grouped.get(null)).toEqual(['c1']);
      expect(grouped.get('conn-a')).toEqual(['c2']);
      expect(grouped.has('gone')).toBe(false);
    });
  });

  describe('studentGuidsForUser', () => {
    it("returns only the children of that user's connections", async () => {
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-a', userId: 'user-1' }),
          conn({ id: 'conn-b', userId: 'user-1', username: 'parent-b' }),
          conn({ id: 'conn-other', userId: 'user-2', username: 'parent-c' }),
        ],
        students: [
          { studentGuid: 'mine-1', householdConnectionId: 'conn-a' },
          { studentGuid: 'mine-2', householdConnectionId: 'conn-b' },
          { studentGuid: 'theirs', householdConnectionId: 'conn-other' },
        ],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      const guids = await service.studentGuidsForUser('user-1');

      expect(guids.sort()).toEqual(['mine-1', 'mine-2']);
      expect(guids).not.toContain('theirs');
    });

    it('returns an empty list for a user with no connection', async () => {
      // Not "every student": an empty list is what makes the caller render an
      // empty state instead of another household's children.
      const { prisma } = makePrisma({
        connections: [conn({ userId: 'user-2' })],
        students: [{ studentGuid: 'theirs', householdConnectionId: 'conn-a' }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.studentGuidsForUser('user-1')).resolves.toEqual([]);
    });
  });

  describe('listTargets', () => {
    it('excludes inactive connections and other users', async () => {
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-a', userId: 'user-1' }),
          conn({ id: 'conn-off', userId: 'user-1', username: 'parent-b', active: false }),
          conn({ id: 'conn-other', userId: 'user-2', username: 'parent-c' }),
        ],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      const targets = await service.listTargets('user-1');

      expect(targets.map((target) => target.id)).toEqual(['conn-a']);
    });

    it('lists every active connection when given no user', async () => {
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-a', userId: 'user-1' }),
          conn({ id: 'conn-other', userId: 'user-2', username: 'parent-c' }),
        ],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await expect(service.listTargets()).resolves.toHaveLength(2);
    });

    it('skips a connection whose password will not decrypt rather than failing the batch', async () => {
      // One corrupt ENCRYPTION_KEY rotation must not take the other school's
      // sync down with it.
      const { prisma } = makePrisma({
        connections: [
          conn({ id: 'conn-bad', encryptedPassword: 'not-decryptable' }),
          conn({ id: 'conn-good', username: 'parent-b' }),
        ],
      });
      const throwing = {
        decrypt: (value: string) => {
          if (value === 'not-decryptable') throw new Error('bad key');
          return value.replace(/^enc:/, '');
        },
      } as unknown as EncryptionService;
      const service = new ConnectionScopeService(prisma, throwing);

      const targets = await service.listTargets();

      expect(targets.map((target) => target.id)).toEqual(['conn-good']);
    });
  });

  describe('stampStudent', () => {
    it('writes the ownership stamp', async () => {
      const { prisma, studentUpdate } = makePrisma({
        students: [{ studentGuid: 'guid-1', householdConnectionId: null }],
      });
      const service = new ConnectionScopeService(prisma, encryption);

      await service.stampStudent('guid-1', 'conn-a');

      expect(studentUpdate).toHaveBeenCalledWith({
        where: { studentGuid: 'guid-1' },
        data: { householdConnectionId: 'conn-a' },
      });
    });
  });
});
