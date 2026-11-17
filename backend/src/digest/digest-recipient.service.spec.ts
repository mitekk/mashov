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

function makeHarness(options: { roster?: string[]; existing?: unknown } = {}) {
  const roster = options.roster ?? ['stu-1'];
  // `?? RECIPIENT` would defeat the point: null is the case under test.
  const existing = 'existing' in options ? options.existing : RECIPIENT;
  const prisma = {
    student: {
      findMany: jest
        .fn()
        .mockResolvedValue(roster.map((studentGuid) => ({ studentGuid }))),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { studentGuid: string } }) =>
          roster.includes(where.studentGuid) ? { studentGuid: where.studentGuid } : null,
        ),
    },
    digestRecipient: {
      create: jest.fn().mockResolvedValue(RECIPIENT),
      findMany: jest.fn().mockResolvedValue([RECIPIENT]),
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
    // Student has no userId FK, so this check plus the recorded userId is the
    // only validation available. See ADR-0025.
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

    const listed = await harness.service.listFor('stu-1', 'user-1');

    expect(listed).toHaveLength(1);
    expect((harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject(
      { studentGuid: 'stu-1', userId: 'user-1' },
    );
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

    await harness.service.listFor('stu-1', 'user-1');

    expect(
      (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ studentGuid: 'stu-1', userId: 'user-1' });
  });

  it('scopes delivery history to children the caller actually receives digests for', async () => {
    // A delivery row holds messageText -- the rendered behavior remarks that
    // were sent to a parent. It must not be readable for another family's child
    // just because the reader is authenticated.
    const harness = makeHarness();

    await harness.service.listDeliveries('user-1', {});

    const where = (harness.prisma.digestDelivery.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.studentGuid).toEqual({ in: ['stu-1'] });
  });

  it('returns no history at all for a user with no recipients', async () => {
    const harness = makeHarness();
    (harness.prisma.digestRecipient.findMany as jest.Mock).mockResolvedValue([]);

    const page = await harness.service.listDeliveries('user-1', {});

    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
    expect(harness.prisma.digestDelivery.findMany).not.toHaveBeenCalled();
  });

  it('lists the children that have at least one enabled recipient', async () => {
    // This is what the cron iterates: delivery is strictly opt-in, so a child
    // with no enabled recipient is never collected for and never summarized.
    const harness = makeHarness();

    const targets = await harness.service.listDeliveryTargets();

    expect(targets).toEqual([
      { studentGuid: 'stu-1', activeFrom: RECIPIENT.activeFrom, recipientCount: 1 },
    ]);
  });
});
