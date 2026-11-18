/**
 * Attachment fetch failures → Hebrew messages.
 *
 * One table, matched top to bottom, so the whole user-visible failure surface
 * is readable in one screen. Pure: no I/O, no throwing.
 */

/** A failed attachment fetch. `status` is `0` for a timeout, abort or network
 * error — anything that never produced an HTTP response. */
export class AttachmentError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? `Attachment request failed (${status} ${code})`);
    this.name = 'AttachmentError';
    this.status = status;
    this.code = code;
  }
}

/** Code used when the request never completed — timeout, abort or offline. */
export const ATTACHMENT_TIMEOUT_CODE = 'TIMEOUT';

export interface AttachmentErrorDescription {
  /** Hebrew text for the error card. */
  message: string;
  /** Whether re-running the same request could plausibly succeed. */
  canRetry: boolean;
}

interface ErrorRule {
  matches: (error: AttachmentError) => boolean;
  describe: AttachmentErrorDescription;
}

const RULES: ErrorRule[] = [
  {
    // The backend collapses a failed upstream fetch into a generic 404
    // (`mail.service.ts`), so this covers both "deleted" and "upstream lost it".
    matches: (error) => error.status === 404,
    describe: { message: 'הקובץ אינו זמין יותר במשוב', canRetry: true },
  },
  {
    matches: (error) =>
      error.status === 504 ||
      error.status === 0 ||
      error.code === ATTACHMENT_TIMEOUT_CODE ||
      error.code === 'GATEWAY_TIMEOUT',
    describe: { message: 'הקובץ לא נטען בזמן. נסו שוב.', canRetry: true },
  },
  {
    matches: (error) => error.status === 502 || error.code === 'UPSTREAM_ERROR',
    describe: { message: 'השירות אינו זמין כרגע', canRetry: true },
  },
  {
    matches: (error) => error.status === 401 || error.status === 403,
    describe: { message: 'יש להתחבר מחדש כדי לצפות בקובץ', canRetry: false },
  },
];

const FALLBACK: AttachmentErrorDescription = {
  message: 'לא ניתן לטעון את הקובץ',
  canRetry: true,
};

/**
 * Describe any thrown value. The fetcher classifies what it can into an
 * `AttachmentError` (including timeouts and aborts, as status `0`); anything
 * else is unclassified and gets the generic message rather than a guess.
 */
export function describeAttachmentError(error: unknown): AttachmentErrorDescription {
  if (!(error instanceof AttachmentError)) return FALLBACK;

  return RULES.find((rule) => rule.matches(error))?.describe ?? FALLBACK;
}
