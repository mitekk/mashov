import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { deterministicProse, digestItemRef, formatSchoolDate } from './digest-report.template';
import {
  DigestBehaviorFact,
  DigestBoardFact,
  DigestDeadlineResolution,
  DigestHomeworkFact,
  DigestPayload,
  DigestProse,
  DigestReleaseFact,
  DigestSectionId,
  DigestSummary,
} from './digest.types';
import { isIsoDay } from './iso-day';

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
 * How hard the model thinks before answering. `low` is deliberate, not timid:
 * the task is one short Hebrew sentence per item, and thinking counts against
 * `max_tokens` on these models -- so a higher level raises the chance of a
 * truncated response, which lands on the deterministic fallback and costs the
 * parent the prose entirely.
 */
const DEFAULT_EFFORT = 'low';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type DigestEffort = (typeof EFFORT_LEVELS)[number];

/**
 * The output ceiling, which has to move with the day.
 *
 * It used to be a flat 4000, sized for the seven fixed lines the model wrote
 * when the prose was one paragraph per section. The output is now one short
 * sentence per ITEM, so it scales with how much happened -- and `parseOutput`
 * is all-or-nothing, because a truncated response is not valid JSON. A fixed
 * ceiling therefore fails in exactly the wrong direction: the busier the day,
 * the likelier the parent gets deterministic bullets for EVERY item, on the
 * days with the most to say.
 *
 * `MIN` is the old value, so no quiet day asks for less than it used to.
 * `PER_ITEM` is deliberately generous: a Hebrew sentence tokenizes badly, and
 * thinking counts against this ceiling on this model and cannot be turned off.
 * `CEILING` is there because `max_tokens` is a budget, not a target -- one
 * absurd day (a backfill, a sync that re-reports a term) must not be able to
 * buy an unbounded response. A day past the cap truncates and falls back,
 * which is the same thing that happened before, now only at the far end.
 */
const MAX_TOKENS_MIN = 4000;
const MAX_TOKENS_PER_ITEM = 300;
const MAX_TOKENS_BASE = 2000;
const MAX_TOKENS_CEILING = 16000;

/**
 * The items the model is actually asked to write a line for.
 *
 * Consent forms are not counted: the model is handed none of them (ADR-0035).
 * Neither are grades, which it is never shown either: the section is
 * template-owned, so counting them would buy output for lines the model does
 * not write.
 */
function maxTokensFor(payload: DigestPayload): number {
  const items =
    payload.behavior.length +
    payload.homeworkNew.length +
    payload.homeworkDueTomorrow.length +
    payload.releases.length +
    payload.board.length;
  const wanted = MAX_TOKENS_BASE + items * MAX_TOKENS_PER_ITEM;
  return Math.min(MAX_TOKENS_CEILING, Math.max(MAX_TOKENS_MIN, wanted));
}

/**
 * The structured output the model must return.
 *
 * One entry per item rather than one paragraph per section: the per-section
 * grain is what forced the prompt to demand warm prose AND a complete record
 * in a single sentence, and the model answered by cramming. See ADR-0047.
 *
 * `explicitDueDate` rides on the item whose line is next to it. It used to be
 * a second top-level array keyed by the same refs, which let the model answer
 * the same question in two places and answer it differently in each.
 *
 * There is no `activity` anywhere in here. The model is handed no consent
 * forms at all (ADR-0035), and a field it is asked to fill with nothing to
 * fill it from is a field it hallucinates into.
 */
