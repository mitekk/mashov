const createMock = jest.fn();
const constructorMock = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class {
    messages = { create: createMock };
    constructor(options: unknown) {
      constructorMock(options);
    }
  },
}));

import { DigestSummarizerService, buildPrompt, OUTPUT_SCHEMA } from './digest-summarizer.service';
import { deterministicProse, digestItemRef } from './digest-report.template';
import type { ConfigService } from '@nestjs/config';
import type { DigestPayload } from './digest.types';

const REPORT_FOR = new Date('2026-11-17T00:00:00Z');

function makePayload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    childFirstName: 'אבי',
    childGender: 'male',
    reportFor: REPORT_FOR,
    behavior: [
      {
        id: 'beh-1',
        achvaName: 'איחור',
        classification: 'attention',
        justifiable: true,
        subject: 'מתמטיקה',
        remark: 'הגיע באיחור של 10 דקות',
        lessonDate: REPORT_FOR,
        eventAt: new Date('2026-11-17T11:00:00Z'),
      },
    ],
    homeworkNew: [
      {
        id: 'hw-1',
        subjectName: 'חשבון',
        homeworkText: 'לפתור עמוד 42',
        remark: null,
        lessonDate: REPORT_FOR,
        groupId: 55,
      },
    ],
    homeworkDueTomorrow: [],
    releases: [],
    activities: [],
    board: [],
    grades: [],
    ...overrides,
  };
}

const GOOD_OUTPUT = {
  headline: 'יום עם איחור אחד',
  intros: { behavior: 'שתי הערות קטנות, שתיהן באותו בוקר.' },
  items: [
    { ref: 'behavior:beh-1', line: 'איחר בעשר דקות לשיעור מתמטיקה.', explicitDueDate: null },
    { ref: 'homeworkNew:hw-1', line: 'בחשבון נתנו לפתור עמוד 42.', explicitDueDate: null },
  ],
};

function makeService(env: Record<string, string> = {}) {
  const config = {
    get: jest.fn((key: string) => ({
      ANTHROPIC_API_KEY: 'test-key',
      DIGEST_LLM_TIMEOUT_MS: '30000',
      ...env,
    })[key]),
  } as unknown as ConfigService;

  return new DigestSummarizerService(config);
}

function respondWith(text: string) {
  createMock.mockResolvedValue({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
  });
}

