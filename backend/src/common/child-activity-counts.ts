import { PrismaService } from '../prisma/prisma.service';
import { UserItemStateService } from './user-item-state.service';
import type { YearScope } from './school-year/school-year.scope';

/**
 * The numbers on a child's activity chips, on `/children`, `/children/:guid`
 * and the home card alike.
 *
 * Each one is "unread, non-archived, this school year" -- deliberately NOT a
 * rolling window. The chips sit directly above lists that span the whole
 * configured history window, so a seven-day floor made every chip read 0 at a
 * school that logs events weekly, which is indistinguishable from a failed
 * sync (ADR-0034).
 */
export interface ChildActivityCounts {
  unreadHomeworkCount: number;
  /** `classification: 'attention'` only. */
  attentionCount: number;
  positiveCount: number;
  /** Attendance and anything unmapped: shown, but not as a negative event. */
  neutralCount: number;
}

type ItemState = { isNew: boolean; isArchived: boolean };

const EMPTY_STATE_MAP = () => new Map<string, ItemState>();

/**
 * An item with no `user_item_state` row has never been opened, so the absent
 * row means unread rather than read.
 */
export function isUnreadAndNotArchived(state: ItemState | undefined): boolean {
  const effectiveState = state ?? { isNew: true, isArchived: false };
  return effectiveState.isNew && !effectiveState.isArchived;
}

/**
 * One counter for all three payloads.
 *
 * It used to be two copies -- `children.service` and `dashboard.service` --
 * which is how the home card and the children card came to disagree about the
 * same child. `yearScope` is the caller's: cross-child for a list, that
 * child's own school's year for a workspace.
 */
export async function unreadChildActivityCounts(
  prisma: PrismaService,
  userItemState: UserItemStateService,
  studentGuid: string,
  yearScope: YearScope,
  userId?: string,
): Promise<ChildActivityCounts> {
  const [homeworkRows, behaviorRows] = await Promise.all([
    prisma.homeworkItem.findMany({
      where: { studentGuid, ...yearScope },
      select: { id: true },
    }),
    prisma.behaviorItem.findMany({
      where: { studentGuid, ...yearScope },
      select: { id: true, classification: true },
    }),
  ]);

  const [homeworkStateMap, behaviorStateMap] = userId
    ? await Promise.all([
        userItemState.getStateBatch(
          userId,
          'homework',
          homeworkRows.map((row) => row.id),
        ),
        userItemState.getStateBatch(
          userId,
          'behavior',
          behaviorRows.map((row) => row.id),
        ),
      ])
    : [EMPTY_STATE_MAP(), EMPTY_STATE_MAP()];

  const unreadHomeworkCount = homeworkRows.filter((row) =>
    isUnreadAndNotArchived(homeworkStateMap.get(row.id)),
  ).length;

  const visibleBehaviorRows = behaviorRows.filter((row) =>
    isUnreadAndNotArchived(behaviorStateMap.get(row.id)),
  );

  const countOf = (classification: string) =>
    visibleBehaviorRows.filter((row) => row.classification === classification).length;

  return {
    unreadHomeworkCount,
    // `attention` only. Counting `!== 'positive'` is what presented a
    // school-authorised absence as a negative event.
    attentionCount: countOf('attention'),
    positiveCount: countOf('positive'),
    neutralCount: countOf('neutral'),
  };
}
