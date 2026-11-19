import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  orderConnectionsForStudent,
  stampOwnershipIfChanged,
  studentScopeForContext,
} from './connection-fanout';

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
    const linkUpsert = jest.fn().mockResolvedValue({});
    return {
      prisma: {
        student: { update },
        studentConnection: { upsert: linkUpsert },
      } as unknown as PrismaService,
      update,
      linkUpsert,
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

  it('grants the answering connection a view when it takes the stamp', async () => {
    // A non-empty response from this connection is proof the account knows the
    // child, which is exactly what a visibility link records (ADR-0031). It
    // also closes the window where a child the backfill never reached is
    // stamped but unlinked.
    const { prisma, linkUpsert } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: null },
      CONN_A,
      logger,
    );

    expect(linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          studentGuid_householdConnectionId: {
            studentGuid: 'guid-1',
            householdConnectionId: 'conn-a',
          },
        },
      }),
    );
  });

  it('writes no link when the stamp already matches', async () => {
    // Ten tasks per student every twelve minutes. The link is a set that the
    // login roster maintains; re-asserting it on every successful fetch would
    // be an UPDATE storm for no new information.
    const { prisma, linkUpsert } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: 'conn-a' },
      CONN_A,
      logger,
    );

    expect(linkUpsert).not.toHaveBeenCalled();
  });

  it('grants no view on an empty response', async () => {
    const { prisma, linkUpsert } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: null },
      CONN_A,
      logger,
      false,
    );

    expect(linkUpsert).not.toHaveBeenCalled();
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

describe('stampOwnershipIfChanged evidence requirement', () => {
  /**
   * A `200 []` is not proof a child belongs to an account.
   *
   * At least one of the eleven per-student endpoints plausibly answers with an
   * empty array rather than a 403 for a guid outside the account. Treating
   * that as proof lets the wrong school claim a child the moment the right
   * school's password goes stale -- and the claim cascades: the year written
   * becomes the claimant's, so the child's rows fall outside their own school's
   * year scope; the chip names the wrong school; release writes route to the
   * wrong Mashov account; and on a shared deployment the claiming household
   * gains read access to that child.
   */
  const logger = new Logger('test');

  function makePrisma() {
    const update = jest.fn().mockResolvedValue({});
    return { prisma: { student: { update } } as unknown as PrismaService, update };
  }

  it('does not claim a child on an empty response', async () => {
    const { prisma, update } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: 'conn-a' },
      CONN_B,
      logger,
      false,
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('does not even fill in a missing stamp without evidence', async () => {
    // A first attribution from an empty payload is the same guess, just
    // without a previous owner to contradict it.
    const { prisma, update } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: null },
      CONN_B,
      logger,
      false,
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('claims the child when the response carried data', async () => {
    const { prisma, update } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: null },
      CONN_B,
      logger,
      true,
    );

    expect(update).toHaveBeenCalledWith({
      where: { studentGuid: 'guid-1' },
      data: { householdConnectionId: 'conn-b' },
    });
  });

  it('defaults to claiming, for the roster path that has no payload to judge', async () => {
    // The login response IS the evidence there, so the caller has nothing to
    // pass and must keep its previous behaviour.
    const { prisma, update } = makePrisma();

    await stampOwnershipIfChanged(
      prisma,
      { studentGuid: 'guid-1', householdConnectionId: null },
      CONN_B,
      logger,
    );

    expect(update).toHaveBeenCalled();
  });
});

describe('studentScopeForContext', () => {
  it('keeps every active child when no connection is named', () => {
    // The @Cron path. It passes no connectionId and must still sweep the whole
    // table, or the global cycle stops fetching for anybody.
    expect(studentScopeForContext({})).toEqual({ isActive: true });
  });

  it("narrows to the refreshing connection's children when one is named", () => {
    // The minor this exists for: a refresh scoped to school A used to ask A's
    // Mashov account about school B's children, collect a 403 each, and report
    // `partial` for a school that synced perfectly.
    expect(studentScopeForContext({ connectionId: 'conn-a' })).toEqual({
      isActive: true,
      OR: [
        { links: { some: { householdConnectionId: 'conn-a' } } },
        { links: { none: {} } },
      ],
    });
  });

  it('still admits a child no connection lists', () => {
    // ADR-0031's deliberate edge: no links means "ownership unknown, link on
    // the next roster refresh", not "nobody's". Excluding them would stop
    // fetching for every child on a deployment whose backfill has not run.
    const scope = studentScopeForContext({ connectionId: 'conn-a' }) as {
      OR: Array<Record<string, unknown>>;
    };

    expect(scope.OR).toContainEqual({ links: { none: {} } });
  });

  it('ignores a schoolYear-only context', () => {
    // The school-year rollover path sets schoolYear and no connection, so it
    // must keep the whole table exactly as the cron does.
    expect(studentScopeForContext({ schoolYear: 2027 })).toEqual({ isActive: true });
  });
});
