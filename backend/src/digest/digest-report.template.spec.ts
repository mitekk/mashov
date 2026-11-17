import { deterministicLines, formatSchoolDate, renderReport } from './digest-report.template';
import type { DigestLines, DigestPayload } from './digest.types';

const REPORT_FOR = new Date('2026-11-17T00:00:00Z');

const LINES: DigestLines = {
  headline: 'יום רגוע עם הערה אחת',
  behaviorLine: 'היה איחור אחד בשיעור מתמטיקה.',
  homeworkLine: 'ניתנה מטלה אחת בחשבון.',
  dueTomorrowLine: 'מטלה אחת צפויה להיבדק מחר.',
  releaseLine: 'שחרור מוקדם מחר.',
  activityLine: 'טופס אישור ממתין לחתימה.',
};

function makePayload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    childFirstName: 'אבי',
    childGender: 'male',
    reportFor: REPORT_FOR,
    behavior: [],
    homeworkNew: [],
    homeworkDueTomorrow: [],
    releases: [],
    activities: [],
    ...overrides,
  };
}

const BEHAVIOR = {
  id: 'beh-1',
  achvaName: 'איחור',
  classification: 'negative',
  justifiable: true,
  subject: 'מתמטיקה',
  remark: 'הגיע באיחור של 10 דקות',
  lessonDate: REPORT_FOR,
  eventAt: new Date('2026-11-17T11:00:00Z'),
};

const HOMEWORK = {
  id: 'hw-1',
  subjectName: 'חשבון',
  homeworkText: 'לפתור עמוד 42',
  remark: null,
  lessonDate: REPORT_FOR,
  groupId: 55,
};

describe('formatSchoolDate', () => {
  it('formats the school day the Israeli way, from UTC fields', () => {
    expect(formatSchoolDate(REPORT_FOR)).toBe('17/11/2026');
  });
});

describe('renderReport', () => {
  it('opens with the child and the day, before any prose', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    // Who and when is what a parent scans for first in a Telegram list.
    expect(text.split('\n')[0]).toBe('אבי · 17/11/2026');
    expect(text).toContain('יום רגוע עם הערה אחת');
  });

  it('names the child once only, in that opening line', () => {
    // The name is in the header, so prose that repeats it reads like a form
    // letter. The deterministic lines must not reintroduce it, and the system
    // prompt tells the model the same thing.
    const payload = makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicLines(payload));

    expect(text.split('אבי').length - 1).toBe(1);
  });

  it('renders a behavior section as a header and its prose', () => {
    // The facts live in the prose now, not in a list beneath it. What the
    // template still owns is that the section appears at all and carries its
    // header -- see the deterministicLines tests for the facts themselves.
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    expect(text).toContain('התנהגות ונוכחות');
    expect(text).toContain(LINES.behaviorLine);
  });

  it('omits sections that have no items', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    // Only behavior has items, so neither homework section should appear -- and
    // the LLM's prose for them must not leak in either.
    expect(text).not.toContain(LINES.homeworkLine);
    expect(text).not.toContain(LINES.dueTomorrowLine);
  });

  it('renders newly assigned homework as a header and its prose', () => {
    const text = renderReport(makePayload({ homeworkNew: [HOMEWORK] }), LINES);

    expect(text).toContain('שיעורי בית חדשים');
    expect(text).toContain(LINES.homeworkLine);
  });

  it('labels a derived deadline as an estimate and never as a due date', () => {
    // Mashov exposes no due-date field at all, so promising one would be a lie.
    // ADR-0026 records the departure; this label is where it is honoured.
    const text = renderReport(
      makePayload({
        homeworkDueTomorrow: [
          { ...HOMEWORK, estimatedDueDate: new Date('2026-11-18T00:00:00Z') },
        ],
      }),
      LINES,
    );

    // Appended by the template, not left to the model: the label and the date
    // are the one factual claim in this section that must never be wrong.
    expect(text).toContain('צפי הגשה: 18/11/2026');

    // Nothing may label the date "תאריך הגשה" -- that would assert a real
    // deadline the data cannot support. The caveat below the section uses the
    // phrase, but only to say Mashov supplies no such date, so the assertion is
    // scoped to the section line where the claim would be made.
    const sectionLine = text
      .split('\n')
      .find((line) => line.includes('צפי הגשה: '));
    expect(sectionLine).toBeDefined();
    expect(sectionLine).not.toContain('תאריך הגשה');
  });

  it('carries a standing caveat whenever an estimate is shown', () => {
    const text = renderReport(
      makePayload({
        homeworkDueTomorrow: [
          { ...HOMEWORK, estimatedDueDate: new Date('2026-11-18T00:00:00Z') },
        ],
      }),
      LINES,
    );

    expect(text).toContain('צפי בלבד');
    // The caveat states outright that Mashov supplies no due date.
    expect(text).toContain('אינו מספק תאריך הגשה');
  });

  it('does not show a caveat when no estimate is in the report', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    expect(text).not.toContain('צפי הגשה');
  });

  it('never leaks a family name, a guid, or a teacher name into the message', () => {
    // The payload simply has no such fields; this guards the shape.
    const text = renderReport(
      makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] }),
      LINES,
    );

    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no guid
    expect(text).not.toContain('reporter');
  });
});

