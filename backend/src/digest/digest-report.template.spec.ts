import {
  deterministicItemLines,
  deterministicProse,
  digestItemRef,
  formatSchoolDate,
  renderReport,
} from './digest-report.template';
import { TELEGRAM_CHUNK_LIMIT } from '../telegram/telegram-http';
import { stripTelegramHtml } from '../telegram/telegram-html';
import type { DigestPayload, DigestProse } from './digest.types';

const REPORT_FOR = new Date('2026-11-17T00:00:00Z');
const BASE = 'https://mashov.mitya.dev';
const GUID = 'stu-abc-123';

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

/** The prose the model would have written for a payload, one line per item. */
function modelProse(payload: DigestPayload, overrides: Partial<DigestProse> = {}): DigestProse {
  return {
    headline: 'יום רגוע עם הערה אחת',
    intros: {},
    itemLines: deterministicItemLines(payload),
    ...overrides,
  };
}

describe('formatSchoolDate', () => {
  it('formats the school day the Israeli way, from UTC fields', () => {
    expect(formatSchoolDate(REPORT_FOR)).toBe('17/11/2026');
  });
});

describe('digestItemRef', () => {
  it('namespaces a ref by its section', () => {
    expect(digestItemRef('homeworkNew', 'hw-1')).toBe('homeworkNew:hw-1');
  });

  it('gives one homework row two refs when it is both new and due tomorrow', () => {
    // A bare id would make the two sections share one sentence, so a line
    // written about tomorrow would show up under "new homework".
    expect(digestItemRef('homeworkNew', 'hw-1')).not.toBe(digestItemRef('dueTomorrow', 'hw-1'));
  });

  it('separates the two behaviour sections, which read from one list', () => {
    expect(digestItemRef('behavior', 'beh-1')).not.toBe(digestItemRef('positive', 'beh-1'));
  });
});

describe('renderReport header', () => {
  it('opens with the child, the Hebrew weekday and the day', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(payload, modelProse(payload));

    // The weekday is deterministic and the cheapest "human" win in the
    // message: a parent reads "יום שלישי" faster than they parse 17/11.
    expect(text.split('\n')[0]).toBe('אבי · יום שלישי, 17/11/2026');
  });

  it('names Saturday without the יום prefix, which is how Hebrew says it', () => {
    const payload = makePayload({
      reportFor: new Date('2026-11-21T00:00:00Z'),
      behavior: [BEHAVIOR],
    });

    expect(renderReport(payload, modelProse(payload)).split('\n')[0]).toBe(
      'אבי · שבת, 21/11/2026',
    );
  });

  it('puts the headline under the header', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(payload, modelProse(payload));

    expect(text).toContain('יום רגוע עם הערה אחת');
  });

  it('names the child once only, in that opening line', () => {
    // The name is in the header, so prose that repeats it reads like a form
    // letter. The deterministic lines must not reintroduce it either.
    const payload = makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicProse(payload));

    expect(text.split('אבי').length - 1).toBe(1);
  });
});

