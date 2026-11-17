import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { deterministicLines, formatSchoolDate } from './digest-report.template';
import {
  DigestActivityFact,
  DigestBehaviorFact,
  DigestDeadlineResolution,
  DigestHomeworkFact,
  DigestLines,
  DigestPayload,
  DigestReleaseFact,
  DigestSummary,
} from './digest.types';

/**
 * Sonnet 5.5 rather than Opus: measured against the real prompt, all three of
 * Haiku 5.5, Sonnet 5.5 and Opus 5.5 extracted an explicit Hebrew deadline
 * ("עד 25/11") correctly, which is the only judgement here that changes what a
 * parent is told. Sonnet costs roughly a fifth of Opus on this task, and was
 * the most disciplined of the three about not writing prose for a section it
 * was given no items for. Haiku is cheaper again and a reasonable override.
 */
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How hard the model thinks before answering. `low` is deliberate, not
 * timid: the task is four short Hebrew lines plus one small array, and
 * thinking counts against `max_tokens` on these models -- so a higher level
 * raises the chance of a truncated response, which lands on the deterministic
 * fallback and costs the parent the prose entirely.
 */
const DEFAULT_EFFORT = 'low';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type DigestEffort = (typeof EFFORT_LEVELS)[number];

/**
 * Deliberately small. The output is four short Hebrew lines plus one small
 * array, so this is a "deliberately short output" rather than a lowballed
 * ceiling -- and a truncated response lands on the deterministic fallback
 * anyway, which still sends.
 */
const MAX_TOKENS = 2000;

/** The structured output the model must return. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'headline',
    'behaviorLine',
    'homeworkLine',
    'dueTomorrowLine',
    'releaseLine',
    'activityLine',
    'deadlineResolutions',
  ],
  properties: {
    headline: { type: 'string', description: 'שורה אחת קצרה בעברית' },
    behaviorLine: { type: 'string', description: 'משפט או שניים בעברית על ההתנהגות' },
    homeworkLine: { type: 'string', description: 'משפט או שניים בעברית על המטלות החדשות' },
    dueTomorrowLine: { type: 'string', description: 'משפט או שניים בעברית על מה שצפוי מחר' },
    releaseLine: { type: 'string', description: 'משפט בעברית על שחרור מוקדם שכבר אושר' },
    activityLine: {
      type: 'string',
      description: 'משפט בעברית על אישור שממתין לתשובת ההורה, כולל דחיפות לפי התאריך',
    },
    deadlineResolutions: {
      type: 'array',
      description:
        'לכל מטלה: המועד המפורש שנכתב בטקסט, אם נכתב. null כשלא נכתב מועד.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'explicitDueDate'],
        properties: {
          ref: { type: 'string' },
          explicitDueDate: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = [
  'אתה כותב עדכון יומי קצר להורה על יום הלימודים של ילדו, בעברית פשוטה, חמה ובגובה העיניים.',
  'כתוב כאילו אתה מספר להורה בשיחה: משפטים קצרים, בלי מילים מנופחות ובלי סגנון רשמי או מתורגם.',
  // The name already heads the message. Prose that repeats it on every line
  // reads like a form letter rather than someone telling you about your day.
  'שם הילד/ה אינו נמסר לך ואינו נחוץ: הוא מופיע כבר בראש ההודעה. אל תכתוב שם כלשהו ואל תמציא שם.',
  'הקפד על התאמת לשון זכר/נקבה לפי המין שנמסר.',
  'כתוב פרוזה בלבד. אל תמציא עובדות, אל תוסיף פרטים שלא נמסרו לך, ואל תכתוב כותרות או תבליטים.',
  'אל תבטיח מועד הגשה: המערכת אינה יודעת מועדי הגשה, רק מתי ניתנה המטלה.',
  'אם בטקסט של מטלה נכתב מועד מפורש, החזר אותו ב-deadlineResolutions בפורמט YYYY-MM-DD; אחרת null.',
  'אם אין מה לומר בסעיף מסוים, החזר מחרוזת ריקה לאותו שדה.',
  'ה-headline הוא שורה אחת קצרה שמסכמת את היום, בלי תאריך ובלי שם.',
  'שחרור מוקדם הוא בקשה שההורה עצמו הגיש ואושרה: כתוב עליו כתזכורת, לא כחדשות.',
  'אישור שממתין לתשובה הוא הדבר היחיד שדורש פעולה מההורה. ציין עד מתי צריך להשיב.',
].join('\n');

/**
 * Builds the prompt, and owns the PII boundary while doing it.
 *
 * Every field is named explicitly. This function must never grow a
 * `JSON.stringify(payload)` shortcut: the payload is a typed object today, but
 * the moment something identifying is added to it upstream, a blanket
 * serialisation would ship that to a third party silently. The spec for this
 * function is hostile on purpose -- it passes in a payload carrying a family
 * name, a guid, a reporter and a username and asserts none of them appear.
 *
 * What does cross the boundary: the child's grammatical gender, subject names,
 * achvaName, classification, free remark and homework text, and dates.
 * What never does: **any part of the child's name**, studentGuid, reporter and
 * teacher names, usernames. The first name used to be sent so the prose could
 * address the child; it is withheld now because the rendered message already
 * carries it in its header, and an instruction not to repeat it held only
 * sometimes. Gender is sent in its place, which is what gendered Hebrew
 * actually needs. See ADR-0025.
 */
