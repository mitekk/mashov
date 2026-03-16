import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ItemType = 'homework' | 'behavior' | 'mail_conversation';

export interface ItemState {
  isNew: boolean;
  isArchived: boolean;
}

@Injectable()
export class UserItemStateService {
  constructor(private readonly prisma: PrismaService) {}

  async getState(
    userId: string,
    itemType: ItemType,
    itemId: string,
  ): Promise<ItemState> {
    const state = await this.prisma.userItemState.findUnique({
      where: {
        userId_itemType_itemId: { userId, itemType, itemId },
      },
    });
    return {
      isNew: state?.isNew ?? true,
      isArchived: state?.isArchived ?? false,
    };
  }

  async getStateBatch(
    userId: string,
    itemType: ItemType,
    itemIds: string[],
  ): Promise<Map<string, ItemState>> {
    if (itemIds.length === 0) return new Map();

    const states = await this.prisma.userItemState.findMany({
      where: {
        userId,
        itemType,
        itemId: { in: itemIds },
      },
    });

    const stateMap = new Map<string, ItemState>(
      states.map((s) => [s.itemId, { isNew: s.isNew, isArchived: s.isArchived }]),
    );

    return stateMap;
  }

  async setState(
    userId: string,
    itemType: ItemType,
    itemId: string,
    isNew?: boolean,
    isArchived?: boolean,
  ): Promise<ItemState> {
    const current = await this.getState(userId, itemType, itemId);

    const updated = await this.prisma.userItemState.upsert({
      where: {
        userId_itemType_itemId: { userId, itemType, itemId },
      },
      create: {
        userId,
        itemType,
        itemId,
        isNew: isNew ?? current.isNew,
        isArchived: isArchived ?? current.isArchived,
      },
      update: {
        ...(isNew !== undefined ? { isNew } : {}),
        ...(isArchived !== undefined ? { isArchived } : {}),
      },
    });

    return { isNew: updated.isNew, isArchived: updated.isArchived };
  }

  async setStateBatch(
    userId: string,
    itemType: ItemType,
    itemIds: string[],
    isNew?: boolean,
    isArchived?: boolean,
  ): Promise<number> {
    if (itemIds.length === 0) return 0;

    // Upsert each record individually (Prisma v5 doesn't support batch upsert)
    let count = 0;
    for (const itemId of itemIds) {
      await this.prisma.userItemState.upsert({
        where: {
          userId_itemType_itemId: { userId, itemType, itemId },
        },
        create: {
          userId,
          itemType,
          itemId,
          isNew: isNew ?? true,
          isArchived: isArchived ?? false,
        },
        update: {
          ...(isNew !== undefined ? { isNew } : {}),
          ...(isArchived !== undefined ? { isArchived } : {}),
        },
      });
      count++;
    }
    return count;
  }

  async getFilteredItemIds(
    userId: string,
    itemType: ItemType,
    itemIds: string[],
    filter: 'new' | 'archived' | 'all',
  ): Promise<{ included: Set<string>; excluded: Set<string> }> {
    if (filter === 'all') {
      // "all" means exclude archived
      const archived = await this.prisma.userItemState.findMany({
        where: {
          userId,
          itemType,
          itemId: { in: itemIds },
          isArchived: true,
        },
        select: { itemId: true },
      });
      const archivedSet = new Set(archived.map((s) => s.itemId));
      const includedSet = new Set(itemIds.filter((id) => !archivedSet.has(id)));
      return { included: includedSet, excluded: archivedSet };
    }

    if (filter === 'new') {
      // new = isNew:true AND isArchived:false
      // Items without a state record default to isNew=true, isArchived=false — so they are included
      const explicitStates = await this.prisma.userItemState.findMany({
        where: {
          userId,
          itemType,
          itemId: { in: itemIds },
        },
        select: { itemId: true, isNew: true, isArchived: true },
      });

      const stateMap = new Map(explicitStates.map((s) => [s.itemId, s]));
      const included = new Set<string>();
      const excluded = new Set<string>();

      for (const id of itemIds) {
        const state = stateMap.get(id);
        if (!state || (state.isNew && !state.isArchived)) {
          included.add(id);
        } else {
          excluded.add(id);
        }
      }
      return { included, excluded };
    }

    // archived
    const archivedStates = await this.prisma.userItemState.findMany({
      where: {
        userId,
        itemType,
        itemId: { in: itemIds },
        isArchived: true,
      },
      select: { itemId: true },
    });
    const includedSet = new Set(archivedStates.map((s) => s.itemId));
    const excludedSet = new Set(itemIds.filter((id) => !includedSet.has(id)));
    return { included: includedSet, excluded: excludedSet };
  }
}
