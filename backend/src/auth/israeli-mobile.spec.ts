import { normalizeIsraeliPhone } from './israeli-mobile';

/**
 * Mashov checks the destination against the number the school holds, and does
 * NOT normalise it: `0541234567` reaches the phone, `+972541234567` does not.
 * Observed 2026-11-25 against production, same account, minutes apart.
 *
 * That refusal is invisible to the parent. ADR-0042 makes step 1 answer an
 * indistinguishable 202 whatever Mashov says, so a number in international
 * format produces "check your phone" and no message, with nothing to retry
 * against. Normalising here is what makes the common way to write a mobile
 * number work.
 */
describe('normalizeIsraeliPhone', () => {
  it('leaves the format Mashov actually accepts alone', () => {
    expect(normalizeIsraeliPhone('0541234567')).toBe('0541234567');
  });

  it('turns +972 into the leading zero the school holds', () => {
    expect(normalizeIsraeliPhone('+972541234567')).toBe('0541234567');
  });

  it.each([
    ['00972541234567', '0541234567'],
    ['972541234567', '0541234567'],
    ['+972-54-123-4567', '0541234567'],
    ['+972 54 123 4567', '0541234567'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normalizeIsraeliPhone(raw)).toBe(expected);
  });

  it('strips the separators people type, which are not stored digits', () => {
    expect(normalizeIsraeliPhone('054-123-4567')).toBe('0541234567');
    expect(normalizeIsraeliPhone('054 123 4567')).toBe('0541234567');
    expect(normalizeIsraeliPhone('(054) 123-4567')).toBe('0541234567');
  });

  /**
   * An RTL form is exactly where these arrive. A bidi control character is
   * invisible in the input and in a log line, and would travel upstream inside
   * the number as a character Mashov cannot match.
   */
  it('strips invisible bidi marks an RTL input can inject', () => {
    expect(normalizeIsraeliPhone('‎054‏1234567')).toBe('0541234567');
  });

  it('normalises an Israeli landline the same way', () => {
    expect(normalizeIsraeliPhone('+97236123456')).toBe('036123456');
  });

  /**
   * Conservative on purpose. Anything that is not recognisably an Israeli
   * number in international form is passed through with separators removed
   * and nothing else: guessing at a foreign number would turn a destination
   * that works today into one that does not, and the parent would never be
   * told.
   */
  it('passes an unrecognised number through rather than guessing', () => {
    expect(normalizeIsraeliPhone('+1 415 555 0132')).toBe('+14155550132');
    expect(normalizeIsraeliPhone('not a number')).toBe('notanumber');
  });

  it('never invents digits for an empty or separator-only value', () => {
    expect(normalizeIsraeliPhone('')).toBe('');
    expect(normalizeIsraeliPhone('   ')).toBe('');
  });
});