describe('buildPrompt', () => {
  // This test is the enforcement mechanism for the first-names-only decision
  // in ADR-0026. It is deliberately hostile: it hands buildPrompt a payload
  // carrying fields it must never forward, which is what a future
  // JSON.stringify(payload) would leak.
  it('carries the child first name, subjects, and remark text', () => {
    const prompt = buildPrompt(makePayload());

    expect(prompt).toContain('מתמטיקה');
    expect(prompt).toContain('איחור');
    expect(prompt).toContain('הגיע באיחור של 10 דקות');
    expect(prompt).toContain('לפתור עמוד 42');
  });

  it('never forwards a family name, guid, reporter, or username', () => {
    const contaminated = {
      ...makePayload(),
      familyName: 'כהן',
      studentGuid: 'd4f1c2a0-1111-2222-3333-444455556666',
      behavior: [
        {
          ...makePayload().behavior[0],
          reporter: 'מורה רחל לוי',
          username: 'rachel.levi',
          studentGuid: 'd4f1c2a0-1111-2222-3333-444455556666',
        },
      ],
    } as unknown as DigestPayload;

    const prompt = buildPrompt(contaminated);

    expect(prompt).not.toContain('כהן');
    expect(prompt).not.toContain('d4f1c2a0');
    expect(prompt).not.toContain('רחל לוי');
    expect(prompt).not.toContain('rachel.levi');
    // No guid in any shape.
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it('never forwards the first name either', () => {
    // The name heads the rendered message, so the model has no use for it --
    // and an instruction not to repeat it was followed only sometimes, which
    // makes withholding it the only reliable way to keep it out of the prose.
    // It also means no part of the child's name leaves the host.
    const prompt = buildPrompt(makePayload());

    expect(prompt).not.toContain('אבי');
  });

  it('states the gender in Hebrew, which is what the prose needs instead', () => {
    // Hebrew verbs are gendered, and plenty of Israeli first names are not
    // (נועם, שחר, רותם), so the name was never a reliable signal anyway.
    expect(buildPrompt({ ...makePayload(), childGender: 'female' })).toContain('נקבה');
    expect(buildPrompt({ ...makePayload(), childGender: 'male' })).toContain('זכר');
  });

  it('says nothing about gender when the roster does not record it', () => {
    const prompt = buildPrompt({ ...makePayload(), childGender: null });

    expect(prompt).not.toContain('זכר');
    expect(prompt).not.toContain('נקבה');
  });
});

describe('DigestSummarizerService.summarize', () => {
  beforeEach(() => {
    createMock.mockReset();
    constructorMock.mockReset();
  });

  it('returns the model prose when the call succeeds', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    const summary = await makeService().summarize(makePayload());

    expect(summary.usedLlm).toBe(true);
    expect(summary.prose.headline).toBe('יום עם איחור אחד');
    expect(summary.prose.intros.behavior).toBe('שתי הערות קטנות, שתיהן באותו בוקר.');
    expect(summary.prose.itemLines).toEqual({
      'behavior:beh-1': 'איחר בעשר דקות לשיעור מתמטיקה.',
      'homeworkNew:hw-1': 'בחשבון נתנו לפתור עמוד 42.',
    });
  });

  it('reads the deadlines off the same items as the lines', async () => {
    // They used to be two top-level arrays keyed by the same refs, which let
    // the model answer the same question twice and differently.
    respondWith(
      JSON.stringify({
        ...GOOD_OUTPUT,
        items: [
          { ref: 'dueTomorrow:hw-1', line: 'להגיש עד ה-25', explicitDueDate: '2026-11-25' },
          { ref: 'homeworkNew:hw-2', line: 'אין מועד', explicitDueDate: null },
        ],
      }),
    );

    const summary = await makeService().summarize(makePayload());

    // Keyed by the HOMEWORK id, which is what narrowDueTomorrow looks up --
    // not by the namespaced ref. Only the due-tomorrow refs contribute: see
    // the test below for why.
    expect(summary.deadlineResolutions).toEqual([
      { ref: 'hw-1', explicitDueDate: '2026-11-25' },
    ]);
  });

  it('reads a deadline only off the due-tomorrow refs, so one id cannot answer twice', async () => {
    // One homework row is reported twice on the day it is both newly assigned
    // and estimated-due, so both refs strip to the same bare id. Emitting a
    // resolution for each let `new Map(...)` keep whichever came last in the
    // model's array, making a deferral decision depend on array order --
    // something the old top-level array could not do. Only the due-tomorrow
    // section consumes a resolution, so only it supplies one.
    respondWith(
      JSON.stringify({
        ...GOOD_OUTPUT,
        items: [
          { ref: 'dueTomorrow:hw-1', line: 'להגיש עד ה-25', explicitDueDate: '2026-11-25' },
          { ref: 'homeworkNew:hw-1', line: 'ניתנה היום', explicitDueDate: '2026-11-30' },
        ],
      }),
    );

    const summary = await makeService().summarize(makePayload());

    expect(summary.deadlineResolutions).toEqual([
      { ref: 'hw-1', explicitDueDate: '2026-11-25' },
    ]);
  });

  it('keeps every explicit date it read, namespaced, for the submission summary', async () => {
    // A second map, keyed by the NAMESPACED ref, so the template can tell the
    // parent by when each thing is due. `deadlineResolutions` cannot serve
    // this: it strips to the bare homework id, and so has to exclude
    // `homeworkNew` to keep two refs for one row from colliding.
    respondWith(
      JSON.stringify({
        ...GOOD_OUTPUT,
        items: [
          { ref: 'homeworkNew:hw-2', line: 'חיבור באנגלית', explicitDueDate: '2026-11-30' },
          { ref: 'dueTomorrow:hw-1', line: 'להגיש עד ה-25', explicitDueDate: '2026-11-25' },
          { ref: 'behavior:beh-1', line: 'איחר', explicitDueDate: null },
        ],
      }),
    );

    const summary = await makeService().summarize(makePayload());

    expect(summary.explicitDueDates).toEqual({
      'homeworkNew:hw-2': '2026-11-30',
      'dueTomorrow:hw-1': '2026-11-25',
    });
  });

  it('keeps a date that is not an ISO day out of the explicit dates', async () => {
    // The template drops it too, but a value that is not a date has no
    // business being carried as one.
    respondWith(
      JSON.stringify({
        ...GOOD_OUTPUT,
        items: [{ ref: 'homeworkNew:hw-2', line: 'חיבור', explicitDueDate: 'מחר' }],
      }),
    );

    const summary = await makeService().summarize(makePayload());

    expect(summary.explicitDueDates).toEqual({});
  });

  it('keeps an item line with no text out of the prose rather than rendering a blank bullet', async () => {
    respondWith(
      JSON.stringify({
        ...GOOD_OUTPUT,
        items: [
          { ref: 'behavior:beh-1', line: '   ', explicitDueDate: null },
          { ref: 'homeworkNew:hw-1', line: 'בחשבון נתנו לפתור עמוד 42.', explicitDueDate: null },
        ],
      }),
    );

    const summary = await makeService().summarize(makePayload());

    // The caller fills the gap from the deterministic line for that one ref.
    expect(summary.prose.itemLines['behavior:beh-1']).toBeUndefined();
    expect(summary.prose.itemLines['homeworkNew:hw-1']).toBeDefined();
  });

  it('drops an intro for a section it was given nothing about', async () => {
    respondWith(JSON.stringify({ ...GOOD_OUTPUT, intros: { behavior: '', board: '  ' } }));

    const summary = await makeService().summarize(makePayload());

    expect(summary.prose.intros).toEqual({});
  });

  it('asks for a bounded, structured, low-effort response', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    await makeService().summarize(makePayload());

    const request = createMock.mock.calls[0][0];
    // Sonnet 5.5 by default: it costs roughly a fifth of Opus on this task and
    // was the most disciplined of the three about not describing items it was
    // not given. Overridable per deployment with DIGEST_LLM_MODEL.
    expect(request.model).toBe('claude-sonnet-5-5');
    expect(request.output_config.effort).toBe('low');
    expect(request.output_config.format.type).toBe('json_schema');
    // One short line per item plus a headline: still a deliberately short
    // output, but it grows with the day, so the ceiling went up with it.
    expect(request.max_tokens).toBe(4000);
    // Thinking cannot be disabled on this model, so it is never sent.
    expect(request).not.toHaveProperty('thinking');
  });

  it('raises the ceiling with the number of items, because the output is one line per item', async () => {
    // The old fixed 4000 was sized for the seven fixed lines the model used to
    // write. With one line per item, a busy day's response truncates --
    // `parseOutput` is all-or-nothing, so the parent gets deterministic
    // bullets for EVERY item on exactly the days with the most to say.
    respondWith(JSON.stringify(GOOD_OUTPUT));

    const busy = makePayload({
      behavior: Array.from({ length: 20 }, (_, index) => ({
        id: `beh-${index}`,
        achvaName: 'איחור',
        classification: 'attention',
        justifiable: false,
        subject: 'מתמטיקה',
        remark: null,
        lessonDate: REPORT_FOR,
        eventAt: REPORT_FOR,
      })),
    });

    await makeService().summarize(busy);

    const request = createMock.mock.calls[0][0];
    expect(request.max_tokens).toBeGreaterThan(4000);
  });

  it('never asks for less than it used to, however quiet the day', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    await makeService().summarize(
      makePayload({ behavior: [], homeworkNew: [], homeworkDueTomorrow: [], board: [], releases: [] }),
    );

    expect(createMock.mock.calls[0][0].max_tokens).toBe(4000);
  });

  it('caps the ceiling, so one absurd day cannot buy an unbounded response', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    const absurd = makePayload({
      behavior: Array.from({ length: 500 }, (_, index) => ({
        id: `beh-${index}`,
        achvaName: 'איחור',
        classification: 'attention',
        justifiable: false,
        subject: 'מתמטיקה',
        remark: null,
        lessonDate: REPORT_FOR,
        eventAt: REPORT_FOR,
      })),
    });

    await makeService().summarize(absurd);

    expect(createMock.mock.calls[0][0].max_tokens).toBe(16000);
  });

  it('uses the model named in the environment over the default', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    await makeService({ DIGEST_LLM_MODEL: 'claude-haiku-5-5' }).summarize(makePayload());

    expect(createMock.mock.calls[0][0].model).toBe('claude-haiku-5-5');
  });

  it('uses the effort level named in the environment', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    await makeService({ DIGEST_LLM_EFFORT: 'medium' }).summarize(makePayload());

    expect(createMock.mock.calls[0][0].output_config.effort).toBe('medium');
  });

  it('accepts an effort level regardless of case or surrounding space', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    await makeService({ DIGEST_LLM_EFFORT: '  HIGH ' }).summarize(makePayload());

    expect(createMock.mock.calls[0][0].output_config.effort).toBe('high');
  });

  it('ignores an unusable effort level rather than letting the API reject it', async () => {
    // An unrecognised value would be a 400, which this service turns into the
    // deterministic fallback -- so a typo in .env would silently cost every
    // parent the model's prose, visible only as a run of usedLlm=false.
    respondWith(JSON.stringify(GOOD_OUTPUT));

    const result = await makeService({ DIGEST_LLM_EFFORT: 'very-high' }).summarize(makePayload());

    expect(createMock.mock.calls[0][0].output_config.effort).toBe('low');
    expect(result.usedLlm).toBe(true);
  });

  it('falls back to deterministic prose when the call throws', async () => {
    createMock.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const payload = makePayload();

    const summary = await makeService().summarize(payload);

    expect(summary.usedLlm).toBe(false);
    expect(summary.prose).toEqual(deterministicProse(payload));
    expect(summary.deadlineResolutions).toEqual([]);
    expect(summary.explicitDueDates).toEqual({});
  });

  it('falls back when the model returns text that is not JSON', async () => {
    respondWith('מצטער, לא הצלחתי');

    const summary = await makeService().summarize(makePayload());

    expect(summary.usedLlm).toBe(false);
  });

  it('falls back when the JSON is missing the shape the template needs', async () => {
    respondWith(JSON.stringify({ headline: 'כן' }));

    const summary = await makeService().summarize(makePayload());

    expect(summary.usedLlm).toBe(false);
  });

  it('falls back when items is not an array of refs and lines', async () => {
    for (const items of ['nope', [{ ref: 'behavior:beh-1' }], [{ line: 'x' }], [42]]) {
      respondWith(JSON.stringify({ ...GOOD_OUTPUT, items }));

      expect((await makeService().summarize(makePayload())).usedLlm).toBe(false);
    }
  });

  it('falls back when intros is not an object of strings', async () => {
    for (const intros of ['nope', { behavior: 7 }, [1, 2]]) {
      respondWith(JSON.stringify({ ...GOOD_OUTPUT, intros }));

      expect((await makeService().summarize(makePayload())).usedLlm).toBe(false);
    }
  });

  it('accepts a response that carries no intros at all', async () => {
    // The intro is optional by design: it only earns its place when it says
    // something the item lines do not.
    respondWith(JSON.stringify({ headline: 'יום רגוע', intros: {}, items: [] }));

    const summary = await makeService().summarize(makePayload());

    expect(summary.usedLlm).toBe(true);
    expect(summary.prose.intros).toEqual({});
  });

  it('falls back when the model refuses', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms' },
      content: [],
    });

    const summary = await makeService().summarize(makePayload());

    expect(summary.usedLlm).toBe(false);
  });

  it('does not call the model at all when no API key is configured', async () => {
    const summary = await makeService({ ANTHROPIC_API_KEY: '' }).summarize(makePayload());

    expect(createMock).not.toHaveBeenCalled();
    expect(summary.usedLlm).toBe(false);
  });

  it('bounds the call with the configured timeout', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));

    await makeService({ DIGEST_LLM_TIMEOUT_MS: '12000' }).summarize(makePayload());

    expect(constructorMock.mock.calls[0][0].timeout).toBe(12000);
  });

  it('never routes through the Mashov residential egress proxy', async () => {
    // ADR-0023's egress hop is a single residential tinyproxy with a 10s abort
    // and no retry. Parent data and LLM prompts must never traverse it. The
    // Anthropic SDK is fetch-based and Node's fetch ignores HTTPS_PROXY
    // entirely, so the risk here is a proxy agent being passed in by hand --
    // which this asserts never happens.
    respondWith(JSON.stringify(GOOD_OUTPUT));

    await makeService().summarize(makePayload());

    const options = constructorMock.mock.calls[0][0];
    expect(options.httpAgent).toBeUndefined();
    expect(options.fetchOptions).toBeUndefined();
    expect(options.fetch).toBeUndefined();
  });


  it('refuses to call the model when Node is told to honour proxy env vars', async () => {
    // Node 24 added --use-env-proxy / NODE_USE_ENV_PROXY, which makes built-in
    // fetch honour HTTPS_PROXY with no code change at all. The Dockerfile pins
    // node:22-alpine today, but a routine base-image bump would silently route
    // every prompt -- first name, subjects, behavior remarks -- through
    // ADR-0023's residential Mashov box. Passing no agent is not enough to
    // prevent that, so the call is refused outright.
    const previousFlag = process.env.NODE_USE_ENV_PROXY;
    const previousProxy = process.env.HTTPS_PROXY;
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTPS_PROXY = 'http://residential-box:8888';

    try {
      const summary = await makeService().summarize(makePayload());

      expect(createMock).not.toHaveBeenCalled();
      expect(summary.usedLlm).toBe(false);
    } finally {
      if (previousFlag === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = previousFlag;
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousProxy;
    }
  });

  it('still calls the model when env-proxy is on but no proxy is configured', async () => {
    // Nothing to leak to.
    respondWith(JSON.stringify(GOOD_OUTPUT));
    const previousFlag = process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_USE_ENV_PROXY = '1';

    try {
      expect((await makeService().summarize(makePayload())).usedLlm).toBe(true);
    } finally {
      if (previousFlag === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = previousFlag;
    }
  });

  it('says so when the response was truncated, rather than leaving it to be inferred', async () => {
    // max_tokens covers thinking plus text on this model, so a truncation is
    // the realistic cause of malformed output and should be diagnosable.
    createMock.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"headline":"כות' }],
    });
    const service = makeService();
    const warnings: string[] = [];
    jest
      .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation((message: string) => warnings.push(String(message)));

    const summary = await service.summarize(makePayload());

    expect(summary.usedLlm).toBe(false);
    expect(warnings.join('\n')).toContain('max_tokens');
  });

  it('never logs the API key', async () => {
    respondWith(JSON.stringify(GOOD_OUTPUT));
    const service = makeService({ ANTHROPIC_API_KEY: 'sk-ant-secret-value' });

    const logged: string[] = [];
    jest
      .spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation((message: string) => logged.push(String(message)));

    await service.summarize(makePayload());

    expect(logged.join('\n')).not.toContain('sk-ant-secret-value');
  });
});