describe('deterministicLines', () => {
  // The fallback when the LLM times out, refuses, or returns malformed output.
  // A parent getting a plainer message beats a parent getting nothing.
  it('describes a behavior event in Hebrew without the model', () => {
    const lines = deterministicLines(makePayload({ behavior: [BEHAVIOR] }));

    expect(lines.behaviorLine).toMatch(/[֐-׿]/);
    expect(lines.headline).toMatch(/[֐-׿]/);
  });

  it('describes every event rather than counting them', () => {
    // It used to count, which only worked because the bullets underneath said
    // what the events were. Now the line is the whole report of them, so two
    // events must produce two statements.
    const lines = deterministicLines(
      makePayload({
        behavior: [BEHAVIOR, { ...BEHAVIOR, id: 'beh-2', achvaName: 'הפרעה', subject: 'אנגלית' }],
      }),
    );

    expect(lines.behaviorLine).toContain('איחור');
    expect(lines.behaviorLine).toContain('הפרעה');
    expect(lines.behaviorLine).toContain('אנגלית');
  });

  it('reads as a sentence for a single event, with no count in front of it', () => {
    // This replaces an older guard against "נרשמו 1 הערת התנהגות" -- a plural
    // verb in front of a bare numeral. Describing the event removes the
    // question entirely, so what matters now is that no count is stated.
    const lines = deterministicLines(makePayload({ behavior: [BEHAVIOR] }));

    expect(lines.behaviorLine).not.toContain('נרשמו');
    expect(lines.behaviorLine).toMatch(/^נרשם /);
  });

  it('renders a complete message when every line is a fallback', () => {
    const payload = makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicLines(payload));

    expect(text).toContain('אבי');
    expect(text).toContain('איחור');
    expect(text).toContain('לפתור עמוד 42');
  });
});

const RELEASE = {
  id: '64',
  releaseDate: new Date('2026-11-18T00:00:00Z'),
  startHour: '11:30:00',
  remark: 'אבקש לשחרר את אבי, יש לו תור לרופא',
};

const ACTIVITY = {
  id: '7',
  title: 'טיול שנתי לגליל',
  activityStartDate: new Date('2026-11-25T00:00:00Z'),
  endAnswerDate: new Date('2026-11-20T00:00:00Z'),
};

describe('renderReport releases and activities', () => {
  it('renders an early release with its day and a readable time', () => {
    const payload = makePayload({ releases: [RELEASE] });

    const text = renderReport(payload, deterministicLines(payload));

    expect(text).toContain('שחרור מוקדם');
    expect(text).toContain('18/11/2026');
    // "11:30:00" is a database value, not something to put in front of a parent.
    expect(text).toContain('11:30');
    expect(text).not.toContain('11:30:00');
  });

  it("drops the parent's own remark from a release", () => {
    // It went with the bullets. It was the parent's own text and the one other
    // place the child's name appeared in the message, so nothing they did not
    // already know is lost -- and the name now appears exactly once.
    const payload = makePayload({ releases: [RELEASE] });

    const text = renderReport(payload, deterministicLines(payload));

    expect(text).not.toContain('תור לרופא');
  });

  it('renders a consent form with the deadline to answer by', () => {
    const payload = makePayload({ activities: [ACTIVITY] });

    const text = renderReport(payload, deterministicLines(payload));

    expect(text).toContain('טיול שנתי לגליל');
    expect(text).toContain('20/11/2026');
  });

  it('omits both sections when there is nothing in them', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    expect(text).not.toContain('שחרור מוקדם');
    expect(text).not.toContain('אישור');
  });

  it('states releases and forms in the deterministic fallback', () => {
    const lines = deterministicLines(
      makePayload({ releases: [RELEASE], activities: [ACTIVITY] }),
    );

    expect(lines.releaseLine).toContain('18/11/2026');
    expect(lines.activityLine).toContain('טיול שנתי לגליל');
  });

  it('leaves the new fallback lines empty when there is nothing to count', () => {
    const lines = deterministicLines(makePayload());

    expect(lines.releaseLine).toBe('');
    expect(lines.activityLine).toBe('');
  });
});

