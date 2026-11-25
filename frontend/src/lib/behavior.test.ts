import { describe, expect, it } from 'vitest';
import type { BehaviorBucket } from '@/types/api';
import {
  classifyBehavior,
  getBucketColor,
  getBucketLabel,
  normalizeBucket,
} from './behavior';

describe('classifyBehavior', () => {
  it('maps a known achva code to its bucket, priority and label', () => {
    expect(classifyBehavior(2, 'לא משנה')).toEqual({
      bucket: 'attention',
      priority: 'high',
      label: 'חיסור',
    });
    expect(classifyBehavior(4, 'לא משנה')).toEqual({
      bucket: 'positive',
      priority: 'low',
      label: 'חיזוק חיובי',
    });
    expect(classifyBehavior(11, 'לא משנה')).toEqual({
      bucket: 'neutral',
      priority: 'low',
      label: 'חיסור בשל פעילות בית-ספרית',
    });
  });

  it('falls back to a low-priority neutral event named after achvaName', () => {
    expect(classifyBehavior(9999, 'הערה חדשה')).toEqual({
      bucket: 'neutral',
      priority: 'low',
      label: 'הערה חדשה',
    });
  });
});

describe('getBucketLabel', () => {
  it('names each bucket and the all-buckets filter', () => {
    expect(getBucketLabel('all')).toBe('הכל');
    expect(getBucketLabel('attention')).toBe('תשומת לב');
    expect(getBucketLabel('positive')).toBe('חיובי');
    expect(getBucketLabel('neutral')).toBe('אחר');
  });

  it('names an off-contract bucket as neutral rather than returning undefined', () => {
    expect(getBucketLabel('negative')).toBe('אחר');
  });
});

describe('getBucketColor', () => {
  it('returns a full bg/text/border triple for every bucket', () => {
    for (const bucket of ['attention', 'positive', 'neutral'] as BehaviorBucket[]) {
      const colors = getBucketColor(bucket);
      expect(colors.bg).toBeTruthy();
      expect(colors.text).toBeTruthy();
      expect(colors.border).toBeTruthy();
    }
  });

  // The regression that matters: a `switch` with no `default` returned
  // `undefined` here, and the next `.border` white-screened the child page.
  it('returns the neutral triple for an off-contract bucket', () => {
    expect(getBucketColor('negative' as BehaviorBucket)).toEqual(
      getBucketColor('neutral'),
    );
    expect(getBucketColor('negative' as BehaviorBucket).border).toBeTruthy();
  });
});

describe('normalizeBucket', () => {
  it('passes the three contract buckets through unchanged', () => {
    expect(normalizeBucket('attention')).toBe('attention');
    expect(normalizeBucket('positive')).toBe('positive');
    expect(normalizeBucket('neutral')).toBe('neutral');
  });

  it('narrows anything else to neutral', () => {
    expect(normalizeBucket('negative')).toBe('neutral');
    expect(normalizeBucket('')).toBe('neutral');
  });
});
