/**
 * Putting a phone number into the one shape Mashov matches against.
 *
 * Mashov compares the `cellphone` on `POST /api/user/recover` against the
 * number the school holds, and compares it literally: observed 2026-11-25
 * against production, `0541234567` delivered an SMS and `+972541234567` --
 * the same phone, the same minute -- did not.
 *
 * That failure is silent. ADR-0042 requires step 1 to answer an
 * indistinguishable `202` whether or not Mashov accepted the request, so a
 * parent whose contacts app or browser autofill hands them `+972...` is told
 * to check their phone and never receives anything. There is no error to read
 * and nothing to retry differently, which makes this worse for them than a
 * refusal would be.
 *
 * So the normalisation happens here rather than being asked of the parent.
 */

/**
 * Separators and invisible marks that are typed or pasted but never stored.
 *
 * The bidi controls matter more than they look: the form is RTL, and a
 * `U+200E`/`U+200F` inside a number is invisible in the input, invisible in a
 * log line, and travels upstream as a character Mashov cannot match.
 */
const NOISE = /[\s\-().‎‏​‪-‮⁦-⁩]/g;

/**
 * Israel in international form, in the three ways it gets written, followed by
 * a subscriber number with its own leading zero dropped.
 *
 * 8 or 9 digits covers landlines (`3-6123456`) and mobiles (`54-1234567`).
 */
const ISRAELI_INTERNATIONAL = /^(?:\+972|00972|972)(\d{8,9})$/;

/**
 * The number as the school stores it, as far as we can tell from one capture.
 *
 * Deliberately conservative: anything not recognisably Israeli-international
 * is returned with separators stripped and otherwise untouched. Guessing at a
 * foreign number could turn a destination that works today into one that does
 * not -- and the parent would never be told, for the same reason the original
 * failure was invisible.
 */
export function normalizeIsraeliPhone(raw: string): string {
  const cleaned = raw.replace(NOISE, '');
  const international = ISRAELI_INTERNATIONAL.exec(cleaned);
  return international ? `0${international[1]}` : cleaned;
}
