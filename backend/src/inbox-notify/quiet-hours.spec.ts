import { isWithinQuietHours } from './quiet-hours';

const ZONE = 'Asia/Jerusalem';
/** 15:00 Jerusalem (winter, UTC+2). */
const AFTERNOON = new Date('2026-11-17T13:00:00Z');
/** 22:30 Jerusalem. */
const LATE_EVENING = new Date('2026-11-17T20:30:00Z');
/** 02:00 Jerusalem. */
const MIDDLE_OF_THE_NIGHT = new Date('2026-11-17T00:00:00Z');
/** 08:00 Jerusalem. */
const MORNING = new Date('2026-11-17T06:00:00Z');

describe('isWithinQuietHours', () => {
  it('is quiet late in the evening', () => {
    expect(isWithinQuietHours(LATE_EVENING, ZONE, '21:00', '07:00')).toBe(true);
  });

  it('is quiet in the middle of the night, past midnight', () => {
    // The default window wraps midnight, which a naive from <= t < to misses.
    expect(isWithinQuietHours(MIDDLE_OF_THE_NIGHT, ZONE, '21:00', '07:00')).toBe(true);
  });

  it('is not quiet in the morning, once the window has closed', () => {
    expect(isWithinQuietHours(MORNING, ZONE, '21:00', '07:00')).toBe(false);
  });

  it('is not quiet in the afternoon', () => {
    expect(isWithinQuietHours(AFTERNOON, ZONE, '21:00', '07:00')).toBe(false);
  });

  it('reads the clock in the configured zone, not the process zone', () => {
    // The container runs at TZ=UTC. 20:30Z is 22:30 in Jerusalem and quiet;
    // read as UTC it is 20:30 and would not be.
    expect(isWithinQuietHours(LATE_EVENING, 'UTC', '21:00', '07:00')).toBe(false);
  });

  it('handles a window that does not wrap midnight', () => {
    expect(isWithinQuietHours(MIDDLE_OF_THE_NIGHT, ZONE, '01:00', '05:00')).toBe(true);
    expect(isWithinQuietHours(MORNING, ZONE, '01:00', '05:00')).toBe(false);
  });

  it('is never quiet when the window is empty', () => {
    expect(isWithinQuietHours(MIDDLE_OF_THE_NIGHT, ZONE, '07:00', '07:00')).toBe(false);
  });

  it.each([
    ['', '07:00'],
    ['21:00', ''],
    ['nine pm', '07:00'],
    ['25:00', '07:00'],
    ['21:60', '07:00'],
  ])('fails open on an unparseable window (%p, %p)', (from, to) => {
    // A typo that makes the window permanently quiet kills the feature with no
    // error anyone sees. A typo that makes it never quiet costs one message at
    // an awkward hour.
    expect(isWithinQuietHours(MIDDLE_OF_THE_NIGHT, ZONE, from, to)).toBe(false);
  });
});
