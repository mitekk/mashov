import { BadRequestException, NotFoundException } from '@nestjs/common';
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

    const listed = await harness.service.listFor('stu-1');

    expect(listed).toHaveLength(1);
    expect((harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject(
      { studentGuid: 'stu-1' },
    );
  });

  it('updates the enabled flag', async () => {
    const harness = makeHarness();

    const updated = await harness.service.update('rec-1', { enabled: false });

    expect(updated.enabled).toBe(false);
  });

  it('reports a missing recipient rather than updating nothing', async () => {
    const harness = makeHarness({ existing: null });

    await expect(harness.service.update('rec-404', { enabled: false })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deletes a recipient', async () => {
    const harness = makeHarness();

    await harness.service.remove('rec-1');

    expect(harness.prisma.digestRecipient.delete).toHaveBeenCalledWith({ where: { id: 'rec-1' } });
  });

  it('reports a missing recipient rather than deleting nothing', async () => {
    const harness = makeHarness({ existing: null });

    await expect(harness.service.remove('rec-404')).rejects.toThrow(NotFoundException);
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