describe('renderReport structure', () => {
  it('renders a bold section title with its emoji marker', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(payload, modelProse(payload));

    expect(text).toContain('<b>⚠️ התנהגות ונוכחות</b>');
  });

  it('renders one bullet per item', () => {
    // These are NOT the item bullets ADR-0026 removed. Those were the raw
    // record stapled under a paragraph; these are the prose itself, one line
    // per thing that happened. See ADR-0047.
    const payload = makePayload({
      behavior: [BEHAVIOR, { ...BEHAVIOR, id: 'beh-2', achvaName: 'הפרעה', subject: 'אנגלית' }],
    });

    const text = renderReport(payload, modelProse(payload));

    expect(text.split('\n').filter((line) => line.startsWith('• '))).toHaveLength(2);
    expect(text).toContain('איחור');
    expect(text).toContain('הפרעה');
  });

  it('renders a section intro above the bullets when the model wrote one', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(
      payload,
      modelProse(payload, { intros: { behavior: 'שני דברים קטנים, שניהם באותו שיעור.' } }),
    );

    const lines = text.split('\n');
    const intro = lines.indexOf('שני דברים קטנים, שניהם באותו שיעור.');
    expect(intro).toBeGreaterThan(-1);
    expect(lines[intro - 1]).toContain('התנהגות ונוכחות');
    expect(lines[intro + 1].startsWith('• ')).toBe(true);
  });

  it('renders no intro line when the model left it empty', () => {
    // The intro only earns its place when it says something the item lines do
    // not. An empty one must not become a blank line in the chat.
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(payload, modelProse(payload, { intros: { behavior: '   ' } }));

    expect(text).not.toMatch(/\n\s*\n\s*•/);
  });

  it('quotes a teacher remark as a blockquote, so their words are visibly theirs', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(payload, modelProse(payload));

    expect(text).toContain('<blockquote>הגיע באיחור של 10 דקות</blockquote>');
  });

  it('renders no blockquote for an event the teacher left no remark on', () => {
    const payload = makePayload({ behavior: [ABSENCE] });

    expect(renderReport(payload, modelProse(payload))).not.toContain('<blockquote>');
  });

  it('omits sections that have no items', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(
      payload,
      modelProse(payload, {
        intros: { homeworkNew: 'מטלה אחת בחשבון', dueTomorrow: 'מחר יש מה להגיש' },
      }),
    );

    // Not even the model's intro for them may leak in.
    expect(text).not.toContain('שיעורי בית חדשים');
    expect(text).not.toContain('מטלה אחת בחשבון');
    expect(text).not.toContain('צפי הגשה למחר');
  });

  it('renders every section a full day has, each with its marker', () => {
    const payload = makePayload({
      behavior: [ABSENCE],
      homeworkNew: [HOMEWORK],
      homeworkDueTomorrow: [{ ...HOMEWORK, id: 'hw-due', estimatedDueDate: new Date('2026-11-18T00:00:00Z') }],
      releases: [RELEASE],
      activities: [ACTIVITY],
      board: [NOTICE],
    });

    const text = renderReport(payload, deterministicProse(payload));

    for (const title of [
      '⚠️ התנהגות ונוכחות',
      '📚 שיעורי בית חדשים',
      '🕑 שחרור מוקדם',
      '✍️ אישורים שממתינים לך',
      '📢 הודעות מלוח המודעות',
      '📅 צפי הגשה למחר',
    ]) {
      expect(text).toContain(title);
    }
  });

  it('gives praise its own section, away from what needs attention', () => {
    const payload = makePayload({ behavior: [PRAISE] });

    const text = renderReport(payload, modelProse(payload));

    expect(text).toContain('🌟 חיזוק חיובי');
    expect(text).not.toContain('התנהגות ונוכחות');
  });

  it('keeps an event needing attention out of the positive section', () => {
    const payload = makePayload({ behavior: [ABSENCE] });

    const text = renderReport(payload, modelProse(payload));

    expect(text).toContain('התנהגות ונוכחות');
    expect(text).not.toContain('חיזוק חיובי');
  });

  it('renders both behaviour sections on a day that had both, attention first', () => {
    const payload = makePayload({ behavior: [ABSENCE, PRAISE] });

    const text = renderReport(payload, deterministicProse(payload));

    expect(text.indexOf('התנהגות ונוכחות')).toBeLessThan(text.indexOf('🌟 חיזוק חיובי'));
  });

  it('marks an unexcused event from the template, not from the prose', () => {
    // A structural fact must not depend on whether the model mentioned it.
    const payload = makePayload({ behavior: [ABSENCE] });

    const text = renderReport(payload, modelProse(payload));

    expect(text).toContain('לא מוצדק');
    expect(text).toContain('חיסור');
  });

  it('does not mark an event the school counts as excusing itself', () => {
    const payload = makePayload({ behavior: [{ ...ABSENCE, justifiable: true }] });

    expect(renderReport(payload, modelProse(payload))).not.toContain('לא מוצדק');
  });

  it('labels a derived deadline as an estimate and never as a due date', () => {
    // Mashov exposes no due-date field at all (ADR-0027), so promising one
    // would be a lie. The label is appended by the template.
    const payload = makePayload({
      homeworkDueTomorrow: [{ ...HOMEWORK, estimatedDueDate: new Date('2026-11-18T00:00:00Z') }],
    });

    const text = renderReport(payload, modelProse(payload));

    expect(text).toContain('צפי הגשה: 18/11/2026');
    const labelLine = text.split('\n').find((line) => line.includes('צפי הגשה: '));
    expect(labelLine).not.toContain('תאריך הגשה');
  });

  it('says "מחר" when the section survived without an estimate date', () => {
    const payload = makePayload({ homeworkDueTomorrow: [HOMEWORK] });

    expect(renderReport(payload, modelProse(payload))).toContain('צפי הגשה: מחר');
  });

  it('carries no standing caveat under an estimate', () => {
    const payload = makePayload({
      homeworkDueTomorrow: [{ ...HOMEWORK, estimatedDueDate: new Date('2026-11-18T00:00:00Z') }],
    });

    const text = renderReport(payload, modelProse(payload));

    expect(text).not.toContain('צפי בלבד');
    expect(text).not.toContain('אינו מספק תאריך הגשה');
  });

  it('shows no estimate label on a day with nothing due', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    expect(renderReport(payload, modelProse(payload))).not.toContain('צפי הגשה');
  });

  it("drops the parent's own remark from a release", () => {
    // Their own text, and the one other place the child's name appeared.
    const payload = makePayload({ releases: [RELEASE] });

    const text = renderReport(payload, deterministicProse(payload));

    expect(text).toContain('11:30');
    expect(text).not.toContain('11:30:00');
    expect(text).not.toContain('תור לרופא');
  });

  it('renders a consent form with the deadline to answer by', () => {
    const payload = makePayload({ activities: [ACTIVITY] });

    const text = renderReport(payload, deterministicProse(payload));

    expect(text).toContain('טיול שנתי לגליל');
    expect(text).toContain('20/11/2026');
  });

  it('renders the consent section from the template whatever the model wrote', () => {
    // The model is handed no consent forms at all (ADR-0035): the prose is
    // shared between the parents of one child, and the forms belong to the
    // parent rather than to the child.
    const payload = makePayload({ activities: [ACTIVITY] });

    const text = renderReport(
      payload,
      modelProse(payload, {
        itemLines: { [digestItemRef('activity', '7')]: 'המצאתי טופס אחר' },
        intros: { activity: 'המצאתי גם מבוא' },
      }),
    );

    expect(text).toContain('טיול שנתי לגליל');
    expect(text).not.toContain('המצאתי');
  });

  it('never leaks a guid or a teacher name into the message body', () => {
    const payload = makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, modelProse(payload));

    expect(text).not.toContain('reporter');
    expect(text).not.toContain(GUID);
  });
});

