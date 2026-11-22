import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DigestRecipientService } from './digest-recipient.service';
import type { PrismaService } from '../prisma/prisma.service';

const RECIPIENT = {
  id: 'rec-1',
  userId: 'user-1',
  studentGuid: 'stu-1',
  channel: 'telegram',
  address: '12345',
  displayName: 'אמא',
  enabled: true,
  activeFrom: new Date('2026-11-17T00:00:00Z'),
};

function makeHarness(
  options: {
    roster?: string[];
    existing?: unknown;
    /** studentGuid -> the connections that list the child. */
    links?: { studentGuid: string; householdConnectionId: string }[];
    /** The caller's own active connections. */
    connections?: string[];
    /** Per-user active connections, for the two-user cases. */
    connectionsByUser?: Record<string, string[]>;
    /** The rows `listDeliveryTargets` reads back. */
    recipientRows?: {
      studentGuid: string;
      activeFrom: Date;
      userId: string;
      enabled?: boolean;
    }[];
  } = {},
) {
  const roster = options.roster ?? ['stu-1'];
  // Visibility is the link set, not the routing stamp (ADR-0031). By default
  // the child under test is one the caller can see.
  const links = options.links ?? [{ studentGuid: 'stu-1', householdConnectionId: 'conn-1' }];
  const connections = options.connections ?? ['conn-1'];
  // `?? RECIPIENT` would defeat the point: null is the case under test.
  const existing = 'existing' in options ? options.existing : RECIPIENT;
  const prisma = {
    studentConnection: {
      // Honours both shapes the helpers use: one child (`canSeeStudent`,
      // `ownsStudentForDelivery`) and a batch (`linksForStudents`).
      findMany: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { studentGuid: string | { in: string[] } } }) => {
            const wanted = where.studentGuid;
            const match =
              typeof wanted === 'string'
                ? (guid: string) => guid === wanted
                : (guid: string) => wanted.in.includes(guid);
            return links.filter((link) => match(link.studentGuid));
          },
        ),
    },
    householdConnection: {
      // Honours `where.userId`, as Postgres would: a mock that answers the
      // same connection set for every user would report the per-user ownership
      // guard as working when it is reading somebody else's connections.
      findMany: jest.fn().mockImplementation(({ where }: { where: { userId: string } }) => {
        const ids = options.connectionsByUser?.[where.userId] ?? connections;
        return ids.map((id) => ({ id }));
      }),
    },
    student: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where?: { studentGuid?: { in: string[] } } }) =>
          roster
            .filter((guid) => where?.studentGuid?.in?.includes(guid) ?? true)
            .map((studentGuid) => ({ studentGuid })),
        ),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { studentGuid: string } }) =>
          roster.includes(where.studentGuid) ? { studentGuid: where.studentGuid } : null,
        ),
    },
    digestRecipient: {
      create: jest.fn().mockResolvedValue(RECIPIENT),
      // Honours `where.userId` and `where.enabled`, as Postgres would.
      findMany: jest
        .fn()
        .mockImplementation(
          ({ where }: { where?: { userId?: string; enabled?: boolean } } = {}) =>
            (options.recipientRows ?? [RECIPIENT]).filter(
              (row) =>
                (where?.userId === undefined || row.userId === where.userId) &&
                (where?.enabled === undefined || (row.enabled ?? true) === where.enabled),
            ),
        ),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue({ ...RECIPIENT, enabled: false }),
      delete: jest.fn().mockResolvedValue(RECIPIENT),
    },
    digestDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  } as unknown as PrismaService;

  return { prisma, service: new DigestRecipientService(prisma) };
}