describe('renderReport without item bullets', () => {
  const FULL = makePayload({
    behavior: [BEHAVIOR],
    homeworkNew: [HOMEWORK],
    homeworkDueTomorrow: [{ ...HOMEWORK, id: 'hw-due', estimatedDueDate: new Date('2026-11-18T00:00:00Z') }],
    releases: [
      {
        id: '64',
        releaseDate: new Date('2026-11-18T00:00:00Z'),
        startHour: '11:30:00',
        remark: 'אבקש לשחרר את אבי, יש לו תור לרופא',
      },
    ],
    activities: [
      {
        id: '7',
        title: 'טיול שנתי לגליל',
        activityStartDate: new Date('2026-11-25T00:00:00Z'),
        endAnswerDate: new Date('2026-11-20T00:00:00Z'),
      },
    ],
  });

  it('writes no bullet lines at all', () => {
    // The prose above each section already says it. A list repeating the same
    // facts underneath is the raw record, not a message to a person.
    const text = renderReport(FULL, LINES);

    expect(text).not.toContain('•');
  });

  it('keeps the section headers and the prose', () => {
    const text = renderReport(FULL, LINES);

    expect(text).toContain('התנהגות ונוכחות');
    expect(text).toContain('היה איחור אחד בשיעור מתמטיקה.');
    expect(text).toContain('שחרור מוקדם');
  });

  it('still labels the estimated deadline, from the template and not the model', () => {
    // ADR-0026 promises this label is never left to the model. With the
    // bullets gone it is a parenthetical on the section's prose instead.
    const text = renderReport(FULL, LINES);

    expect(text).toContain('צפי הגשה: 18/11/2026');
  });

  it('keeps the standing caveat whenever an estimate is shown', () => {
    const text = renderReport(FULL, LINES);

    expect(text).toContain('צפי בלבד');
  });

  it('no longer repeats the child name through the release remark', () => {
    // The remark was the only other place the name appeared. It was the
    // parent's own text, written by them, so nothing they need is lost.
    const text = renderReport(FULL, LINES);

    expect(text.split('אבי').length - 1).toBe(1);
  });
});

describe('deterministicLines must carry the facts now', () => {
  it('names the behavior event and its remark, not just a count', () => {
    // With no bullets, a counting fallback would tell a parent that "one note
    // was recorded" and never what it was.
    const lines = deterministicLines(makePayload({ behavior: [BEHAVIOR] }));

    expect(lines.behaviorLine).toContain('איחור');
    expect(lines.behaviorLine).toContain('מתמטיקה');
    expect(lines.behaviorLine).toContain('הגיע באיחור של 10 דקות');
  });

  it('quotes the homework text as the teacher wrote it', () => {
    const lines = deterministicLines(makePayload({ homeworkNew: [HOMEWORK] }));

    expect(lines.homeworkLine).toContain('חשבון');
    expect(lines.homeworkLine).toContain('לפתור עמוד 42');
  });

  it('gives the release day and time', () => {
    const lines = deterministicLines(
      makePayload({
        releases: [
          {
            id: '64',
            releaseDate: new Date('2026-11-18T00:00:00Z'),
            startHour: '11:30:00',
            remark: null,
          },
        ],
      }),
    );

    expect(lines.releaseLine).toContain('18/11/2026');
    expect(lines.releaseLine).toContain('11:30');
  });

  it('gives the consent form title and its answer deadline', () => {
    const lines = deterministicLines(
      makePayload({
        activities: [
          {
            id: '7',
            title: 'טיול שנתי לגליל',
            activityStartDate: new Date('2026-11-25T00:00:00Z'),
            endAnswerDate: new Date('2026-11-20T00:00:00Z'),
          },
        ],
      }),
    );

    expect(lines.activityLine).toContain('טיול שנתי לגליל');
    expect(lines.activityLine).toContain('20/11/2026');
  });
});