describe('renderReport links', () => {
  const FULL = makePayload({
    behavior: [BEHAVIOR, PRAISE],
    homeworkNew: [HOMEWORK],
    homeworkDueTomorrow: [{ ...HOMEWORK, id: 'hw-due', estimatedDueDate: new Date('2026-11-18T00:00:00Z') }],
    releases: [RELEASE],
    activities: [ACTIVITY],
    board: [NOTICE],
  });

  function rendered(overrides: Partial<DigestPayload> = {}) {
    const payload = makePayload({ ...FULL, ...overrides });
    return renderReport(payload, deterministicProse(payload), {
      publicBaseUrl: BASE,
      studentGuid: GUID,
    });
  }

  it('links a behaviour item to the note itself, not to a page the parent must search', () => {
    // The reversal of the identifier-free rule. The chat is one the parent
    // proved they control, the guid is useless without a session that owns the
    // child, and the cost was paid on every message. See ADR-0047.
    expect(rendered()).toContain(`<a href="${BASE}/children/${GUID}/behavior/beh-1">`);
  });

  it('links a homework item to the assignment itself', () => {
    expect(rendered()).toContain(`<a href="${BASE}/children/${GUID}/homework/hw-1">`);
  });

  it('links a due-tomorrow item to its own assignment', () => {
    expect(rendered()).toContain(`<a href="${BASE}/children/${GUID}/homework/hw-due">`);
  });

  it('links each section header to that section', () => {
    const text = rendered();

    expect(text).toContain(`<b>⚠️ <a href="${BASE}/children/${GUID}?section=behavior&amp;behavior=attention">התנהגות ונוכחות</a></b>`);
    expect(text).toContain(`?section=behavior&amp;behavior=positive`);
    expect(text).toContain(`?section=homework&amp;behavior=all`);
    expect(text).toContain(`?section=notices&amp;behavior=all`);
  });

  it('links a board notice to the notices section, since it has no detail route', () => {
    const text = rendered();
    const noticeLine = text.split('\n').find((line) => line.includes('יום ספורט'));

    expect(noticeLine).toContain(`${BASE}/children/${GUID}?section=notices`);
  });

  it('links an early release to the child, because it lives in a dialog', () => {
    const releaseLine = rendered().split('\n').find((line) => line.includes('שחרור מוקדם ב-'));

    expect(releaseLine).toContain(`<a href="${BASE}/children/${GUID}">`);
  });

  it('gives a consent form no link at all, because it has no web surface', () => {
    const text = rendered();
    const formLine = text.split('\n').find((line) => line.includes('טיול שנתי'));

    expect(formLine).not.toContain('<a href');
    expect(text).not.toContain('activities');
  });

  it('carries no bare URL and no trailing link line', () => {
    // Every URL is an anchor's href now. The /home line is gone: it was the
    // thing that sent a parent to a page they then had to search.
    const text = rendered();

    // "/home" as a page of its own -- not the "/homework" of a deep link.
    expect(text).not.toMatch(/\/home(?!work)/);
    expect(text.trimEnd().split('\n').pop()).not.toMatch(/^https?:/);
    for (const line of text.split('\n')) {
      const withoutHrefs = line.replace(/href="[^"]*"/g, '');
      expect(withoutHrefs).not.toContain('http');
    }
  });

  it('renders every section unanchored when no base URL is configured', () => {
    // Fail closed: "undefined/children/..." in a parent's chat is worse than
    // no link at all.
    for (const options of [undefined, {}, { publicBaseUrl: null, studentGuid: GUID }, { publicBaseUrl: '' }]) {
      const text = renderReport(FULL, deterministicProse(FULL), options);

      expect(text).not.toContain('undefined');
      expect(text).not.toContain('<a href');
      expect(text).toContain('התנהגות ונוכחות');
    }
  });

  it('renders no anchors when the studentGuid is missing, but still renders the report', () => {
    // A guid the caller could not supply must cost the links and nothing else.
    const text = renderReport(FULL, deterministicProse(FULL), { publicBaseUrl: BASE });

    expect(text).not.toContain('<a href');
    expect(text).toContain('איחור');
  });
});

