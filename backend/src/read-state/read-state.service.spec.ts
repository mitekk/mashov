import { ReadStateService } from './read-state.service';
import { PrismaService } from '../prisma/prisma.service';

function makeMockPrisma(overrides: Partial<{
  readStateUpsert: jest.Mock;
  readStateDeleteMany: jest.Mock;
}>): jest.Mocked<PrismaService> {
  return {
    readState: {
      upsert: overrides.readStateUpsert ?? jest.fn().mockResolvedValue({
        id: 'rs-1',
        itemType: 'notification',
        itemId: 'notif-1',
        scopeType: 'household',
        scopeId: 'default',
        isRead: false,
        isHandled: false,
        updatedAt: new Date(),
      }),
      deleteMany: overrides.readStateDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

describe('ReadStateService', () => {
  describe('upsert', () => {
    it('creates a read state record with isRead=true', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({
        id: 'rs-1',
        itemType: 'notification',
        itemId: 'notif-1',
        isRead: true,
        isHandled: false,
      });
      const service = new ReadStateService(makeMockPrisma({ readStateUpsert: mockUpsert }));

      const result = await service.upsert({ itemType: 'notification', itemId: 'notif-1', isRead: true });

      expect(result.isRead).toBe(true);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            itemType_itemId_scopeType_scopeId: {
              itemType: 'notification',
              itemId: 'notif-1',
              scopeType: 'household',
              scopeId: 'default',
            },
          },
          create: expect.objectContaining({
            itemType: 'notification',
            itemId: 'notif-1',
            isRead: true,
            isHandled: false,
          }),
        }),
      );
    });

    it('creates a read state record with isHandled=true and includes it in update', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({
        id: 'rs-2',
        itemType: 'behavior',
        itemId: 'beh-1',
        isRead: false,
        isHandled: true,
      });
      const service = new ReadStateService(makeMockPrisma({ readStateUpsert: mockUpsert }));

      await service.upsert({ itemType: 'behavior', itemId: 'beh-1', isHandled: true });

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          // When isHandled is explicitly passed, it is applied to both create and update
          create: expect.objectContaining({ isHandled: true }),
          update: expect.objectContaining({ isHandled: true }),
        }),
      );
    });

    it('defaults isRead and isHandled to false when not provided', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({
        isRead: false,
        isHandled: false,
      });
      const service = new ReadStateService(makeMockPrisma({ readStateUpsert: mockUpsert }));

      await service.upsert({ itemType: 'notification', itemId: 'notif-2' });

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ isRead: false, isHandled: false }),
        }),
      );
    });

    it('scopes all read state records to household/default', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      const service = new ReadStateService(makeMockPrisma({ readStateUpsert: mockUpsert }));

      await service.upsert({ itemType: 'mail_conversation', itemId: 'conv-1' });

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ scopeType: 'household', scopeId: 'default' }),
        }),
      );
    });

    it('does not include isRead in update when not provided', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      const service = new ReadStateService(makeMockPrisma({ readStateUpsert: mockUpsert }));

      await service.upsert({ itemType: 'notification', itemId: 'notif-3', isHandled: true });

      const call = mockUpsert.mock.calls[0][0];
      expect(call.update).not.toHaveProperty('isRead');
      expect(call.update).toHaveProperty('isHandled', true);
    });

    it('does not include isHandled in update when not provided', async () => {
      const mockUpsert = jest.fn().mockResolvedValue({});
      const service = new ReadStateService(makeMockPrisma({ readStateUpsert: mockUpsert }));

      await service.upsert({ itemType: 'notification', itemId: 'notif-4', isRead: true });

      const call = mockUpsert.mock.calls[0][0];
      expect(call.update).toHaveProperty('isRead', true);
      expect(call.update).not.toHaveProperty('isHandled');
    });
  });

  describe('clearAll', () => {
    it('deletes all read state records and returns the count', async () => {
      const mockDeleteMany = jest.fn().mockResolvedValue({ count: 5 });
      const service = new ReadStateService(makeMockPrisma({ readStateDeleteMany: mockDeleteMany }));

      const result = await service.clearAll();
      expect(result).toEqual({ deleted: 5 });
      expect(mockDeleteMany).toHaveBeenCalled();
    });

    it('returns deleted=0 when there are no records to clear', async () => {
      const mockDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
      const service = new ReadStateService(makeMockPrisma({ readStateDeleteMany: mockDeleteMany }));

      const result = await service.clearAll();
      expect(result).toEqual({ deleted: 0 });
    });
  });
});
