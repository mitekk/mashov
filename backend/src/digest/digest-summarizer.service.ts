import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { deterministicLines, formatSchoolDate } from './digest-report.template';
import {
  DigestBehaviorFact,
  DigestDeadlineResolution,
  DigestHomeworkFact,
  DigestLines,
  DigestPayload,
  DigestSummary,
} from './digest.types';

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Deliberately small. The output is four short Hebrew lines plus one small
 * array, so this is a "deliberately short output" rather than a lowballed
 * ceiling -- and a truncated response lands on the deterministic fallback
 * anyway, which still sends.
 */
const MAX_TOKENS = 2000;

/** The structured output the model must return. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'behaviorLine', 'homeworkLine', 'dueTomorrowLine', 'deadlineResolutions'],
  properties: {
    headline: { type: 'string', description: 'שורה אחת קצרה בעברית' },
    behaviorLine: { type: 'string', description: 'משפט או שניים בעברית על ההתנהגות' },
    homeworkLine: { type: 'string', description: 'משפט או שניים בעברית על המטלות החדשות' },
    dueTomorrowLine: { type: 'string', description: 'משפט או שניים בעברית על מה שצפוי מחר' },
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
  'אתה כותב עדכון יומי קצר להורה על יום הלימודים של ילדו, בעברית פשוטה ועניינית.',
  'כתוב פרוזה בלבד. אל תמציא עובדות, אל תוסיף פרטים שלא נמסרו לך, ואל תכתוב כותרות או תבליטים.',
  'אל תבטיח מועד הגשה: המערכת אינה יודעת מועדי הגשה, רק מתי ניתנה המטלה.',
  'אם בטקסט של מטלה נכתב מועד מפורש, החזר אותו ב-deadlineResolutions בפורמט YYYY-MM-DD; אחרת null.',
  'אם אין מה לומר בסעיף מסוים, החזר מחרוזת ריקה לאותו שדה.',
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
 * What does cross the boundary: the child's first name, subject names,
 * achvaName, classification, free remark and homework text, and dates.
 * What never does: family names, studentGuid, reporter and teacher names,
 * usernames. See ADR-0025.
 */
export function buildPrompt(payload: DigestPayload): string {
  const sections: string[] = [
    `שם הילד/ה: ${payload.childFirstName}`,
    `תאריך: ${formatSchoolDate(payload.reportFor)}`,
  ];

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

    try {
      // No proxy, agent, or custom fetch is ever passed. The SDK is
      // fetch-based and Node's fetch ignores HTTPS_PROXY, so the LLM call
      // cannot inherit ADR-0023's residential Mashov egress hop -- and nothing
      // here reintroduces it by hand.
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
          effort: 'low',
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
        this.logger.warn('The model returned output the template cannot use; using the fallback renderer.');
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

  const lineKeys = ['headline', 'behaviorLine', 'homeworkLine', 'dueTomorrowLine'] as const;
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
