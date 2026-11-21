/**
 * What each failure means to a parent, in their own language.
 *
 * Every message names the thing they can do about it. "אירעה שגיאה" is the
 * fallback precisely because it is useless -- any code that reaches it is a
 * message worth writing.
 */
const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'שם המשתמש או הסיסמה שגויים עבור בית הספר הזה',
  UPSTREAM_ERROR: 'לא הצלחנו להתחבר למשוב כרגע. נסו שוב בעוד כמה דקות',
  SCHOOL_ALREADY_LINKED: 'בית הספר הזה כבר מחובר לחשבון',
  CONNECTION_ALREADY_LINKED: 'החשבון הזה כבר מחובר',
  NO_CHILDREN_FOUND:
    'לא נמצאו ילדים בחשבון הזה. בדקו שהזנתם את פרטי ההורה במשוב, ולא את פרטי התלמיד',
  NO_ACTIVE_CHILDREN: 'כל הילדים בחשבון הזה אינם פעילים בבית הספר',
  LIMIT_REACHED: 'ניתן לחבר עד 4 בתי ספר',
  RATE_LIMITED: 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה',
  // Reached only if the confirm step below is bypassed -- the page handles
  // this code with a confirmation, not an error. The wording names the action
  // rather than the conflict, because there is something the parent can do.
  MERGE_AVAILABLE: 'בית הספר הזה מחובר לחשבון נפרד באפליקציה. אשרו כדי לאחד אותם',
};

export const SCHOOL_LINK_FALLBACK_MESSAGE = 'אירעה שגיאה, נסו שוב מאוחר יותר';

export function schoolLinkErrorMessage(code: string | undefined): string {
  if (!code) return SCHOOL_LINK_FALLBACK_MESSAGE;
  return MESSAGES[code] ?? SCHOOL_LINK_FALLBACK_MESSAGE;
}
