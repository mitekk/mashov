import { ApiError } from '@/api/client';
import type { AuthErrorCode } from '@/types/api';

/**
 * What a failed sign-in says to the parent, per backend error code.
 *
 * Until now the form had two branches: 401-or-429 said "wrong credentials" and
 * everything else said "something went wrong". Mashov distinguishes far more
 * than that, and for seven of its answers the password is CORRECT -- the
 * account needs an MFA code, a forced password change, or a captcha. Those
 * parents were told their password was wrong and retyped it until the rate
 * limiter locked them out.
 *
 * The copy lives here rather than being rendered from the backend's `message`:
 * the envelope's message is English, it is a developer-facing fallback, and a
 * client should not show a parent whatever string a server happens to send.
 */
export const AUTH_ERROR_COPY: Record<AuthErrorCode, string> = {
  INVALID_CREDENTIALS: 'פרטי הכניסה שגויים, נסה שוב',
  MFA_REQUIRED: 'נדרש קוד אימות חד-פעמי להשלמת הכניסה',
  PASSWORD_CHANGE_REQUIRED: 'משוב דורש החלפת סיסמה לפני הכניסה',
  CREDENTIALS_SETUP_REQUIRED: 'יש להשלים הגדרת שם משתמש וסיסמה',
  CAPTCHA_REQUIRED: 'נא לסמן "אני לא רובוט"',
  NO_CHILDREN: 'לא נמצאו ילדים משויכים לחשבון זה',
  SCHOOL_CLOSED: 'בית הספר סגור במערכת משוב',
  USER_INACTIVE: 'החשבון אינו פעיל בשנה זו',
  USE_USERNAME: 'יש להתחבר עם שם המשתמש ולא עם מספר הזהות',
  UPSTREAM_ERROR: 'משוב אינו זמין כרגע',

  // Password recovery.
  RECOVERY_THROTTLED: 'משוב חוסם כרגע שליחת קודים לחשבון הזה. נסה שוב מאוחר יותר',
  RECOVERY_SESSION_EXPIRED: 'תהליך איפוס הסיסמה פג. יש להתחיל מחדש',
  INVALID_RECOVERY_CODE: 'קוד האימות שגוי',
  RECOVERY_CODE_EXPIRED: 'קוד האימות פג. יש להתחיל מחדש',
  RECOVERY_LOCKED: 'יותר מדי נסיונות. יש להתחיל את האיפוס מחדש',
  SECOND_CODE_REQUIRED: 'משוב שלח קוד גם לאימייל וגם לטלפון. יש להזין את שני הקודים',
  WEAK_PASSWORD: 'הסיסמה אינה עומדת בדרישות משוב',

  // MFA.
  INVALID_MFA_CODE: 'קוד האימות שגוי',
  MFA_CODE_EXPIRED: 'קוד האימות פג. יש לבקש קוד חדש',
  MFA_LOCKED: 'יותר מדי נסיונות. נסה שוב מאוחר יותר',
  MFA_RESEND_TOO_SOON: 'קוד נשלח לפני רגע. יש להמתין לפני בקשת קוד נוסף',
  MFA_CONTACT_MISSING: 'אין במשוב אימייל או טלפון לחשבון הזה',

  // Forced credential change.
  USERNAME_TAKEN: 'שם המשתמש הזה כבר תפוס במשוב',
  USERNAME_LOCKED: 'יותר מדי החלפות שם משתמש. נסה שוב מאוחר יותר',
  CREDENTIALS_SETUP_FAILED: 'משוב לא אישר את השינוי. נסה שוב',

  // Passwordless sign-in. The first is the sync constraint made visible: it is
  // the reason an OTP-only household cannot exist.
  PASSWORD_SIGN_IN_REQUIRED:
    'הכניסה הראשונה לבית ספר צריכה להיות עם סיסמה, כדי שהנתונים יתעדכנו ברקע',
  INVALID_OTP_CODE: 'קוד האימות שגוי',
  OTP_CODE_EXPIRED: 'קוד האימות פג. יש לבקש קוד חדש',
  OTP_LOCKED: 'יותר מדי נסיונות. יש לבקש קוד חדש',
  OTP_RESEND_TOO_SOON: 'קוד נשלח לפני רגע. יש להמתין לפני בקשת קוד נוסף',
  OTP_CONTACT_MISSING: 'אין במשוב אימייל או טלפון לחשבון הזה',
  OTP_SESSION_EXPIRED: 'תהליך הכניסה פג. יש לבקש קוד חדש',
  LOGIN_METHOD_BLOCKED: 'בית הספר הזה אינו מאפשר כניסה בלי סיסמה',

  // Shared.
  VALIDATION_ERROR: 'חסרים פרטים. יש להשלים את כל השדות',
  RATE_LIMITED: 'יותר מדי נסיונות. נסה שוב בעוד כמה דקות',
};

