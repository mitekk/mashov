import { deterministicLines, formatSchoolDate, renderReport } from './digest-report.template';
import type { DigestLines, DigestPayload } from './digest.types';

const REPORT_FOR = new Date('2026-11-17T00:00:00Z');

const LINES: DigestLines = {
  headline: 'יום רגוע עם הערה אחת',
  behaviorLine: 'היה איחור אחד בשיעור מתמטיקה.',
  homeworkLine: 'ניתנה מטלה אחת בחשבון.',
  dueTomorrowLine: 'מטלה אחת צפויה להיבדק מחר.',
};

function makePayload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    childFirstName: 'אבי',
    reportFor: REPORT_FOR,
    behavior: [],
    homeworkNew: [],
    homeworkDueTomorrow: [],
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
  it('opens with the headline and names the child and the day', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    expect(text).toContain('יום רגוע עם הערה אחת');
    expect(text).toContain('אבי');
    expect(text).toContain('17/11/2026');
  });

  it('renders a behavior section with the event and its remark', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    expect(text).toContain('איחור');
    expect(text).toContain('מתמטיקה');
    expect(text).toContain('הגיע באיחור של 10 דקות');
    expect(text).toContain(LINES.behaviorLine);
  });

  it('omits sections that have no items', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    // Only behavior has items, so neither homework section should appear -- and
    // the LLM's prose for them must not leak in either.
    expect(text).not.toContain(LINES.homeworkLine);
    expect(text).not.toContain(LINES.dueTomorrowLine);
  });

  it('renders newly assigned homework', () => {
    const text = renderReport(makePayload({ homeworkNew: [HOMEWORK] }), LINES);

    expect(text).toContain('חשבון');
    expect(text).toContain('לפתור עמוד 42');
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

    const bullets = text.split('\n').filter((line) => line.startsWith('•'));
    expect(bullets.some((line) => line.includes('צפי הגשה'))).toBe(true);
    expect(text).toContain('18/11/2026');
    // No bullet may label the date "תאריך הגשה" -- that would assert a real
    // deadline the data cannot support. The caveat below the section uses the
    // phrase too, but only to say Mashov supplies no such date, so the
    // assertion is scoped to the bullets where the claim would be made.
    expect(bullets.every((line) => !line.includes('תאריך הגשה'))).toBe(true);
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

  it('counts what happened rather than inventing prose', () => {
    const lines = deterministicLines(
      makePayload({ behavior: [BEHAVIOR, { ...BEHAVIOR, id: 'beh-2' }] }),
    );

    expect(lines.behaviorLine).toContain('2');
  });

  it('renders a complete message when every line is a fallback', () => {
    const payload = makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicLines(payload));

    expect(text).toContain('אבי');
    expect(text).toContain('איחור');
    expect(text).toContain('לפתור עמוד 42');
  });
});