export function buildPrompt(payload: DigestPayload): string {
  const sections: string[] = [`תאריך: ${formatSchoolDate(payload.reportFor)}`];
  if (payload.childGender !== null) {
    sections.unshift(`מין הילד/ה: ${payload.childGender === 'female' ? 'נקבה' : 'זכר'}`);
  }

  if (payload.behavior.length > 0) {
    sections.push(
      ['אירועי התנהגות ונוכחות:', ...payload.behavior.map(behaviorForPrompt)].join('\n'),
    );
  }

  if (payload.homeworkNew.length > 0) {
    sections.push(
      ['מטלות שניתנו היום:', ...payload.homeworkNew.map(homeworkForPrompt)].join('\n'),
    );
  }

  if (payload.homeworkDueTomorrow.length > 0) {
    sections.push(
      [
        'מטלות שאולי נדרשות מחר (הצפי מחושב, אינו מועד הגשה רשמי):',
        ...payload.homeworkDueTomorrow.map(homeworkForPrompt),
      ].join('\n'),
    );
  }

  if (payload.releases.length > 0) {
    sections.push(
      ['שחרורים מוקדמים שההורה ביקש:', ...payload.releases.map(releaseForPrompt)].join('\n'),
    );
  }

  if (payload.activities.length > 0) {
    sections.push(
      [
        'אישורים שממתינים לתשובת ההורה:',
        ...payload.activities.map(activityForPrompt),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

function behaviorForPrompt(fact: DigestBehaviorFact): string {
  const fields = [
    `סוג: ${fact.achvaName}`,
    `מקצוע: ${fact.subject}`,
    `סיווג: ${fact.classification}`,
    `מוצדק: ${fact.justifiable ? 'כן' : 'לא'}`,
  ];
  const remark = fact.remark?.trim();
  if (remark) fields.push(`הערה: ${remark}`);
  return `- ${fields.join(' | ')}`;
}

/**
 * Date, time, nothing else.
 *
 * `remark` is the parent's own text and is deliberately absent: it routinely
 * names the child ("אבקש לשחרר את אבי"), which would put the name back into
 * the prompt by the side door right after it was removed from the front. The
 * template still renders it, because showing a parent their own words back
 * costs nothing and never leaves the host.
 */
function releaseForPrompt(fact: DigestReleaseFact): string {
  return `- תאריך: ${formatSchoolDate(fact.releaseDate)} | שעה: ${fact.startHour.slice(0, 5)}`;
}

/**
 * Title and dates. The consent letter itself never goes: it is long, it is
 * HTML, and it names staff and other families' children.
 */
function activityForPrompt(fact: DigestActivityFact): string {
  return [
    `- נושא: ${fact.title}`,
    `מועד האירוע: ${formatSchoolDate(fact.activityStartDate)}`,
    `יש להשיב עד: ${formatSchoolDate(fact.endAnswerDate)}`,
  ].join(' | ');
}

function homeworkForPrompt(fact: DigestHomeworkFact): string {
  const fields = [`ref: ${fact.id}`, `מקצוע: ${fact.subjectName}`, `מטלה: ${fact.homeworkText.trim()}`];
  const remark = fact.remark?.trim();
  if (remark) fields.push(`הערה: ${remark}`);
  if (fact.estimatedDueDate) fields.push(`צפי לפי מערכת השעות: ${formatSchoolDate(fact.estimatedDueDate)}`);
  return `- ${fields.join(' | ')}`;
}

/**
 * One model call per child per run, and only after the checker has said there
 * is something to report.
 *
 * Every failure mode -- no key, timeout, refusal, malformed output -- lands on
 * the deterministic renderer and still sends. A parent getting a plainer
 * message beats a parent getting nothing.
 */
@Injectable()
export class DigestSummarizerService {
  private readonly logger = new Logger(DigestSummarizerService.name);

  constructor(private readonly config: ConfigService) {}

  async summarize(payload: DigestPayload): Promise<DigestSummary> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey || apiKey.trim().length === 0) {
      this.logger.log('No ANTHROPIC_API_KEY configured; rendering the digest without the model.');
      return this.fallback(payload);
    }

    const envProxyRisk = envProxyWouldCaptureFetch();
    if (envProxyRisk !== null) {
      // Refusing is the safe direction: a plainer message still reaches the
      // parent, whereas a prompt carrying a child's first name and a teacher's
      // remarks must not traverse a residential box provisioned for Mashov.
      this.logger.error(
        `Refusing to call the model: ${envProxyRisk} would route the prompt through the Mashov egress proxy. ` +
          'Rendering the digest without the model.',
      );
      return this.fallback(payload);
    }

    try {
      // No proxy, agent, or custom fetch is ever passed. The SDK is
      // fetch-based, so on Node 22 (what the Dockerfile pins) HTTPS_PROXY is
      // ignored and the LLM call cannot inherit ADR-0023's residential Mashov
      // egress hop. The guard above covers the Node >= 24 case where that
      // stopped being true.
      const client = new Anthropic({
        apiKey,
        timeout: this.readTimeoutMs(),
        maxRetries: 0,
      });

      const response = await client.messages.create({
        model: this.config.get<string>('DIGEST_LLM_MODEL') ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: {
          effort: this.readEffort(),
          format: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [{ role: 'user', content: buildPrompt(payload) }],
      });

      if (response.stop_reason === 'refusal') {
        this.logger.warn('The model declined to summarize the digest; using the fallback renderer.');
        return this.fallback(payload);
      }

      const parsed = parseOutput(response.content);
      if (parsed === null) {
        // Naming the stop reason matters: thinking counts against max_tokens on
        // this model and cannot be turned off, so truncation is the likeliest
        // cause of unusable output and is worth being able to see directly
        // rather than infer from a run of usedLlm=false rows.
        this.logger.warn(
          `The model returned output the template cannot use (stop_reason=${response.stop_reason}); using the fallback renderer.`,
        );
        return this.fallback(payload);
      }

      return { ...parsed, usedLlm: true };
    } catch (error) {
      // Never interpolate the key or the client into the message.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Digest summarization failed (${message}); using the fallback renderer.`);
      return this.fallback(payload);
    }
  }

  private fallback(payload: DigestPayload): DigestSummary {
    return { lines: deterministicLines(payload), deadlineResolutions: [], usedLlm: false };
  }

  private readTimeoutMs(): number {
    const parsed = Number(this.config.get<string | number>('DIGEST_LLM_TIMEOUT_MS'));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  }

  /**
   * An unrecognised level is dropped rather than forwarded. The API answers a
   * bad effort with a 400, which this service turns into the deterministic
   * fallback -- so a typo in `.env` would quietly cost every parent the
   * model's prose, showing up only as a run of `usedLlm: false` rows that look
   * exactly like an outage.
   */
  private readEffort(): DigestEffort {
    const raw = this.config.get<string>('DIGEST_LLM_EFFORT');
    if (raw === undefined || raw === null) return DEFAULT_EFFORT;

    const normalized = String(raw).trim().toLowerCase();
    if (normalized.length === 0) return DEFAULT_EFFORT;

    const match = EFFORT_LEVELS.find((level) => level === normalized);
    if (match) return match;

    this.logger.warn(
      `DIGEST_LLM_EFFORT="${normalized}" is not one of ${EFFORT_LEVELS.join(', ')}; using ${DEFAULT_EFFORT}.`,
    );
    return DEFAULT_EFFORT;
  }
}

interface ParsedOutput {
  lines: DigestLines;
  deadlineResolutions: DigestDeadlineResolution[];
}

/**
 * Structured outputs make the shape very likely, not certain -- a truncated
 * response is still truncated -- so the result is validated rather than cast.
 */
function parseOutput(content: Anthropic.ContentBlock[]): ParsedOutput | null {
  const text = content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (text.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;

  const lineKeys = [
    'headline',
    'behaviorLine',
    'homeworkLine',
    'dueTomorrowLine',
    'releaseLine',
    'activityLine',
  ] as const;
  if (!lineKeys.every((key) => typeof candidate[key] === 'string')) return null;

  const resolutions = Array.isArray(candidate.deadlineResolutions)
    ? candidate.deadlineResolutions.filter(isResolution)
    : [];

  return {
    lines: {
      headline: candidate.headline as string,
      behaviorLine: candidate.behaviorLine as string,
      homeworkLine: candidate.homeworkLine as string,
      dueTomorrowLine: candidate.dueTomorrowLine as string,
      releaseLine: candidate.releaseLine as string,
      activityLine: candidate.activityLine as string,
    },
    deadlineResolutions: resolutions,
  };
}

function isResolution(value: unknown): value is DigestDeadlineResolution {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.ref === 'string' &&
    (entry.explicitDueDate === null || typeof entry.explicitDueDate === 'string')
  );
}

/**
 * Whether this process would send `fetch` traffic through the proxy named in
 * the environment.
 *
 * Node 24 added `--use-env-proxy` and `NODE_USE_ENV_PROXY`, which make built-in
 * fetch honour `HTTPS_PROXY`/`HTTP_PROXY` with no code change. The Anthropic
 * SDK takes no proxy option, so passing none is normally enough -- but under
 * that flag "none" stops meaning "direct". Returns the name of what triggered
 * it, or null when there is nothing to worry about.
 */
function envProxyWouldCaptureFetch(): string | null {
  const proxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy || proxy.trim().length === 0) return null;

  const flag = process.env.NODE_USE_ENV_PROXY;
  if (flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false') {
    return 'NODE_USE_ENV_PROXY';
  }
  if (
    process.execArgv.some((arg) => arg === '--use-env-proxy') ||
    (process.env.NODE_OPTIONS ?? '').includes('--use-env-proxy')
  ) {
    return '--use-env-proxy';
  }
  return null;
}
