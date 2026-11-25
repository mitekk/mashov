import { describe, it, expect } from 'vitest';
import { gradeBandVariant } from './grades';

describe('gradeBandVariant', () => {
  it.each([
    [100, 'positive'],
    [85, 'positive'],
    [84, 'info'],
    [70, 'info'],
    [69, 'attention'],
    [0, 'attention'],
  ])('puts %i in the %s band', (grade, variant) => {
    expect(gradeBandVariant(grade)).toBe(variant);
  });

  it('does not colour an unparseable grade as a problem', () => {
    // A school on textual grades normalizes to NaN. Amber would be the view
    // asserting the child did badly, which it has no basis for.
    expect(gradeBandVariant(Number.NaN)).toBe('info');
    expect(gradeBandVariant(Number.POSITIVE_INFINITY)).toBe('info');
  });
});
