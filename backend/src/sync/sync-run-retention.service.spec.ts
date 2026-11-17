import { SyncRunRetentionService, RETENTION_DAYS } from './sync-run-retention.service';
import type { PrismaService } from '../prisma/prisma.service';

const NOW = new Date('2026-11-17T12:00:00Z');

function makeMockPrisma(deleted = 0) {
  const executeRaw = jest.fn().mockResolvedValue(deleted);
  return {
    prisma: { $executeRaw: executeRaw } as unknown as PrismaService,
    executeRaw,
  };
}

/** The SQL text of a tagged-template call, whitespace-collapsed. */
function sqlOf(mock: jest.Mock): string {
  const strings = mock.mock.calls[0][0] as string[];
  return strings.join(' ').replace(/\s+/g, ' ').trim();
}

describe('SyncRunRetentionService', () => {
  it('deletes rows older than the retention window', async () => {
    const { prisma, executeRaw } = makeMockPrisma(12);
    const service = new SyncRunRetentionService(prisma);

    const deleted = await service.prune(NOW);

    expect(deleted).toBe(12);
    const cutoff = executeRaw.mock.calls[0][1] as Date;
    const expected = new Date(NOW.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });

  // A source whose every row aged out reads back as never_synced, which is a
  // worse answer than a stale timestamp.
  it('retains the latest run and the latest successful run per source', async () => {
    const { prisma, executeRaw } = makeMockPrisma();
    const service = new SyncRunRetentionService(prisma);

    await service.prune(NOW);

    const sql = sqlOf(executeRaw);
    expect(sql).toContain('id NOT IN');
    expect(sql).toContain("status = 'success'");
    // Two retained sets: newest per source, and newest successful per source.
    expect(sql.match(/DISTINCT ON \(source\)/g)).toHaveLength(2);
  });

  it('stays quiet when there is nothing to prune', async () => {
    const { prisma } = makeMockPrisma(0);
    const service = new SyncRunRetentionService(prisma);

    await expect(service.prune(NOW)).resolves.toBe(0);
  });
});