describe('buildPrompt with releases and activities', () => {
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

  it('tells the model when and at what time a release happens', () => {
    const prompt = buildPrompt({ ...makePayload(), releases: [RELEASE] });

    expect(prompt).toContain('18/11/2026');
    expect(prompt).toContain('11:30');
  });

  it("never sends the parent's release remark", () => {
    // It is the one field the report renders but the prompt must not: a release
    // remark routinely names the child ("אבקש לשחרר את אבי"), and sending it
    // would put the name back in the prompt through the side door.
    const prompt = buildPrompt({ ...makePayload(), releases: [RELEASE] });

    expect(prompt).not.toContain('תור לרופא');
    expect(prompt).not.toContain('אבי');
  });

  it('never tells the model about a consent form', () => {
    // The forms section is per parent, and the prose is shared between the
    // parents of one child (ADR-0035), so the model is handed no forms at all
    // and the section uses the deterministic Hebrew line. Enforced here
    // rather than only at the call site: this function is the PII boundary,
    // and a form title is one more thing that need never leave the host.
    const prompt = buildPrompt({ ...makePayload(), activities: [ACTIVITY] });

    expect(prompt).not.toContain('טיול שנתי לגליל');
    expect(prompt).not.toContain('אישורים שממתינים');
  });

  it('asks for a headline, intros and one entry per item', () => {
    expect(Object.keys(OUTPUT_SCHEMA.properties).sort()).toEqual(['headline', 'intros', 'items']);
    expect(OUTPUT_SCHEMA.required as readonly string[]).toEqual(['headline', 'intros', 'items']);
  });

  it('asks for each item entry to carry its ref, its line and its deadline', () => {
    // One array instead of two keyed by the same refs: the deadline is a fact
    // about the item whose line is right next to it.
    expect(OUTPUT_SCHEMA.properties.items.items.required as readonly string[]).toEqual([
      'ref',
      'line',
      'explicitDueDate',
    ]);
  });

  it('offers an intro for every section the model is given facts for', () => {
    // Including the two behaviour sections separately: one intro for both
    // would be written under a heading that fits neither.
    expect(Object.keys(OUTPUT_SCHEMA.properties.intros.properties).sort()).toEqual(
      ['behavior', 'board', 'dueTomorrow', 'homeworkNew', 'positive', 'release'].sort(),
    );
  });

  it('separates the positive events from the ones needing attention in the prompt', () => {
    const prompt = buildPrompt(
      makePayload({
        behavior: [
          {
            id: 'b1',
            achvaName: 'חיסור',
            classification: 'attention',
            justifiable: false,
            subject: 'מתמטיקה',
            remark: null,
            lessonDate: REPORT_FOR,
            eventAt: REPORT_FOR,
          },
          {
            id: 'b2',
            achvaName: 'חיזוק חיובי',
            classification: 'positive',
            justifiable: true,
            subject: 'ספרות',
            remark: null,
            lessonDate: REPORT_FOR,
            eventAt: REPORT_FOR,
          },
        ],
      }),
    );

    const attention = prompt.indexOf('מתמטיקה');
    const positive = prompt.indexOf('ספרות');
    expect(attention).toBeGreaterThan(-1);
    expect(positive).toBeGreaterThan(-1);
    // Two blocks, so the model cannot blend a note of praise into a sentence
    // about an absence.
    expect(prompt).toContain('חיזוקים חיוביים');
  });

  it('asks for no intro about consent forms, having been given none', () => {
    // A field the model is asked to fill with nothing to fill it from is a
    // field it hallucinates into.
    expect(Object.keys(OUTPUT_SCHEMA.properties.intros.properties)).not.toContain('activity');
  });

  it('puts the board notices in the prompt as their own block', () => {
    const prompt = buildPrompt(
      makePayload({
        board: [
          {
            id: '4211',
            text: 'ביום חמישי יום ספורט',
            expirationDate: new Date('2026-11-30T00:00:00Z'),
          },
        ],
      }),
    );

    expect(prompt).toContain('לוח המודעות');
    expect(prompt).toContain('ביום חמישי יום ספורט');
  });

  it('never asks the model to write a consent-form line either', () => {
    expect(JSON.stringify(OUTPUT_SCHEMA)).not.toContain('activity');
  });
});

