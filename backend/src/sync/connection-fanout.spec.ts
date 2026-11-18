import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { orderConnectionsForStudent, stampOwnershipIfChanged } from './connection-fanout';

const CONN_A = { id: 'conn-a', schoolCode: 540175, schoolYear: 2026 };
const CONN_B = { id: 'conn-b', schoolCode: 999999, schoolYear: 2027 };
const CONN_C = { id: 'conn-c', schoolCode: 111111, schoolYear: 2026 };

describe('orderConnectionsForStudent', () => {
  it('puts the stamped owner first', () => {
    // The point of the whole exercise: with two schools, trying them in table
    // order means one guaranteed 403 per student per run across ten tasks
    // before the right connection is reached -- plausible rate-limit
    // territory against an upstream that has none of our patience.
    const ordered = orderConnectionsForStudent(
      { studentGuid: 'guid-1', householdConnectionId: 'conn-b' },
      [CONN_A, CONN_B, CONN_C],
    );

    expect(ordered.map((conn) => conn.id)).toEqual(['conn-b', 'conn-a', 'conn-c']);
  });

  it('preserves the input order for an unstamped student', () => {
    // An unstamped row must behave exactly as it does today: the fallback is
    // "try everything", and reordering it would change behaviour on a
    // deployment whose backfill has not run.
    const ordered = orderConnectionsForStudent(
      { studentGuid: 'guid-1', householdConnectionId: null },
      [CONN_A, CONN_B, CONN_C],
    );

    expect(ordered.map((conn) => conn.id)).toEqual(['conn-a', 'conn-b', 'conn-c']);
  });

  it('preserves the input order when the stamp names a connection that is not in the list', () => {
    const ordered = orderConnectionsForStudent(
      { studentGuid: 'guid-1', householdConnectionId: 'conn-gone' },
      [CONN_A, CONN_B],
    );

    expect(ordered.map((conn) => conn.id)).toEqual(['conn-a', 'conn-b']);
  });

  it('keeps every connection, so the fallback is never narrowed', () => {
    // Ordering, never filtering. A stamp can be stale -- a child who moved
    // school -- and dropping the others would turn a recoverable wrong guess
    // into a permanently failing student.
    const ordered = orderConnectionsForStudent(
      { studentGuid: 'guid-1', householdConnectionId: 'conn-c' },
      [CONN_A, CONN_B, CONN_C],
    );

    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((conn) => conn.id))).toEqual(
      new Set(['conn-a', 'conn-b', 'conn-c']),
    );
  });

  it('does not mutate the caller\'s array', () => {
    const connections = [CONN_A, CONN_B];
    orderConnectionsForStudent(
      { studentGuid: 'guid-1', householdConnectionId: 'conn-b' },
      connections,
    );

    expect(connections.map((conn) => conn.id)).toEqual(['conn-a', 'conn-b']);
  });

  it('returns an empty list unchanged', () => {
    expect(
      orderConnectionsForStudent({ studentGuid: 'g', householdConnectionId: 'conn-a' }, []),
    ).toEqual([]);
  });
});

describe('stampOwnershipIfChanged', () => {
  function makePrisma() {
    const update = jest.fn().mockResolvedValue({});
    return {
      prisma: { student: { update } } as unknown as PrismaService,
      update,
    };
  }

  const logger = new Logger('test');

  it('writes the stamp when a student had none', async () => {
    const { prisma, update } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: null },
      CONN_A,
      logger,
    );

    expect(update).toHaveBeenCalledWith({
      where: { studentGuid: 'guid-1' },
      data: { householdConnectionId: 'conn-a' },
    });
  });

  it('writes nothing when the stamp already matches', async () => {
    // Called once per student per task per run -- ten tasks every twelve
    // minutes. An unconditional write would be a pointless UPDATE storm and
    // would churn updatedAt on every pass.
    const { prisma, update } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: 'conn-a' },
      CONN_A,
      logger,
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('re-stamps and warns when another connection answered', async () => {
    const { prisma, update } = makePrisma();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: 'conn-a' },
      CONN_B,
      logger,
    );

    expect(update).toHaveBeenCalledWith({
      where: { studentGuid: 'guid-1' },
      data: { householdConnectionId: 'conn-b' },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('guid-1'));
    warn.mockRestore();
  });

  it('does not warn when it is filling in a missing stamp', async () => {
    // Not a move -- just ownership becoming known. Warning here would make
    // the first sync after the migration shout once per child.
    const { prisma } = makePrisma();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: null },
      CONN_A,
      logger,
    );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows a write failure rather than failing the student', async () => {
    // The stamp is an optimisation plus an isolation key, not the payload.
    // Losing it costs one extra upstream call next run; throwing here would
    // turn a successful homework fetch into a failed sync run.
    const update = jest.fn().mockRejectedValue(new Error('deadlock detected'));
    const prisma = { student: { update } } as unknown as PrismaService;

    await expect(
      stampOwnershipIfChanged(
        prisma,
        { studentGuid: 'guid-1', householdConnectionId: null },
        CONN_A,
        logger,
      ),
    ).resolves.toBeUndefined();
  });
});
