/**
 * RTL utility helpers
 */

/** Apply RTL-aware margin classes */
export function rtlMargin(
  side: 'start' | 'end',
  size: string,
): string {
  return side === 'start' ? `mr-${size}` : `ml-${size}`;
}

/** Determine text direction for mixed content */
export function getTextDir(text: string): 'rtl' | 'ltr' | 'auto' {
  // Check if text contains mostly Hebrew characters
  const hebrewPattern = /[\u0590-\u05FF]/;
  const latinPattern = /[a-zA-Z]/;
  const hebrewCount = (text.match(/[\u0590-\u05FF]/g) ?? []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) ?? []).length;

  if (hebrewCount > latinCount) return 'rtl';
  if (latinCount > hebrewCount) return 'ltr';
  return 'auto';
}

/** Class name helper for RTL-aware flex direction */
export function rtlFlexRow(): string {
  return 'flex flex-row-reverse';
}

/** Whether the browser is in RTL mode */
export function isRTL(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.dir === 'rtl';
}
