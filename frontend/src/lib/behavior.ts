import type { BehaviorBucket, FeedPriority } from '@/types/api';

export interface BehaviorClassification {
  bucket: BehaviorBucket;
  priority: FeedPriority;
  label: string;
}

// Default classification mapping — configurable in code per FR-55
const BEHAVIOR_MAP: Record<number, BehaviorClassification> = {
  1: { bucket: 'attention', priority: 'medium', label: 'איחור' },
  2: { bucket: 'attention', priority: 'high', label: 'חיסור' },
  4: { bucket: 'positive', priority: 'low', label: 'חיזוק חיובי' },
  5: { bucket: 'attention', priority: 'high', label: 'אי הכנת ש.ב.' },
  6: { bucket: 'attention', priority: 'medium', label: 'אי הבאת ציוד' },
  10: { bucket: 'attention', priority: 'medium', label: 'לא השלים משימה בכיתה' },
  11: { bucket: 'neutral', priority: 'low', label: 'חיסור בשל פעילות בית-ספרית' },
};

export function classifyBehavior(
  achvaCode: number,
  achvaName: string,
): BehaviorClassification {
  return (
    BEHAVIOR_MAP[achvaCode] ?? {
      bucket: 'neutral',
      priority: 'low',
      label: achvaName,
    }
  );
}

const BUCKETS: readonly BehaviorBucket[] = ['attention', 'positive', 'neutral'];

/**
 * The API cannot send a fourth bucket today -- `ChildrenService.mapBehaviorBucket`
 * narrows the free-form `classification` column to these three. This exists
 * because the cost of being wrong is asymmetric: a `switch` with no `default`
 * returns `undefined`, and the next `.border` on it white-screens the child page.
 */
export function normalizeBucket(bucket: string): BehaviorBucket {
  return (BUCKETS as readonly string[]).includes(bucket)
    ? (bucket as BehaviorBucket)
    : 'neutral';
}

export function getBucketLabel(bucket: BehaviorBucket | 'all' | (string & {})): string {
  if (bucket === 'all') return 'הכל';
  switch (normalizeBucket(bucket)) {
    case 'attention': return 'תשומת לב';
    case 'positive': return 'חיובי';
    case 'neutral': return 'אחר';
  }
}

export function getBucketColor(bucket: BehaviorBucket | (string & {})): {
  bg: string;
  text: string;
  border: string;
} {
  switch (normalizeBucket(bucket)) {
    case 'attention':
      return { bg: 'bg-attention-subtle', text: 'text-attention', border: 'border-attention/45' };
    case 'positive':
      return { bg: 'bg-positive-subtle', text: 'text-positive', border: 'border-positive/45' };
    case 'neutral':
      return { bg: 'bg-muted', text: 'text-muted-foreground', border: 'border-border' };
  }
}
