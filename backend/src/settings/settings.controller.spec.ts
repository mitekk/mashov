import type { Request } from 'express';
import { SettingsController } from './settings.controller';
import type { SettingsService } from './settings.service';
import type { PrismaService } from '../prisma/prisma.service';

const REQUEST = { user: { userId: 'user-1' } } as unknown as Request;

function makeController(connection: { id: string } | null) {
  const findFirst = jest.fn().mockResolvedValue(connection);
  const prisma = {
    householdConnection: { findFirst },
  } as unknown as PrismaService;
  const settingsService = {
    getSourceHealth: jest.fn().mockResolvedValue({ sources: [] }),
    getProfile: jest.fn().mockResolvedValue(null),
  } as unknown as SettingsService;

  return { controller: new SettingsController(settingsService, prisma), settingsService, findFirst };
}

describe('SettingsController', () => {
  describe('getSourceHealth', () => {
    it("scopes the read to the caller's active connection", async () => {
      const { controller, settingsService, findFirst } = makeController({ id: 'conn-1' });

      await controller.getSourceHealth(REQUEST);

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', active: true },
        }),
      );
      // The caller goes through too: the content freshness underneath is the
      // household's, and without a caller it was every household's (R4).
      expect(settingsService.getSourceHealth).toHaveBeenCalledWith('conn-1', 'user-1');
    });

    it('passes no connection when the caller has none', async () => {
      const { controller, settingsService } = makeController(null);

      await controller.getSourceHealth(REQUEST);

      expect(settingsService.getSourceHealth).toHaveBeenCalledWith(null, 'user-1');
    });

    it('rejects an unauthenticated caller rather than reading anything', async () => {
      const { controller, settingsService } = makeController({ id: 'conn-1' });

      await expect(controller.getSourceHealth({} as unknown as Request)).rejects.toThrow();
      expect(settingsService.getSourceHealth).not.toHaveBeenCalled();
    });
  });

  describe('getProfile', () => {
    it('passes the caller id through', async () => {
      const { controller, settingsService } = makeController({ id: 'conn-1' });

      await controller.getProfile(REQUEST);

      expect(settingsService.getProfile).toHaveBeenCalledWith('user-1');
    });

    it('rejects an unauthenticated caller rather than reading anything', async () => {
      // Unscoped, this endpoint returned *a* parent's displayName, email and
      // cellphone to anyone who asked.
      const { controller, settingsService } = makeController({ id: 'conn-1' });

      await expect(controller.getProfile({} as unknown as Request)).rejects.toThrow();
      expect(settingsService.getProfile).not.toHaveBeenCalled();
    });
  });
});
