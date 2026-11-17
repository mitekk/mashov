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

import { DigestSummarizerService, buildPrompt } from './digest-summarizer.service';
import { deterministicLines } from './digest-report.template';
import type { ConfigService } from '@nestjs/config';
import type { DigestPayload } from './digest.types';

const REPORT_FOR = new Date('2026-11-17T00:00:00Z');

function makePayload(): DigestPayload {
  return {
    childFirstName: 'אבי',
    childGender: 'male',
    reportFor: REPORT_FOR,
    behavior: [
      {
        id: 'beh-1',
        achvaName: 'איחור',
        classification: 'negative',
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
  };
}

const GOOD_OUTPUT = {
  headline: 'יום עם איחור אחד',
  behaviorLine: 'נרשם איחור בשיעור מתמטיקה.',
  homeworkLine: 'ניתנה מטלה בחשבון.',
  dueTomorrowLine: '',
  deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: null }],
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
  // in ADR-0025. It is deliberately hostile: it hands buildPrompt a payload
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
    expect(summary.lines.headline).toBe('יום עם איחור אחד');
    expect(summary.deadlineResolutions).toEqual([{ ref: 'hw-1', explicitDueDate: null }]);
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
    // A deliberately short output: four Hebrew lines and a small array.
    expect(request.max_tokens).toBe(2000);
    // Thinking cannot be disabled on this model, so it is never sent.
    expect(request).not.toHaveProperty('thinking');
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
    expect(summary.lines).toEqual(deterministicLines(payload));
    expect(summary.deadlineResolutions).toEqual([]);
  });

  it('falls back when the model returns text that is not JSON', async () => {
    respondWith('מצטער, לא הצלחתי');

    const summary = await makeService().summarize(makePayload());

    expect(summary.usedLlm).toBe(false);
  });

  it('falls back when the JSON is missing the lines the template needs', async () => {
    respondWith(JSON.stringify({ headline: 'כן', deadlineResolutions: [] }));

    const summary = await makeService().summarize(makePayload());

    expect(summary.usedLlm).toBe(false);
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