describe('buildPrompt refs', () => {
  const REFFED = makePayload({
    behavior: [
      {
        id: 'beh-1',
        achvaName: 'חיסור',
        classification: 'attention',
        justifiable: false,
        subject: 'מתמטיקה',
        remark: null,
        lessonDate: REPORT_FOR,
        eventAt: REPORT_FOR,
      },
      {
        id: 'beh-2',
        achvaName: 'חיזוק חיובי',
        classification: 'positive',
        justifiable: true,
        subject: 'ספרות',
        remark: null,
        lessonDate: REPORT_FOR,
        eventAt: REPORT_FOR,
      },
    ],
    releases: [
      { id: '64', releaseDate: new Date('2026-11-18T00:00:00Z'), startHour: '11:30:00', remark: null },
    ],
    board: [
      { id: '4211', text: 'ביום חמישי יום ספורט', expirationDate: new Date('2026-11-30T00:00:00Z') },
    ],
  });

  it('emits a ref for every fact, not only for homework', () => {
    // The model keys its lines by these, so a fact with no ref is a fact that
    // gets no line. They are local DB ids and upstream event ids -- the same
    // class already sent for homework, so no new identifier leaves the host.
    const prompt = buildPrompt(REFFED);

    for (const ref of [
      digestItemRef('behavior', 'beh-1'),
      digestItemRef('positive', 'beh-2'),
      digestItemRef('homeworkNew', 'hw-1'),
      digestItemRef('release', '64'),
      digestItemRef('board', '4211'),
    ]) {
      expect(prompt).toContain(`ref: ${ref}`);
    }
  });

  it('gives one homework row two refs when it is both new and due tomorrow', () => {
    const payload = makePayload({
      homeworkDueTomorrow: [
        {
          id: 'hw-1',
          subjectName: 'חשבון',
          homeworkText: 'לפתור עמוד 42',
          remark: null,
          lessonDate: REPORT_FOR,
          groupId: 55,
          estimatedDueDate: new Date('2026-11-18T00:00:00Z'),
        },
      ],
    });

    const prompt = buildPrompt(payload);

    expect(prompt).toContain(`ref: ${digestItemRef('homeworkNew', 'hw-1')}`);
    expect(prompt).toContain(`ref: ${digestItemRef('dueTomorrow', 'hw-1')}`);
  });

  it('emits no ref for a consent form, which is not in the prompt at all', () => {
    const prompt = buildPrompt({
      ...makePayload(),
      activities: [
        {
          id: '7',
          title: 'טיול שנתי לגליל',
          activityStartDate: new Date('2026-11-25T00:00:00Z'),
          endAnswerDate: new Date('2026-11-20T00:00:00Z'),
        },
      ],
    });

    expect(prompt).not.toContain('activity:');
    expect(prompt).not.toContain('טיול שנתי לגליל');
  });

  it('still forwards no guid, reporter or username alongside the new refs', () => {
    // The refs are the one identifier class that crosses; this is the guard
    // that adding them did not open the door to the rest.
    const contaminated = {
      ...REFFED,
      studentGuid: 'd4f1c2a0-1111-2222-3333-444455556666',
      behavior: REFFED.behavior.map((fact) => ({
        ...fact,
        reporter: 'מורה רחל לוי',
        username: 'rachel.levi',
        studentGuid: 'd4f1c2a0-1111-2222-3333-444455556666',
      })),
      releases: REFFED.releases.map((fact) => ({ ...fact, remark: 'אבקש לשחרר את אבי' })),
    } as unknown as DigestPayload;

    const prompt = buildPrompt(contaminated);

    expect(prompt).not.toContain('d4f1c2a0');
    expect(prompt).not.toContain('רחל לוי');
    expect(prompt).not.toContain('rachel.levi');
    expect(prompt).not.toContain('אבי');
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });
});
