import type { Request } from 'express';
import { SyncController } from './sync.controller';
import type { SyncService } from './sync.service';
import type { PrismaService } from '../prisma/prisma.service';

function makeController(groupBy: jest.Mock) {
  const prisma = {
    householdConnection: {
      findFirst: jest.fn().mockResolvedValue({ id: 'conn-1' }),
    },
    syncRun: { groupBy },
  } as unknown as PrismaService;

  const syncService = { refreshAll: jest.fn() } as unknown as SyncService;
  return new SyncController(syncService, prisma);
}

const REQUEST = { user: { userId: 'user-1' } } as unknown as Request;

describe('SyncController', () => {
  describe('getStatus', () => {
    it('excludes history backfill runs from sourcesCompleted', async () => {
      // A nightly backfill writes one run per task per student. Counted here,
      // those rows trip `done` before the live sync has finished a thing.
      const groupBy = jest.fn().mockResolvedValue([]);
      const controller = makeController(groupBy);

      await controller.getStatus(REQUEST);

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            source: { not: { startsWith: 'history:' } },
          }),
        }),
      );
    });

    it('still counts the live sources it is given', async () => {
      const groupBy = jest
        .fn()
        .mockResolvedValue([{ source: 'homework:stu-1' }, { source: 'behavior:stu-1' }]);
      const controller = makeController(groupBy);

      const result = await controller.getStatus(REQUEST);

      expect(result.sourcesCompleted).toBe(2);
      expect(result.done).toBe(false);
    });
  });
});