const INTRO_SECTIONS = [
  'behavior',
  'positive',
  'homeworkNew',
  'release',
  'board',
  'dueTomorrow',
] as const satisfies readonly DigestSectionId[];

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'intros', 'items'],
  properties: {
    headline: { type: 'string', description: 'שורה אחת קצרה בעברית שמסכמת את היום' },
    intros: {
      type: 'object',
      additionalProperties: false,
      description:
        'משפט פתיחה אופציונלי לכל סעיף. מחרוזת ריקה כשאין מה להוסיף מעל שורות הפריטים.',
      required: [...INTRO_SECTIONS],
      properties: {
        behavior: { type: 'string', description: 'פתיחה לסעיף התנהגות ונוכחות' },
        positive: { type: 'string', description: 'פתיחה לסעיף חיזוקים חיוביים' },
        homeworkNew: { type: 'string', description: 'פתיחה לסעיף מטלות חדשות' },
        release: { type: 'string', description: 'פתיחה לסעיף שחרור מוקדם' },
        board: { type: 'string', description: 'פתיחה לסעיף הודעות מלוח המודעות' },
        dueTomorrow: { type: 'string', description: 'פתיחה לסעיף מה שצפוי מחר' },
      },
    },
    items: {
      type: 'array',
      description: 'שורה אחת לכל פריט שנמסר לך, לפי ה-ref שלו.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'line', 'explicitDueDate'],
        properties: {
          ref: { type: 'string', description: 'ה-ref המדויק כפי שנמסר' },
          line: { type: 'string', description: 'משפט אחד קצר בעברית על הפריט הזה' },
          explicitDueDate: {
            type: ['string', 'null'],
            description:
              'המועד המפורש שנכתב בטקסט המטלה בפורמט YYYY-MM-DD, או null כשלא נכתב מועד.',
          },
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
  'אל תמציא עובדות ואל תוסיף פרטים שלא נמסרו לך. אל תכתוב כותרות, סמלים או תבליטים — הם נוספים אוטומטית.',
  // The job changed. The old prompt ordered the model to cram every subject,
  // every exact assignment text, every time and date into one sentence per
  // section, because that sentence was the only place the facts appeared. Warm
  // prose and a complete record are two different jobs, and that is what read
  // as unpolished. Now the grain matches the work: one item, one sentence.
  'לכל פריט שנמסר לך יש ref. החזר ב-items שורה אחת קצרה לכל ref — משפט אחד, לא יותר.',
  'השורה של פריט מסוימת לו בלבד: כתוב את הפרטים הקונקרטיים של אותו פריט ואל תזכיר פריטים אחרים.',
  'השתמש ב-ref בדיוק כפי שנמסר לך, מילה במילה. אל תמציא ref ואל תדלג על פריט שנמסר לך.',
  // The remark is rendered by the template as a quote under the line, so the
  // model repeating it would print the teacher's words twice.
  'הערת המורה מוצגת להורה בנפרד, מתחת לשורה שלך. אל תצטט אותה ואל תחזור עליה.',
  // An intro that restates the lines is the blob again, one level up.
  'ב-intros כתוב משפט פתיחה לסעיף רק אם יש לך מה לומר שהשורות עצמן לא אומרות — למשל קשר בין הפריטים.',
  'אם אין לך מה להוסיף בסעיף, החזר מחרוזת ריקה לאותו שדה. מוטב ריק מאשר חזרה על השורות.',
  'ה-headline הוא שורה אחת קצרה שמסכמת את היום, בלי תאריך ובלי שם.',
  'אל תבטיח מועד הגשה: המערכת אינה יודעת מועדי הגשה, רק מתי ניתנה המטלה.',
  // Newly assigned homework carries the timetable estimate now, so the model
  // sees a date for an item nobody published a deadline for. The rendered
  // message states that date itself, in a deterministic line that labels it as
  // an estimate (ADR-0027); a line that calls it a deadline would contradict
  // the message it sits in.
  'השדה "צפי לפי מערכת השעות" הוא חישוב לפי השיעור הבא ואינו מועד הגשה רשמי. אל תכתוב אותו כמועד הגשה — ההודעה מציגה אותו בנפרד ומסומן כצפי.',
  'אם בטקסט של מטלה נכתב מועד מפורש, החזר אותו ב-explicitDueDate של אותו פריט בפורמט YYYY-MM-DD; אחרת null.',
  'לפריט שאינו מטלה החזר explicitDueDate שווה ל-null.',
  'שחרור מוקדם הוא בקשה שההורה עצמו הגיש ואושרה: כתוב עליו כתזכורת, לא כחדשות.',
  // The board's own words are the content; a notice summarized into "there is
  // a notice" tells a parent nothing they can act on.
  'הודעות מלוח המודעות הן הודעות של בית הספר: מסור את תוכן ההודעה עצמה, לא רק שקיימת הודעה.',
  // The two behaviour sections are rendered separately, so a sentence that
  // blends praise into an absence lands under a heading that contradicts it.
  'אירועים שדורשים תשומת לב ואירועי חיזוק חיובי מוצגים בשני סעיפים נפרדים, לפי ה-ref של כל פריט.',
  'אל תכתוב על חיזוק חיובי בשורה של פריט שדורש תשומת לב, ולהפך.',
  // Nothing about consent forms: the model is handed none. That section is
  // the one input that belongs to the parent rather than to the child, and the
  // prose is shared between the parents of one child (ADR-0035), so it is
  // rendered from the deterministic Hebrew line instead. An instruction about
  // a section with no facts behind it is an invitation to invent one.
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
 * achvaName, classification, free remark and homework text, dates, and a
 * `ref` per fact. The refs are local DB ids and upstream event ids -- the same
 * class already sent for homework before ADR-0047, now sent for every fact
 * because the model keys its per-item lines by them. No new identifier leaves
 * the host, and a consent form still gets none, because it is not in the
 * prompt at all.
 * What never does: **any part of the child's name**, studentGuid, reporter and
 * teacher names, usernames. The first name used to be sent so the prose could
 * address the child; it is withheld now because the rendered message already
 * carries it in its header, and an instruction not to repeat it held only
 * sometimes. Gender is sent in its place, which is what gendered Hebrew
 * actually needs. See ADR-0026.
 */
export function buildPrompt(payload: DigestPayload): string {
  const sections: string[] = [`תאריך: ${formatSchoolDate(payload.reportFor)}`];
  if (payload.childGender !== null) {
    sections.unshift(`מין הילד/ה: ${payload.childGender === 'female' ? 'נקבה' : 'זכר'}`);
  }

  // Two blocks, matching the two rendered sections: handing the model one
  // list and asking for two lines is how praise ends up in a sentence about
  // an absence.
  const attention = payload.behavior.filter((fact) => fact.classification !== 'positive');
  const positive = payload.behavior.filter((fact) => fact.classification === 'positive');

  if (attention.length > 0) {
    sections.push(
      [
        'אירועי התנהגות ונוכחות:',
        ...attention.map((fact) => behaviorForPrompt('behavior', fact)),
      ].join('\n'),
    );
  }

  if (positive.length > 0) {
    sections.push(
      ['חיזוקים חיוביים:', ...positive.map((fact) => behaviorForPrompt('positive', fact))].join(
        '\n',
      ),
    );
  }

  if (payload.homeworkNew.length > 0) {
    sections.push(
      [
        'מטלות שניתנו היום:',
        ...payload.homeworkNew.map((fact) => homeworkForPrompt('homeworkNew', fact)),
      ].join('\n'),
    );
  }

  if (payload.homeworkDueTomorrow.length > 0) {
    sections.push(
      [
        'מטלות שאולי נדרשות מחר (הצפי מחושב, אינו מועד הגשה רשמי):',
        ...payload.homeworkDueTomorrow.map((fact) => homeworkForPrompt('dueTomorrow', fact)),
      ].join('\n'),
    );
  }

  if (payload.releases.length > 0) {
    sections.push(
      ['שחרורים מוקדמים שההורה ביקש:', ...payload.releases.map(releaseForPrompt)].join('\n'),
    );
  }

  if (payload.board.length > 0) {
    sections.push(['הודעות מלוח המודעות:', ...payload.board.map(boardForPrompt)].join('\n'));
  }

  // `payload.activities` is deliberately not rendered. The orchestrator
  // already passes an empty list, and this function is the PII boundary, so
  // the guarantee belongs here too: a consent form's title names a trip, a
  // theatre and sometimes a class, and it need never leave the host.

  return sections.join('\n\n');
}

/**
 * The notice text, and deliberately not its expiry.
 *
 * `expirationDate` is when the school takes the notice down, not the date the
 * notice is about, and a model handed it as a field will write it as a
 * deadline.
 */
function boardForPrompt(fact: DigestBoardFact): string {
  return `- ${refField('board', fact.id)} | ${fact.text.trim().replace(/\s*\n\s*/g, ' ')}`;
}

function behaviorForPrompt(section: DigestSectionId, fact: DigestBehaviorFact): string {
  const fields = [
    refField(section, fact.id),
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
  return `- ${refField('release', fact.id)} | תאריך: ${formatSchoolDate(fact.releaseDate)} | שעה: ${fact.startHour.slice(0, 5)}`;
}

/**
 * The key the model will send its line back under.
 *
 * Section-namespaced, through the same `digestItemRef` the template looks the
 * line up with -- one function decides what these strings are, because the
 * refs the model is shown and the refs the renderer reads have to be equal.
 */
function refField(section: DigestSectionId, id: string): string {
  return `ref: ${digestItemRef(section, id)}`;
}

function homeworkForPrompt(section: DigestSectionId, fact: DigestHomeworkFact): string {
  const fields = [refField(section, fact.id), `מקצוע: ${fact.subjectName}`, `מטלה: ${fact.homeworkText.trim()}`];
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
        max_tokens: maxTokensFor(payload),
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
    return {
      prose: deterministicProse(payload),
      deadlineResolutions: [],
      explicitDueDates: {},
      usedLlm: false,
    };
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
  prose: DigestProse;
  deadlineResolutions: DigestDeadlineResolution[];
  explicitDueDates: Record<string, string>;
}

/** One entry of the model's `items` array, once validated. */
interface ParsedItem {
  ref: string;
  line: string;
  explicitDueDate: string | null;
}

/**
 * Structured outputs make the shape very likely, not certain -- a truncated
 * response is still truncated -- so the result is validated rather than cast.
 * Any failure returns null and the caller renders deterministically.
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

  if (typeof candidate.headline !== 'string') return null;

  const intros = parseIntros(candidate.intros);
  if (intros === null) return null;

  if (!Array.isArray(candidate.items)) return null;
  if (!candidate.items.every(isParsedItem)) return null;
  const items = candidate.items as ParsedItem[];

  const itemLines: Record<string, string> = {};
  for (const item of items) {
    // A blank line is left OUT rather than stored as ''. The caller fills the
    // gap from the deterministic line for that one ref, so a line the model
    // skipped costs one bullet instead of a blank one.
    const line = item.line.trim();
    if (line.length > 0) itemLines[item.ref] = line;
  }

  return {
    prose: { headline: candidate.headline, intros, itemLines },
    // Only the due-tomorrow refs, and keyed back to the HOMEWORK id -- which
    // is what `narrowDueTomorrow` looks up and what the ledger stores. The
    // namespaced ref is a prompt-and-template concern and stops here.
    //
    // `homeworkNew` is excluded deliberately. One homework row is reported
    // twice on the day it is both newly assigned and estimated-due, so both
    // refs strip to the same bare id; accepting both would let `new Map(...)`
    // in `narrowDueTomorrow` keep whichever came last in the model's array,
    // making a deferral decision depend on array order. Only the due-tomorrow
    // section consumes a resolution, so only it supplies one.
    deadlineResolutions: items
      .filter((item) => item.ref.startsWith('dueTomorrow:'))
      .map((item) => ({
        ref: item.ref.slice(item.ref.indexOf(':') + 1),
        explicitDueDate: item.explicitDueDate,
      })),
    // The same answers, keyed by the ref the TEMPLATE looks things up by, and
    // for every homework item rather than only the due-tomorrow ones. A
    // namespaced key cannot collide, so a row that is both newly assigned and
    // estimated-due keeps one entry per section instead of losing one.
    //
    // Anything that is not an ISO day is dropped here rather than carried and
    // ignored downstream: `YYYY-MM-DD` is what the schema asks for, and a
    // model that answered "מחר" has answered nothing this can use.
    explicitDueDates: Object.fromEntries(
      items
        .filter((item) => isIsoDay(item.explicitDueDate))
        .map((item) => [item.ref, (item.explicitDueDate as string).trim()]),
    ),
  };
}

/**
 * The intros object, with the empty ones dropped.
 *
 * An intro only earns its place when it says something the item lines do not,
 * so a blank one is absent rather than present-and-empty -- which is what lets
 * the template render no line at all instead of a blank one.
 *
 * Returns null for a value that is not an object of strings; `undefined`
 * becomes `{}`, because the field is optional by design.
 */
function parseIntros(value: unknown): Partial<Record<DigestSectionId, string>> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const intros: Partial<Record<DigestSectionId, string>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // An unknown key is dropped rather than rejected: the template reads the
    // sections it knows, and a hallucinated section name costs nothing.
    if ((INTRO_SECTIONS as readonly string[]).includes(key)) {
      intros[key as DigestSectionId] = trimmed;
    }
  }
  return intros;
}

function isParsedItem(value: unknown): value is ParsedItem {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.ref === 'string' &&
    entry.ref.length > 0 &&
    typeof entry.line === 'string' &&
    (entry.explicitDueDate === null ||
      entry.explicitDueDate === undefined ||
      typeof entry.explicitDueDate === 'string')
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
