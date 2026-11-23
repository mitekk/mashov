/**
 * RTL utility helpers.
 *
 * Deliberately one function. `rtlMargin()` (which returned physical `mr-`/`ml-`)
 * and `rtlFlexRow()` (which returned `flex-row-reverse`) were deleted: nothing
 * imported them, and both taught the opposite of what the app does -- layout
 * here is logical properties (`ms-`, `border-s`, `-start-1`) under a single
 * `dir="rtl"` document, never direction-flipped physical ones. `isRTL()` went
 * with them: unused, and it answered at runtime a question the stylesheet
 * answers declaratively.
 */

/**
 * Direction to render a string in, by script majority.
 *
 * For the LTR islands inside an RTL page: filenames, email addresses, clock
 * ranges and credentials, where RTL reordering makes the value wrong rather
 * than just oddly aligned.
 */
export function getTextDir(text: string): 'rtl' | 'ltr' | 'auto' {
  const hebrewCount = (text.match(/[֐-׿]/g) ?? []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) ?? []).length;

  if (hebrewCount > latinCount) return 'rtl';
  if (latinCount > hebrewCount) return 'ltr';
  return 'auto';
}