describe('renderReport escaping', () => {
  const HOSTILE = {
    ...BEHAVIOR,
    achvaName: 'הערה <script>',
    subject: 'מתמטיקה & מדעים',
    remark: 'אמר "שלום" <b>בקול</b> & חייך',
  };

  it('escapes the three reserved characters in a teacher remark', () => {
    const payload = makePayload({ behavior: [HOSTILE] });

    const text = renderReport(payload, deterministicProse(payload));

    expect(text).toContain('&lt;b&gt;בקול&lt;/b&gt;');
    expect(text).toContain('&amp;');
    expect(text).not.toContain('<script>');
  });

  it('leaves the remark readable once the markup is taken back out', () => {
    // What the parent sees, and what the sender's flat retry would send.
    const payload = makePayload({ behavior: [HOSTILE] });

    const flat = stripTelegramHtml(renderReport(payload, deterministicProse(payload)));

    expect(flat).toContain('אמר "שלום" <b>בקול</b> & חייך');
  });

  it('escapes a model-written line, which is untrusted text too', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(
      payload,
      modelProse(payload, {
        headline: 'יום <b>טוב</b> & רגוע',
        itemLines: { [digestItemRef('behavior', 'beh-1')]: 'איחור <i>קטן</i>' },
      }),
    );

    expect(text).toContain('יום &lt;b&gt;טוב&lt;/b&gt; &amp; רגוע');
    expect(text).toContain('איחור &lt;i&gt;קטן&lt;/i&gt;');
  });

  it('escapes the ampersand in a section link, so the href itself parses', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(payload, deterministicProse(payload), {
      publicBaseUrl: BASE,
      studentGuid: GUID,
    });

    expect(text).toContain('behavior=attention');
    expect(text).not.toMatch(/href="[^"]*[^p]&[^a]/);
  });
});

