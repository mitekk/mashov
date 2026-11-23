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
};

/** Rate limiting is ours, not Mashov's, so it is not in the Reason table. */
const TOO_MANY_REQUESTS = 'יותר מדי נסיונות כניסה. נסה שוב בעוד כמה דקות';

const GENERIC = 'אירעה שגיאה, נסה שוב מאוחר יותר';

export interface ReadAuthError {
  /** The backend's error code, when there was one. */
  code: string | undefined;
  /** Hebrew copy, never empty. */
  message: string;
  /** Present only on MFA_REQUIRED: the handle on the challenge Mashov opened. */
  challengeId: string | undefined;
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
    return { code: undefined, message: GENERIC, challengeId: undefined };
  }

  const envelope = (error.body as { error?: { code?: string; challengeId?: string } })
    ?.error;
  const code = envelope?.code || undefined;

  if (error.status === 429) {
    return { code, message: TOO_MANY_REQUESTS, challengeId: undefined };
  }

  if (code && isKnownCode(code)) {
    return {
      code,
      message: AUTH_ERROR_COPY[code],
      challengeId: code === 'MFA_REQUIRED' ? envelope?.challengeId : undefined,
    };
  }

  return { code, message: GENERIC, challengeId: undefined };
}
