import { DigestRetentionService } from './digest-retention.service';
import type { PrismaService } from '../prisma/prisma.service';

const NOW = new Date('2026-11-17T02:00:00Z');
/** 90 days before the Jerusalem school day containing NOW. */
const CUTOFF = new Date('2026-08-19T00:00:00Z');

function makeHarness() {
  const reportedDelete = jest.fn().mockResolvedValue({ count: 12 });
  const deliveryDelete = jest.fn().mockResolvedValue({ count: 5 });

  const prisma = {
    digestReportedItem: { deleteMany: reportedDelete },
    digestDelivery: { deleteMany: deliveryDelete },
  } as unknown as PrismaService;

  return { prisma, reportedDelete, deliveryDelete, service: new DigestRetentionService(prisma) };
}

describe('DigestRetentionService.prune', () => {
  it('deletes reported items older than 90 days', async () => {
    const harness = makeHarness();

    await harness.service.prune(NOW);

    expect(harness.reportedDelete).toHaveBeenCalledWith({
      where: { reportedFor: { lt: CUTOFF } },
    });
  });

  it('deletes deliveries older than 90 days', async () => {
    const harness = makeHarness();

    await harness.service.prune(NOW);

    expect(harness.deliveryDelete).toHaveBeenCalledWith({
      where: { reportFor: { lt: CUTOFF } },
    });
  });

  it('reports how much it removed', async () => {
    const harness = makeHarness();

    const result = await harness.service.prune(NOW);

    expect(result).toEqual({ reportedItems: 12, deliveries: 5 });
  });

  it('keeps pruning deliveries when the reported-item delete fails', async () => {
    // The two tables are independent; one failing should not leave the other
    // growing without bound.
    const harness = makeHarness();
    harness.reportedDelete.mockRejectedValue(new Error('deadlock detected'));

    const result = await harness.service.prune(NOW);

    expect(harness.deliveryDelete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reportedItems: 0, deliveries: 5 });
  });

  it('cuts off on a date boundary, not a timestamp', async () => {
    // Both columns are @db.Date, so comparing against a mid-day timestamp
    // would be ambiguous about which school day is the oldest kept.
    const harness = makeHarness();

    await harness.service.prune(new Date('2026-11-17T22:45:00Z'));

    const cutoff = harness.reportedDelete.mock.calls[0][0].where.reportedFor.lt as Date;
    expect(cutoff.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });
});