describe('renderReport line invariant', () => {
  it('renders no line longer than the chunk limit, however long the facts are', () => {
    // This is what makes HTML safe to chunk. chunkTelegramText prefers a blank
    // line, then a newline, and only then cuts hard -- and a hard cut is the
    // one cut that can land inside a tag. Keeping every line well inside the
    // limit means a real message never reaches that cut.
    const long = 'א'.repeat(8000);
    const payload = makePayload({
      behavior: Array.from({ length: 5 }, (_, i) => ({
        ...BEHAVIOR,
        id: `beh-${i}`,
        achvaName: long,
        subject: `${long} & ${long}`,
        remark: `${long} <b> ${long}`,
      })),
      homeworkNew: Array.from({ length: 5 }, (_, i) => ({
        ...HOMEWORK,
        id: `hw-${i}`,
        homeworkText: long,
        remark: long,
      })),
      board: [{ ...NOTICE, text: `${long}\n${long}` }],
      releases: [RELEASE],
      activities: [{ ...ACTIVITY, title: long }],
    });

    const text = renderReport(
      payload,
      modelProse(payload, { headline: long, intros: { behavior: long, board: long } }),
      { publicBaseUrl: BASE, studentGuid: GUID },
    );

    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
    }
  });

  it('opens and closes every tag inside one line', () => {
    const payload = makePayload({
      behavior: [{ ...BEHAVIOR, remark: 'שורה אחת\nשורה שנייה' }],
      board: [{ ...NOTICE, text: 'הודעה\nעל\nשלוש שורות' }],
    });

    const text = renderReport(payload, deterministicProse(payload), {
      publicBaseUrl: BASE,
      studentGuid: GUID,
    });

    for (const line of text.split('\n')) {
      expect((line.match(/<[a-z]/g) ?? []).length).toBe((line.match(/<\//g) ?? []).length);
    }
  });
});

describe('renderReport unsent files', () => {
  const TOO_LARGE = [
    { fileName: 'מצגת כבדה.pptx', itemType: 'homework' as const, itemId: 'hw-1' },
  ];

  it('names a file too large to send and links the item that holds it', () => {
    // Not to /home. The parent needs the assignment the file hangs off.
    const payload = makePayload({ homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicProse(payload), {
      publicBaseUrl: BASE,
      studentGuid: GUID,
      unsentFiles: TOO_LARGE,
    });

    expect(text).toContain('📎 קבצים');
    expect(text).toContain('קובץ גדול מדי לשליחה');
    expect(text).toContain(`<a href="${BASE}/children/${GUID}/homework/hw-1">מצגת כבדה.pptx</a>`);
  });

  it('links a behaviour attachment to its behaviour note', () => {
    const payload = makePayload({ behavior: [BEHAVIOR] });

    const text = renderReport(payload, deterministicProse(payload), {
      publicBaseUrl: BASE,
      studentGuid: GUID,
      unsentFiles: [{ fileName: 'סריקה.pdf', itemType: 'behavior', itemId: 'beh-1' }],
    });

    expect(text).toContain(`${BASE}/children/${GUID}/behavior/beh-1`);
  });

  it('still names the file when there is nothing to link it to', () => {
    // Silence would make the report quietly less than the day it describes.
    const payload = makePayload({ homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicProse(payload), { unsentFiles: TOO_LARGE });

    expect(text).toContain('מצגת כבדה.pptx');
    expect(text).not.toContain('<a href');
  });

  it('escapes a hostile filename', () => {
    const payload = makePayload({ homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicProse(payload), {
      unsentFiles: [{ fileName: '<b>x</b> & y.pdf', itemType: 'homework', itemId: 'hw-1' }],
    });

    expect(text).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y.pdf');
  });

  it('renders no file section when nothing was held back', () => {
    const payload = makePayload({ homeworkNew: [HOMEWORK] });

    expect(renderReport(payload, deterministicProse(payload))).not.toContain('📎');
  });
});

describe('deterministicItemLines', () => {
  // The fallback when the LLM times out, refuses, or returns unusable output,
  // and -- per ITEM now -- whenever it returns nothing for an item that exists.
  it('keys each line by its section-namespaced ref', () => {
    const payload = makePayload({ behavior: [BEHAVIOR, PRAISE], homeworkNew: [HOMEWORK] });

    const lines = deterministicItemLines(payload);

    expect(Object.keys(lines).sort()).toEqual(
      ['behavior:beh-1', 'homeworkNew:hw-1', 'positive:beh-praise'].sort(),
    );
  });

  it('names the behaviour event and its subject', () => {
    const lines = deterministicItemLines(makePayload({ behavior: [BEHAVIOR] }));

    expect(lines['behavior:beh-1']).toContain('איחור');
    expect(lines['behavior:beh-1']).toContain('מתמטיקה');
  });

  it('leaves the teacher remark to the template, which quotes it', () => {
    // It is rendered as a blockquote under the bullet, so repeating it inside
    // the sentence would print it twice.
    const lines = deterministicItemLines(makePayload({ behavior: [BEHAVIOR] }));

    expect(lines['behavior:beh-1']).not.toContain('הגיע באיחור של 10 דקות');
  });

  it('quotes the homework text as the teacher wrote it', () => {
    const lines = deterministicItemLines(makePayload({ homeworkNew: [HOMEWORK] }));

    expect(lines['homeworkNew:hw-1']).toContain('חשבון');
    expect(lines['homeworkNew:hw-1']).toContain('לפתור עמוד 42');
  });

  it('states the notice itself, not that a notice exists', () => {
    const lines = deterministicItemLines(makePayload({ board: [NOTICE] }));

    expect(lines['board:4211']).toContain('ביום חמישי יום ספורט');
  });

  it('gives the release day and a readable time', () => {
    const lines = deterministicItemLines(makePayload({ releases: [RELEASE] }));

    expect(lines['release:64']).toContain('18/11/2026');
    expect(lines['release:64']).toContain('11:30');
  });

  it('gives a consent form its title and answer deadline', () => {
    const lines = deterministicItemLines(makePayload({ activities: [ACTIVITY] }));

    expect(lines['activity:7']).toContain('טיול שנתי לגליל');
    expect(lines['activity:7']).toContain('20/11/2026');
  });

  it('writes two refs for a homework row that is both new and due tomorrow', () => {
    const lines = deterministicItemLines(
      makePayload({ homeworkNew: [HOMEWORK], homeworkDueTomorrow: [HOMEWORK] }),
    );

    expect(lines['homeworkNew:hw-1']).toBeDefined();
    expect(lines['dueTomorrow:hw-1']).toBeDefined();
  });

  it('returns no lines for a payload with nothing in it', () => {
    expect(deterministicItemLines(makePayload())).toEqual({});
  });

  it('states no count, for one item or for several', () => {
    const lines = deterministicItemLines(makePayload({ behavior: [BEHAVIOR] }));

    expect(lines['behavior:beh-1']).not.toContain('נרשמו');
    expect(lines['behavior:beh-1']).toMatch(/^נרשם /);
  });
});

describe('deterministicProse', () => {
  it('carries a Hebrew headline and no intros', () => {
    const prose = deterministicProse(makePayload({ behavior: [BEHAVIOR] }));

    expect(prose.headline).toMatch(/[֐-׿]/);
    expect(prose.intros).toEqual({});
  });

  it('renders a complete message with no model involved at all', () => {
    const payload = makePayload({ behavior: [BEHAVIOR], homeworkNew: [HOMEWORK] });

    const text = renderReport(payload, deterministicProse(payload));

    expect(text).toContain('אבי');
    expect(text).toContain('איחור');
    expect(text).toContain('לפתור עמוד 42');
    expect(text).toContain('הגיע באיחור של 10 דקות');
  });
});
