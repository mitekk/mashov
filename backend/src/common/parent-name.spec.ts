import { parentDisplayName } from './parent-name';

describe('parentDisplayName', () => {
  it('drops the trailing child tag', () => {
    expect(parentDisplayName('קורס דמיטרי [מיקה ז8]')).toBe('קורס דמיטרי');
  });

  it('drops every trailing group, not just the last', () => {
    expect(parentDisplayName('קורס דמיטרי [א ב1] [ג ד2]')).toBe('קורס דמיטרי');
  });

  it('leaves a name with no bracket alone', () => {
    expect(parentDisplayName('קורס דמיטרי')).toBe('קורס דמיטרי');
  });

  it('keeps the raw string when the bracket is the whole name', () => {
    // A blank header is worse than a header naming a child: the parent at
    // least recognises the latter.
    expect(parentDisplayName('[מיקה ז8]')).toBe('[מיקה ז8]');
  });

  it('leaves an unbalanced bracket alone', () => {
    expect(parentDisplayName('קורס דמיטרי [מיקה')).toBe('קורס דמיטרי [מיקה');
  });

  it('returns an empty string for a missing name', () => {
    expect(parentDisplayName(null)).toBe('');
    expect(parentDisplayName(undefined)).toBe('');
    expect(parentDisplayName('')).toBe('');
  });

  it('collapses the whitespace the strip leaves behind', () => {
    expect(parentDisplayName('  קורס   דמיטרי   [מיקה ז8]  ')).toBe('קורס דמיטרי');
  });
});