/**
 * The codes whose envelope can carry a `challengeId`.
 *
 * All three are cases where Mashov opened something that has to be referenced
 * back: the MFA challenge, and the forced change, which Mashov wants echoed as
 * `mfaChallengeId`.
 */
const CHALLENGE_BEARING_CODES = new Set<AuthErrorCode>([
  'MFA_REQUIRED',
  'PASSWORD_CHANGE_REQUIRED',
  'CREDENTIALS_SETUP_REQUIRED',
]);

/** Rate limiting is ours, not Mashov's, so it is not in the Reason table. */
const TOO_MANY_REQUESTS = 'יותר מדי נסיונות כניסה. נסה שוב בעוד כמה דקות';

const GENERIC = 'אירעה שגיאה, נסה שוב מאוחר יותר';

export interface ReadAuthError {
  /** The backend's error code, when there was one. */
  code: string | undefined;
  /** Hebrew copy, never empty. */
  message: string;
  /**
   * The handle on a challenge Mashov opened. Present on `MFA_REQUIRED`, and on
   * the forced-change codes, which carry one too and must echo it back.
   */
  challengeId: string | undefined;
  /**
   * Field-level messages from the envelope's `details[]`, already in Hebrew.
   *
   * These are the difference between "the password does not meet the policy"
   * and "the password cannot contain your username". The reset screen hides
   * the relational rule from its live checklist (the username is unknown
   * there), so without these a parent sees an all-green checklist and a
   * generic rejection, with nothing to act on.
   */
  details: string[];
}

function isKnownCode(code: string): code is AuthErrorCode {
  return Object.prototype.hasOwnProperty.call(AUTH_ERROR_COPY, code);
}

/**
 * Turn whatever the mutation rejected with into a code plus Hebrew copy.
 *
 * Unknown codes fall through to the generic message rather than rendering the
 * backend's English one: a new code the client has not been taught is a bug to
 * fix, not a string to show a parent.
 */
export function readAuthError(error: unknown): ReadAuthError {
  if (!(error instanceof ApiError)) {
    return { code: undefined, message: GENERIC, challengeId: undefined, details: [] };
  }

  const envelope = (
    error.body as {
      error?: {
        code?: string;
        challengeId?: string;
        details?: Array<{ message?: string }>;
      };
    }
  )?.error;
  const code = envelope?.code || undefined;
  const details = (envelope?.details ?? [])
    .map((detail) => detail?.message)
    .filter((message): message is string => typeof message === 'string' && message.length > 0);

  // The code lookup comes FIRST, before the 429 fallback: several of our 429s
  // have copy of their own (RECOVERY_THROTTLED, MFA_LOCKED, OTP_LOCKED), and a
  // blanket "too many attempts" would throw away the one thing that tells the
  // parent which limit they hit and what to do about it.
  if (code && isKnownCode(code)) {
    return {
      code,
      message: AUTH_ERROR_COPY[code],
      challengeId: CHALLENGE_BEARING_CODES.has(code)
        ? envelope?.challengeId
        : undefined,
      details,
    };
  }

  if (error.status === 429) {
    return { code, message: TOO_MANY_REQUESTS, challengeId: undefined, details };
  }

  return { code, message: GENERIC, challengeId: undefined, details };
}

/**
 * The message to show, preferring the server's field-level detail.
 *
 * A `422 WEAK_PASSWORD` whose `details[]` name the broken rules is strictly
 * more useful than the code's own copy, which can only say "does not meet the
 * policy".
 */
export function authErrorText(read: ReadAuthError): string {
  return read.details.length > 0 ? read.details.join(' · ') : read.message;
}
