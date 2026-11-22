import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchChildTimetable, normalizeTimetableSchedule } from './children';

const ENTRY = {
  id: 'tt-1',
  studentGuid: 'stu-1',
  groupId: 181,
  day: 1,
  lesson: 1,
  roomNum: '104',
  weeks: 1,
  groupName: 'שפה ג3',
  subjectName: 'שפה',
  teachers: [{ teacherGuid: 't-1', teacherName: 'מורן לוי' }],
  updatedAt: '2026-03-15T00:00:00.000Z',
};

const SCHEDULE = {
  source: 'school',
  periods: [
    { lesson: 1, startTime: '08:15', endTime: '09:00' },
    { lesson: 2, startTime: '09:15', endTime: '10:00' },
  ],
  breaks: [
    {
      afterLesson: 1,
      startTime: '09:00',
      endTime: '09:15',
      minutes: 15,
      kind: 'recess',
    },
  ],
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchChildTimetable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries the bell schedule alongside the entries', async () => {
    mockFetch({ data: [ENTRY], schedule: SCHEDULE });

    const response = await fetchChildTimetable('stu-1');

    expect(response.data).toHaveLength(1);
    expect(response.schedule).toEqual(SCHEDULE);
  });

  it('still returns the grid when the backend sends no schedule', async () => {
    // An older backend answers without the field. Losing the times is
    // acceptable; losing the timetable is not.
    mockFetch({ data: [ENTRY] });

    const response = await fetchChildTimetable('stu-1');

    expect(response.data).toHaveLength(1);
    expect(response.schedule).toBeUndefined();
  });
});

describe('normalizeTimetableSchedule', () => {
  it('returns undefined for a missing or wrongly typed schedule', () => {
    expect(normalizeTimetableSchedule(undefined)).toBeUndefined();
    expect(normalizeTimetableSchedule(null)).toBeUndefined();
    expect(normalizeTimetableSchedule('08:15')).toBeUndefined();
    expect(normalizeTimetableSchedule([])).toBeUndefined();
    expect(normalizeTimetableSchedule({})).toBeUndefined();
  });

  it('returns undefined when no period survives validation', () => {
    // `source` with no times would make the UI caption a schedule it is not
    // showing, which is worse than showing no times at all.
    expect(
      normalizeTimetableSchedule({
        source: 'school',
        periods: [{ lesson: 1, startTime: 'morning', endTime: null }],
        breaks: [],
      }),
    ).toBeUndefined();
  });

  it('drops only the malformed rows', () => {
    const schedule = normalizeTimetableSchedule({
      source: 'school',
      periods: [
        { lesson: 1, startTime: '08:15', endTime: '09:00' },
        { lesson: 0, startTime: '07:00', endTime: '07:45' },
        { lesson: 2, startTime: '09:15:00', endTime: '10:00' },
      ],
      breaks: [
        { afterLesson: 1, startTime: '09:00', endTime: '09:15', minutes: 15, kind: 'recess' },
        { afterLesson: 2, startTime: 'noon', endTime: '11:00', minutes: 20, kind: 'lunch' },
      ],
    });

    // "09:15:00" is not the shape the API contract promises, so period 2 goes
    // with it rather than reaching the grid half-parsed.
    expect(schedule?.periods).toEqual([{ lesson: 1, startTime: '08:15', endTime: '09:00' }]);
    expect(schedule?.breaks).toHaveLength(1);
  });

  it('treats an unrecognized source as a default, so the times get captioned', () => {
    const schedule = normalizeTimetableSchedule({
      source: 'guessed',
      periods: [{ lesson: 1, startTime: '08:15', endTime: '09:00' }],
      breaks: 'nope',
    });

    expect(schedule?.source).toBe('default');
    expect(schedule?.breaks).toEqual([]);
  });

  it('defaults a break of an unknown kind to recess', () => {
    const schedule = normalizeTimetableSchedule({
      source: 'school',
      periods: [{ lesson: 1, startTime: '08:15', endTime: '09:00' }],
      breaks: [{ afterLesson: 1, startTime: '09:00', endTime: '09:15', minutes: 15 }],
    });

    expect(schedule?.breaks[0].kind).toBe('recess');
  });
});
