import { isIsoDay, parseIsoDay } from './iso-day';

describe('parseIsoDay', () => {
  it('reads a YYYY-MM-DD day as UTC midnight', () => {
    expect(parseIsoDay('2026-11-18')?.toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });

  it('refuses a day that does not exist, rather than rolling it forward', () => {
    // `new Date('2026-02-30T00:00:00Z')` is 02/03, and `Date.UTC` agrees. A
    // model that answered with a day that is not a day has answered nothing,
    // and silently moving it hands a parent -- or the deferral ledger -- a
    // deadline nobody wrote.
    expect(parseIsoDay('2026-02-30')).toBeNull();
    expect(parseIsoDay('2026-04-31')).toBeNull();
    expect(isIsoDay('2026-02-30')).toBe(false);
  });

  it('accepts the leap day of a leap year and refuses it otherwise', () => {
    expect(parseIsoDay('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(parseIsoDay('2026-02-29')).toBeNull();
  });

  it('refuses anything that is not a bare ISO day', () => {
    for (const raw of ['2026-13-01', 'מחר', '2026-11-18T10:00:00Z', '18/11/2026', '', null, undefined]) {
      expect(parseIsoDay(raw)).toBeNull();
    }
  });

  it('tolerates surrounding whitespace, because upstream text does', () => {
    expect(parseIsoDay(' 2026-11-18 ')?.toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });
});
