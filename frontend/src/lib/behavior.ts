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

export function getBucketLabel(bucket: BehaviorBucket | 'all'): string {
  switch (bucket) {
    case 'all': return 'הכל';
    case 'attention': return 'תשומת לב';
    case 'positive': return 'חיובי';
    case 'neutral': return 'אחר';
  }
}

export function getBucketColor(bucket: BehaviorBucket): {
  bg: string;
  text: string;
  border: string;
} {
  switch (bucket) {
    case 'attention':
      return { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' };
    case 'positive':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' };
    case 'neutral':
      return { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200' };
  }
}
