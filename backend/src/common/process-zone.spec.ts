import { assertUtcProcessZone } from './process-zone';

/** A Date that reports a fixed zone offset, so no test mutates process.env.TZ. */
function dateAtOffset(offsetMinutes: number): Date {
  const date = new Date('2026-03-09T18:49:43Z');
  jest.spyOn(date, 'getTimezoneOffset').mockReturnValue(offsetMinutes);
  return date;
}

describe('assertUtcProcessZone', () => {
  it('passes at UTC', () => {
    expect(() => assertUtcProcessZone(dateAtOffset(0))).not.toThrow();
  });

  it('throws east of UTC, the direction that hides unread mail', () => {
    // Asia/Jerusalem winter: getTimezoneOffset() is -120.
    expect(() => assertUtcProcessZone(dateAtOffset(-120))).toThrow(/not UTC/);
  });

  it('throws west of UTC too', () => {
    expect(() => assertUtcProcessZone(dateAtOffset(300))).toThrow(/not UTC/);
  });

  it('names the consequence and where it is documented', () => {
    expect(() => assertUtcProcessZone(dateAtOffset(-180))).toThrow(/locallyReadThroughAt/);
    expect(() => assertUtcProcessZone(dateAtOffset(-180))).toThrow(/stops showing as unread/);
    expect(() => assertUtcProcessZone(dateAtOffset(-180))).toThrow(/src\/mail\/unread\.ts/);
  });

  it('defaults to now, which the test run pins to UTC', () => {
    expect(() => assertUtcProcessZone()).not.toThrow();
  });
});
