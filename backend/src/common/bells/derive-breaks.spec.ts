import {
  LUNCH_MIN_MINUTES,
  MAX_BREAK_MINUTES,
  MIN_BREAK_MINUTES,
  clockMinutes,
  deriveBreaks,
  normalizeClock,
} from './derive-breaks';
import type { BellPeriod } from './derive-breaks';
import { DEFAULT_BELL_SCHEDULE } from './default-bell-schedule';

/** One period, 45 minutes long unless told otherwise. */
function period(lesson: number, startTime: string, endTime: string): BellPeriod {
  return { lesson, startTime, endTime };
}

describe('normalizeClock', () => {
  it('drops the seconds the upstream serves', () => {
    expect(normalizeClock('08:15:00')).toBe('08:15');
  });

  it('pads a single-digit hour', () => {
    expect(normalizeClock('8:15')).toBe('08:15');
  });

  it('rejects anything that is not a wall clock reading', () => {
    expect(normalizeClock('')).toBeNull();
    expect(normalizeClock('lunch')).toBeNull();
    expect(normalizeClock('25:00')).toBeNull();
    expect(normalizeClock('08:75')).toBeNull();
    expect(normalizeClock(815)).toBeNull();
    expect(normalizeClock(null)).toBeNull();
  });

  it('reads midnight as zero rather than as missing', () => {
    expect(clockMinutes('00:00')).toBe(0);
  });
});

describe('deriveBreaks', () => {
  it('emits nothing for a changeover shorter than the minimum', () => {
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, '08:48', '09:33'),
    ]);

    expect(MIN_BREAK_MINUTES).toBe(5);
    expect(breaks).toEqual([]);
  });

  it('emits a recess for a fifteen-minute gap', () => {
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, '09:00', '09:45'),
    ]);

    expect(breaks).toEqual([
      {
        afterLesson: 1,
        startTime: '08:45',
        endTime: '09:00',
        minutes: 15,
        kind: 'recess',
      },
    ]);
  });

  it('marks the longest gap at or above the lunch threshold as lunch', () => {
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, '09:00', '09:45'),
      period(3, '10:05', '10:50'),
    ]);

    expect(LUNCH_MIN_MINUTES).toBe(20);
    expect(breaks.map((item) => [item.afterLesson, item.minutes, item.kind])).toEqual([
      [1, 15, 'recess'],
      [2, 20, 'lunch'],
    ]);
  });

  it('leaves every break a recess when none reaches the lunch threshold', () => {
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, '08:55', '09:40'),
      period(3, '09:50', '10:35'),
    ]);

    expect(breaks.map((item) => item.kind)).toEqual(['recess', 'recess']);
  });

  it('marks exactly one lunch however many long gaps there are', () => {
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, '09:15', '10:00'),
      period(3, '10:30', '11:15'),
      period(4, '11:50', '12:35'),
    ]);

    const lunches = breaks.filter((item) => item.kind === 'lunch');
    expect(lunches).toHaveLength(1);
    expect(lunches[0].minutes).toBe(35);
  });

  it('resolves equal-length candidates to the earliest', () => {
    // Two 30-minute gaps. The morning one is the likelier meal break, and a
    // deterministic answer is what keeps the grid from flipping between runs.
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, '09:15', '10:00'),
      period(3, '10:30', '11:15'),
    ]);

    expect(breaks.map((item) => [item.afterLesson, item.kind])).toEqual([
      [1, 'lunch'],
      [2, 'recess'],
    ]);
  });

  it('suppresses a split-day hole rather than calling it recess', () => {
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, '11:45', '12:30'),
    ]);

    expect(MAX_BREAK_MINUTES).toBe(90);
    expect(breaks).toEqual([]);
  });

  it('keeps a gap exactly at each threshold', () => {
    expect(
      deriveBreaks([period(1, '08:00', '08:45'), period(2, '08:50', '09:35')]),
    ).toHaveLength(1);
    expect(
      deriveBreaks([period(1, '08:00', '08:45'), period(2, '10:15', '11:00')]),
    ).toHaveLength(1);
  });

  it('spans a skipped lesson number', () => {
    // A school that has no period 5 still sends the child out between 4 and 6.
    const breaks = deriveBreaks([
      period(4, '10:00', '10:45'),
      period(6, '11:00', '11:45'),
    ]);

    expect(breaks).toEqual([
      {
        afterLesson: 4,
        startTime: '10:45',
        endTime: '11:00',
        minutes: 15,
        kind: 'recess',
      },
    ]);
  });

  it('orders by lesson rather than trusting the order it was handed', () => {
    const breaks = deriveBreaks([
      period(2, '09:00', '09:45'),
      period(1, '08:00', '08:45'),
    ]);

    expect(breaks.map((item) => item.afterLesson)).toEqual([1]);
  });

  it('drops unusable rows instead of deriving a break from them', () => {
    const breaks = deriveBreaks([
      period(1, '08:00', '08:45'),
      period(2, 'noon', '09:45'),
      period(3, '09:00', '09:45'),
      period(0, '07:00', '07:45'),
    ]);

    expect(breaks.map((item) => item.afterLesson)).toEqual([1]);
  });

  it('answers empty for nothing and for one period', () => {
    expect(deriveBreaks([])).toEqual([]);
    expect(deriveBreaks([period(1, '08:00', '08:45')])).toEqual([]);
  });

  it('puts the bundled default schedule lunch after the fourth period', () => {
    // The whole point of the 25-minute gap in the default: a fallback that
    // produces no meal break would be a fallback a parent cannot read.
    const breaks = deriveBreaks([...DEFAULT_BELL_SCHEDULE]);

    expect(breaks.filter((item) => item.kind === 'lunch')).toEqual([
      {
        afterLesson: 4,
        startTime: '11:20',
        endTime: '11:45',
        minutes: 25,
        kind: 'lunch',
      },
    ]);
    expect(breaks).toHaveLength(7);
  });
});
