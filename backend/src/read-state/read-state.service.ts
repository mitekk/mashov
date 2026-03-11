import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface UpsertParams {
  itemType: string;
  itemId: string;
  isRead?: boolean;
  isHandled?: boolean;
}

@Injectable()
export class ReadStateService {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(params: UpsertParams) {
    const { itemType, itemId, isRead, isHandled } = params;

    return this.prisma.readState.upsert({
      where: {
        itemType_itemId_scopeType_scopeId: {
          itemType,
          itemId,
          scopeType: 'household',
          scopeId: 'default',
        },
      },
      create: {
        itemType,
        itemId,
        scopeType: 'household',
        scopeId: 'default',
        isRead: isRead ?? false,
        isHandled: isHandled ?? false,
      },
      update: {
        ...(isRead !== undefined ? { isRead } : {}),
        ...(isHandled !== undefined ? { isHandled } : {}),
      },
    });
  }

  async clearAll() {
    const result = await this.prisma.readState.deleteMany();
    return { deleted: result.count };
  }
}