describe('DigestRecipientService', () => {
  it('creates a recipient for a child on the active roster', async () => {
    const harness = makeHarness();

    const created = await harness.service.create('user-1', {
      studentGuid: 'stu-1',
      channel: 'telegram',
      address: '12345',
      displayName: 'אמא',
    });

    expect(created).toMatchObject({ studentGuid: 'stu-1', channel: 'telegram' });
    expect((harness.prisma.digestRecipient.create as jest.Mock).mock.calls[0][0].data.userId).toBe(
      'user-1',
    );
  });

  it('refuses a studentGuid that is not on the active roster', async () => {
    const harness = makeHarness({ roster: ['other-child'] });

    await expect(
      harness.service.create('user-1', {
        studentGuid: 'stu-1',
        channel: 'telegram',
        address: '12345',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(harness.prisma.digestRecipient.create).not.toHaveBeenCalled();
  });

  it('refuses a child on the roster that the caller cannot see', async () => {
    // The roster check alone was ADR-0026's accepted hole: it let one parent
    // point another family's child at their own Telegram chat. A UI creates
    // these rows now, so visibility is checked, not just roster membership.
    const harness = makeHarness({
      links: [{ studentGuid: 'stu-1', householdConnectionId: 'someone-elses-conn' }],
      connections: ['conn-1'],
    });

    await expect(
      harness.service.create('user-1', {
        studentGuid: 'stu-1',
        channel: 'telegram',
        address: '12345',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(harness.prisma.digestRecipient.create).not.toHaveBeenCalled();
  });

  it('refuses a child no connection lists yet', async () => {
    // The read side admits an unattributed child, and must: "ownership
    // unknown" means "link on the next roster refresh", and excluding them
    // would empty the app on a roster that has not been attributed. This is a
    // write that starts pushing that child's conduct record to a messaging
    // app, so it fails the other way round -- otherwise any authenticated
    // parent could point an unattributed child's digests at their own phone.
    // Hence ownsStudentForDelivery rather than canSeeStudent.
    const harness = makeHarness({ links: [] });

    await expect(
      harness.service.create('user-1', {
        studentGuid: 'stu-1',
        channel: 'telegram',
        address: '12345',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(harness.prisma.digestRecipient.create).not.toHaveBeenCalled();
  });

  it('refuses a channel it has no sender for', async () => {
    const harness = makeHarness();

    await expect(
      harness.service.create('user-1', {
        studentGuid: 'stu-1',
        channel: 'carrier-pigeon',
        address: '12345',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses an empty address', async () => {
    const harness = makeHarness();

    await expect(
      harness.service.create('user-1', {
        studentGuid: 'stu-1',
        channel: 'telegram',
        address: '   ',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists the recipients for one child', async () => {
    const harness = makeHarness();

    const listed = await harness.service.list({ userId: 'user-1', studentGuid: 'stu-1' });

    expect(listed.data).toHaveLength(1);
    expect((harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject(
      { studentGuid: 'stu-1', userId: 'user-1' },
    );
  });

  it('lists everything the caller is subscribed to when no child is named', async () => {
    // The /more card asks "what am I subscribed to" without naming a child, so
    // the studentGuid filter has to be omittable rather than required.
    const harness = makeHarness();

    await harness.service.list({ userId: 'user-1' });

    const where = (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toEqual({ userId: 'user-1' });
  });

  it('answers with the pagination envelope the API rules require', async () => {
    // `.claude/rules/api.md`: a list route is always paginated and never
    // returns an unbounded list. This one was the exception, and a household
    // that accumulates recipient rows over years is exactly who pays for it.
    const harness = makeHarness();
    (harness.prisma.digestRecipient.count as jest.Mock).mockResolvedValue(43);

    const listed = await harness.service.list({ userId: 'user-1' });

    expect(listed.pagination).toEqual({ page: 1, limit: 20, total: 43, totalPages: 3 });
  });

  it('skips and takes the page it was asked for', async () => {
    const harness = makeHarness();

    await harness.service.list({ userId: 'user-1', page: 3, limit: 10 });

    const args = (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
  });

  it('counts only the caller’s own rows, not every household’s', async () => {
    const harness = makeHarness();

    await harness.service.list({ userId: 'user-1', studentGuid: 'stu-1' });

    expect((harness.prisma.digestRecipient.count as jest.Mock).mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      studentGuid: 'stu-1',
    });
  });

  it('updates the enabled flag', async () => {
    const harness = makeHarness();

    const updated = await harness.service.update('rec-1', { enabled: false }, 'user-1');

    expect(updated.enabled).toBe(false);
  });

  it('reports a missing recipient rather than updating nothing', async () => {
    const harness = makeHarness({ existing: null });

    await expect(harness.service.update('rec-404', { enabled: false }, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deletes a recipient', async () => {
    const harness = makeHarness();

    await harness.service.remove('rec-1', 'user-1');

    expect(harness.prisma.digestRecipient.delete).toHaveBeenCalledWith({ where: { id: 'rec-1' } });
  });

  it('reports a missing recipient rather than deleting nothing', async () => {
    const harness = makeHarness({ existing: null });

    await expect(harness.service.remove('rec-404', 'user-1')).rejects.toThrow(NotFoundException);
  });


  it('refuses to change a recipient another user created', async () => {
    // There is no child -> parent FK to validate against, but every row records
    // who created it, so at least one household cannot silently disable
    // another household's digest.
    const harness = makeHarness({ existing: { ...RECIPIENT, userId: 'someone-else' } });

    await expect(harness.service.update('rec-1', { enabled: false }, 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(harness.prisma.digestRecipient.update).not.toHaveBeenCalled();
  });

  it('refuses to delete a recipient another user created', async () => {
    const harness = makeHarness({ existing: { ...RECIPIENT, userId: 'someone-else' } });

    await expect(harness.service.remove('rec-1', 'user-1')).rejects.toThrow(ForbiddenException);
    expect(harness.prisma.digestRecipient.delete).not.toHaveBeenCalled();
  });

  it('lists only the recipients the caller created for that child', async () => {
    const harness = makeHarness();

    await harness.service.list({ userId: 'user-1', studentGuid: 'stu-1' });

    expect(
      (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ studentGuid: 'stu-1', userId: 'user-1' });
  });

  it('scopes delivery history to the runs made for the caller, not for their child', async () => {
    // A delivery row holds messageText -- the rendered behavior remarks, and
    // the caller's own unanswered consent forms, that were sent to one parent.
    // Scoping by child let the second parent of a shared child read the first
    // parent's message; the run now writes whose run it was, so the scope is
    // that.
    const harness = makeHarness();

    await harness.service.listDeliveries('user-1', {});

    const where = (harness.prisma.digestDelivery.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toEqual({ userId: 'user-1' });
    expect(where.studentGuid).toBeUndefined();
  });

  it('narrows delivery history to one child without widening past the caller', async () => {
    const harness = makeHarness();

    await harness.service.listDeliveries('user-1', { studentGuid: 'stu-1' });

    expect((harness.prisma.digestDelivery.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      studentGuid: 'stu-1',
    });
  });

  it('returns no history at all for a user with no runs', async () => {
    const harness = makeHarness();

    const page = await harness.service.listDeliveries('user-1', {});

    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
  });

  it('lists the children that have at least one enabled recipient', async () => {
    // This is what the cron iterates: delivery is strictly opt-in, so a child
    // with no enabled recipient is never collected for and never summarized.
    const harness = makeHarness();

    const { targets } = await harness.service.listDeliveryTargets();

    expect(targets).toEqual([
      {
        studentGuid: 'stu-1',
        activeFrom: RECIPIENT.activeFrom,
        recipientCount: 1,
        // Carried so the digest knows whose consent forms to report: they are
        // household-scoped, unlike everything else in the message.
        userId: RECIPIENT.userId,
      },
    ]);
    // The cron runs every opted-in child, so it must not filter by user.
    expect(
      (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where.userId,
    ).toBeUndefined();
  });

  it('narrows the target list to one user when a manual run names them', async () => {
    const harness = makeHarness();

    await harness.service.listDeliveryTargets('user-1');

    expect(
      (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ enabled: true, userId: 'user-1' });
  });

  it('returns one target per subscribing user for a child two parents share', async () => {
    // One target per child meant one run, one dedup ledger and one message for
    // a child both parents subscribe to -- so the message carried whichever
    // parent's consent forms the earliest row pointed at, and the other parent
    // was told forms were awaiting their answer that were not theirs.
    const harness = makeHarness({
      recipientRows: [
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'user-1' },
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-10T00:00:00Z'), userId: 'user-2' },
      ],
      connectionsByUser: { 'user-1': ['conn-1'], 'user-2': ['conn-1'] },
    });

    const { targets } = await harness.service.listDeliveryTargets();

    expect(targets).toEqual([
      {
        studentGuid: 'stu-1',
        activeFrom: new Date('2026-11-01T00:00:00Z'),
        recipientCount: 1,
        userId: 'user-1',
      },
      {
        studentGuid: 'stu-1',
        activeFrom: new Date('2026-11-10T00:00:00Z'),
        recipientCount: 1,
        userId: 'user-2',
      },
    ]);
  });

  it('takes each user’s own earliest activeFrom, not the household’s', async () => {
    // The earliest row used to set the cutoff for everybody, so a parent who
    // subscribed in November was sent September's items because the other
    // parent had subscribed then.
    const harness = makeHarness({
      recipientRows: [
        { studentGuid: 'stu-1', activeFrom: new Date('2026-09-01T00:00:00Z'), userId: 'user-1' },
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-10T00:00:00Z'), userId: 'user-2' },
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-20T00:00:00Z'), userId: 'user-2' },
      ],
      connectionsByUser: { 'user-1': ['conn-1'], 'user-2': ['conn-1'] },
    });

    const { targets } = await harness.service.listDeliveryTargets();

    const second = targets.find((target) => target.userId === 'user-2');
    expect(second).toEqual({
      studentGuid: 'stu-1',
      activeFrom: new Date('2026-11-10T00:00:00Z'),
      recipientCount: 2,
      userId: 'user-2',
    });
  });

  it('drops a target whose child the subscribing user no longer owns', async () => {
    // The adoption path repoints a HouseholdConnection to another AppUser and
    // leaves the old owner's recipient rows behind, so a row alone cannot be
    // trusted at send time. Checked here rather than in the orchestrator, so
    // the cron and the manual run both get it.
    const harness = makeHarness({
      recipientRows: [
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'user-1' },
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'ex-owner' },
      ],
      connectionsByUser: { 'user-1': ['conn-1'], 'ex-owner': [] },
    });

    const { targets } = await harness.service.listDeliveryTargets();

    expect(targets.map((target) => target.userId)).toEqual(['user-1']);
  });

  it('drops a target whose child has been retired from the roster', async () => {
    // RosterPresenceService sets isActive false when a child stops appearing.
    // A stale recipient row must not keep a retired child's digest running.
    const harness = makeHarness({ roster: [] });

    expect((await harness.service.listDeliveryTargets()).targets).toEqual([]);
  });

  it('drops a target for a child no connection lists at all', async () => {
    // ownsStudentForDelivery, not canSeeStudent: an unattributed child belongs
    // to nobody until a roster refresh says otherwise, and the cost of being
    // wrong here is another family's conduct reports on a stranger's phone.
    const harness = makeHarness({ links: [] });

    expect((await harness.service.listDeliveryTargets()).targets).toEqual([]);
  });

  it('reports the targets it dropped, and why', async () => {
    // A dropped target is a digest that has silently stopped. Every other way
    // a run stops writes a `digest_delivery` row -- that is what makes a quiet
    // child distinguishable from a broken job -- so the orchestrator has to be
    // told which targets went and for what reason.
    const harness = makeHarness({
      recipientRows: [
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'user-1' },
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'ex-owner' },
        { studentGuid: 'gone', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'user-1' },
      ],
      connectionsByUser: { 'user-1': ['conn-1'], 'ex-owner': [] },
      roster: ['stu-1'],
      links: [
        { studentGuid: 'stu-1', householdConnectionId: 'conn-1' },
        { studentGuid: 'gone', householdConnectionId: 'conn-1' },
      ],
    });

    const { targets, skipped } = await harness.service.listDeliveryTargets();

    expect(targets.map((target) => [target.userId, target.studentGuid])).toEqual([
      ['user-1', 'stu-1'],
    ]);
    expect(skipped.map((entry) => [entry.userId, entry.studentGuid])).toEqual([
      ['ex-owner', 'stu-1'],
      ['user-1', 'gone'],
    ]);
    expect(skipped[0].reason).toMatch(/no longer owns/i);
    expect(skipped[1].reason).toMatch(/roster/i);
  });

  it('reads each user’s connections once, not once per target', async () => {
    // Two queries per target would be 2N queries on a cron that already runs
    // seven times a day; the helpers answer in batch.
    const harness = makeHarness({
      recipientRows: [
        { studentGuid: 'stu-1', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'user-1' },
        { studentGuid: 'stu-2', activeFrom: new Date('2026-11-01T00:00:00Z'), userId: 'user-1' },
      ],
      roster: ['stu-1', 'stu-2'],
      links: [
        { studentGuid: 'stu-1', householdConnectionId: 'conn-1' },
        { studentGuid: 'stu-2', householdConnectionId: 'conn-1' },
      ],
    });

    const { targets } = await harness.service.listDeliveryTargets();

    expect(targets).toHaveLength(2);
    expect(harness.prisma.householdConnection.findMany).toHaveBeenCalledTimes(1);
    expect(harness.prisma.studentConnection.findMany).toHaveBeenCalledTimes(1);
  });
});
