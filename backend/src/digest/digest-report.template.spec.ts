import { deterministicLines, formatSchoolDate, renderReport } from './digest-report.template';
import type { DigestLines, DigestPayload } from './digest.types';

const REPORT_FOR = new Date('2026-11-17T00:00:00Z');

const LINES: DigestLines = {
  headline: 'יום רגוע עם הערה אחת',
  behaviorLine: 'היה איחור אחד בשיעור מתמטיקה.',
  positiveLine: 'קיבל חיזוק חיובי בספרות.',
  boardLine: 'יש הודעה חדשה על לוח המודעות.',
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
    board: [],
    ...overrides,
  };
}

const NOTICE = {
  id: '4211',
  text: 'ביום חמישי יום ספורט',
  expirationDate: new Date('2026-11-30T00:00:00Z'),
};

const PRAISE = {
  id: 'beh-praise',
  achvaName: 'חיזוק חיובי',
  classification: 'positive',
  justifiable: true,
  subject: 'ספרות',
  remark: 'השתתפות יוצאת דופן',
  lessonDate: REPORT_FOR,
  eventAt: new Date('2026-11-17T09:00:00Z'),
};

const ABSENCE = {
  id: 'beh-absent',
  achvaName: 'חיסור',
  classification: 'attention',
  justifiable: false,
  subject: 'מתמטיקה',
  remark: null,
  lessonDate: REPORT_FOR,
  eventAt: new Date('2026-11-17T08:00:00Z'),
};

const BEHAVIOR = {
  id: 'beh-1',
  achvaName: 'איחור',
  classification: 'attention',
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
    // ADR-0027 records the departure; this label is where it is honoured.
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

  it('carries no standing caveat under an estimate', () => {
    // The explanatory sentence was removed: it ran to a full line, repeated
    // every day, and said the same thing in every message. The `צפי` label on
    // the date is what marks the date as derived now -- see ADR-0027.
    const text = renderReport(
      makePayload({
        homeworkDueTomorrow: [
          { ...HOMEWORK, estimatedDueDate: new Date('2026-11-18T00:00:00Z') },
        ],
      }),
      LINES,
    );

    expect(text).not.toContain('צפי בלבד');
    expect(text).not.toContain('אינו מספק תאריך הגשה');
    // What remains, and must: the word "צפי" in front of the date.
    expect(text).toContain('צפי הגשה: 18/11/2026');
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

  it('gives a positive note its own section, away from what needs attention', () => {
    // The single section read the same for both: "נרשם חיזוק חיובי" and
    // "נרשם חיסור" sat side by side under one neutral heading.
    const text = renderReport(makePayload({ behavior: [PRAISE] }), LINES);

    expect(text).toContain('חיזוק חיובי');
    expect(text).toContain('קיבל חיזוק חיובי בספרות.');
    expect(text).not.toContain('התנהגות ונוכחות');
  });

  it('keeps an event needing attention out of the positive section', () => {
    const text = renderReport(makePayload({ behavior: [ABSENCE] }), LINES);

    expect(text).toContain('התנהגות ונוכחות');
    expect(text).not.toContain('חיזוק חיובי\n');
  });

  it('renders both sections on a day that had both', () => {
    const text = renderReport(makePayload({ behavior: [ABSENCE, PRAISE] }), LINES);

    expect(text).toContain('התנהגות ונוכחות');
    expect(text).toContain('חיזוק חיובי');
    expect(text.indexOf('התנהגות ונוכחות')).toBeLessThan(text.indexOf('חיזוק חיובי'));
  });

  it('marks an unexcused event, so it does not read like an excused one', () => {
    // The marker is the template's, not the model's -- the same reasoning as
    // the צפי label: a structural fact must not depend on the prose.
    const text = renderReport(makePayload({ behavior: [ABSENCE] }), LINES);

    expect(text).toContain('לא מוצדק');
    expect(text).toContain('חיסור');
  });

  it('does not mark an event the school counts as excusing itself', () => {
    const excused = { ...ABSENCE, justifiable: true };

    const text = renderReport(makePayload({ behavior: [excused] }), LINES);

    expect(text).not.toContain('לא מוצדק');
  });

  it('gives the message board its own section', () => {
    const text = renderReport(makePayload({ board: [NOTICE] }), LINES);

    expect(text).toContain('הודעות מלוח המודעות');
    expect(text).toContain('יש הודעה חדשה על לוח המודעות.');
  });

  it('shows no board section on a day with no new notice', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES);

    expect(text).not.toContain('הודעות מלוח המודעות');
  });

  it('keeps the link last, below the board section', () => {
    const text = renderReport(makePayload({ board: [NOTICE] }), LINES, {
      publicBaseUrl: 'https://mashov.mitya.dev',
    });

    expect(text.indexOf('הודעות מלוח המודעות')).toBeLessThan(text.indexOf('/home'));
  });

  it('closes with a link to the site when a base URL is configured', () => {
    const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES, {
      publicBaseUrl: 'https://mashov.mitya.dev',
    });

    // Last, so the facts are what shows in the chat list preview.
    expect(text.trim().split('\n').pop()).toBe('https://mashov.mitya.dev/home');
  });

  it('links to an identifier-free page, never to the child', () => {
    // A Telegram chat is a shared, forwardable artifact: a guid in someone
    // else's hands outlives the message it arrived in.
    const text = renderReport(
      makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] }),
      LINES,
      { publicBaseUrl: 'https://mashov.mitya.dev' },
    );

    expect(text).toContain('/home');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(text).not.toContain('stu-');
  });

  it('renders no link line at all when no base URL is configured', () => {
    // Fail closed: "undefined/home" in a parent's chat is worse than no link.
    for (const options of [undefined, {}, { publicBaseUrl: null }, { publicBaseUrl: '' }]) {
      const text = renderReport(makePayload({ behavior: [BEHAVIOR] }), LINES, options);

      expect(text).not.toContain('undefined');
      expect(text).not.toMatch(/https?:\/\//);
    }
  });
});

describe('deterministicLines', () => {
  // The fallback when the LLM times out, refuses, or returns malformed output.
  // A parent getting a plainer message beats a parent getting nothing.
  it('states the notice itself, since the prose is the only place it appears', () => {
    const lines = deterministicLines(makePayload({ board: [NOTICE] }));

    expect(lines.boardLine).toContain('ביום חמישי יום ספורט');
  });

  it('leaves boardLine empty when the board had nothing new', () => {
    expect(deterministicLines(makePayload()).boardLine).toBe('');
  });

  it('writes a positive note into positiveLine and leaves behaviorLine empty', () => {
    const lines = deterministicLines(makePayload({ behavior: [PRAISE] }));

    expect(lines.positiveLine).toContain('חיזוק חיובי');
    expect(lines.behaviorLine).toBe('');
  });

  it('writes an attention event into behaviorLine and leaves positiveLine empty', () => {
    const lines = deterministicLines(makePayload({ behavior: [ABSENCE] }));

    expect(lines.behaviorLine).toContain('חיסור');
    expect(lines.positiveLine).toBe('');
  });

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
    // ADR-0027 promises this label is never left to the model. With the
    // bullets gone it is a parenthetical on the section's prose instead.
    const text = renderReport(FULL, LINES);

    expect(text).toContain('צפי הגשה: 18/11/2026');
  });

  it('ends on the last section, with no trailing explanatory line', () => {
    const text = renderReport(FULL, LINES);

    expect(text.trimEnd().endsWith('.)')).toBe(false);
    expect(text).not.toContain('צפי בלבד');
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
