import { resolveSchoolLabels } from './school-label';

/**
 * Short school labels, resolved as a SET.
 *
 * A chip row on a 360px phone cannot carry "אורט רמון - חינוך מיוחד", so the
 * label is trimmed. Trimming each name independently is the trap: two schools
 * in the same cluster routinely share everything up to the suffix, and two
 * identical chips are worse than two long ones -- the parent cannot tell which
 * filter they just pressed. So collisions fall back to the full name for BOTH
 * sides, which is why this takes the whole list rather than one name.
 *
 * Server-side only: deriving it in the client would put the collision rule in
 * two languages and let them disagree.
 */
describe('resolveSchoolLabels', () => {
  it('prefers a parent-chosen label over anything derived', () => {
    const labels = resolveSchoolLabels([
      { id: 'a', schoolName: 'אורט רמון - חינוך מיוחד', displayLabel: 'אצל נועה' },
    ]);

    expect(labels.get('a')).toBe('אצל נועה');
  });

  it('keeps a short name as it is', () => {
    const labels = resolveSchoolLabels([{ id: 'a', schoolName: 'אורט רמון', displayLabel: null }]);

    expect(labels.get('a')).toBe('אורט רמון');
  });

  it('drops a trailing " - …" qualifier', () => {
    const labels = resolveSchoolLabels([
      { id: 'a', schoolName: 'תיכון רמון - מגמת מחשבים', displayLabel: null },
    ]);

    expect(labels.get('a')).toBe('תיכון רמון');
  });

  it('trims a long name on a word boundary, not mid-word', () => {
    const labels = resolveSchoolLabels([
      { id: 'a', schoolName: 'בית הספר הממלכתי הגדול', displayLabel: null },
    ]);

    const label = labels.get('a') as string;
    expect(label.length).toBeLessThanOrEqual(12);
    // Whatever survives is whole words, so the label never reads as a typo.
    expect('בית הספר הממלכתי הגדול'.split(' ')).toEqual(
      expect.arrayContaining(label.replace('…', '').trim().split(' ')),
    );
  });

  it('falls back to the full name for BOTH sides of a collision', () => {
    // The case that makes this a set operation. Two chips reading "אורט רמון"
    // are indistinguishable, so both revert.
    const labels = resolveSchoolLabels([
      { id: 'a', schoolName: 'אורט רמון - חטיבת ביניים', displayLabel: null },
      { id: 'b', schoolName: 'אורט רמון - חטיבה עליונה', displayLabel: null },
    ]);

    expect(labels.get('a')).toBe('אורט רמון - חטיבת ביניים');
    expect(labels.get('b')).toBe('אורט רמון - חטיבה עליונה');
  });

  it('leaves a non-colliding pair shortened', () => {
    const labels = resolveSchoolLabels([
      { id: 'a', schoolName: 'אורט רמון - חטיבת ביניים', displayLabel: null },
      { id: 'b', schoolName: 'תיכון הרצוג - מגמת מחשבים', displayLabel: null },
    ]);

    expect(labels.get('a')).toBe('אורט רמון');
    expect(labels.get('b')).toBe('תיכון הרצוג');
  });

  it('does not let a chosen label collide with a derived one silently', () => {
    const labels = resolveSchoolLabels([
      { id: 'a', schoolName: 'אורט רמון - א', displayLabel: 'אורט רמון' },
      { id: 'b', schoolName: 'אורט רמון - ב', displayLabel: null },
    ]);

    expect(labels.get('a')).not.toBe(labels.get('b'));
  });

  it('falls back to the semel when a school has no name at all', () => {
    // schoolName is nullable, and a connection created before the login
    // response carried schoolSettings has none. A blank chip is unpressable.
    const labels = resolveSchoolLabels([
      { id: 'a', schoolName: null, displayLabel: null, schoolCode: 540175 },
    ]);

    expect(labels.get('a')).toBe('540175');
  });

  it('handles an empty list', () => {
    expect(resolveSchoolLabels([]).size).toBe(0);
  });

  it('is stable: the same input gives the same labels', () => {
    const input = [
      { id: 'a', schoolName: 'אורט רמון - חטיבת ביניים', displayLabel: null },
      { id: 'b', schoolName: 'תיכון הרצוג', displayLabel: null },
    ];

    expect(resolveSchoolLabels(input)).toEqual(resolveSchoolLabels(input));
  });
});
