import type { Page } from '@playwright/test';

/**
 * Horizontal-overflow detection for the responsive suite.
 *
 * The subtlety that shapes all of this: `overflow-x: clip` on html/body -- the
 * guard this work added -- MASKS the very defect these helpers exist to catch.
 * With it in place `documentElement.scrollWidth <= clientWidth` is satisfied
 * while content sits unreachably off-canvas. So the primary check is a walk of
 * every element's own `getBoundingClientRect()`, and the scrollWidth check
 * stays only as a cheap backstop.
 */

export interface OverflowingElement {
  /** A short, human-readable path to the offender. */
  selector: string;
  /** Its testid, when it has one -- the fastest way to find it in source. */
  testId: string | null;
  left: number;
  right: number;
  width: number;
}

/**
 * Every visible element whose box escapes the viewport horizontally.
 *
 * Deliberately skipped:
 *  - `display:none`, `visibility:hidden` and zero-area elements: not on screen.
 *  - `position:fixed`: the nav, dialogs and the attachment viewer are
 *    legitimately viewport-anchored, and a translated centred panel reports a
 *    rect that looks like overflow when it is not.
 *  - anything inside an ancestor that scrolls horizontally: the chip rails,
 *    the timetable wrapper and each prose table are intentional scrollers, and
 *    their content is MEANT to be wider than they are.
 *
 * Both edges are checked: under `dir="rtl"` overflow escapes to the LEFT, so a
 * right-edge-only assertion would pass on exactly this app's layout bugs.
 */
export async function findHorizontalOverflow(page: Page): Promise<OverflowingElement[]> {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    // One device pixel of slack: subpixel layout rounding routinely puts a
    // full-width element at 360.004px.
    const TOLERANCE = 1;

    function describe(element: Element): string {
      const parts: string[] = [];
      let node: Element | null = element;
      for (let depth = 0; node && depth < 4; depth += 1) {
        const tag = node.tagName.toLowerCase();
        const testId = node.getAttribute('data-testid');
        parts.unshift(testId ? `${tag}[data-testid="${testId}"]` : tag);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }

    function scrollsHorizontally(style: CSSStyleDeclaration): boolean {
      return style.overflowX === 'auto' || style.overflowX === 'scroll';
    }

    /** True when some ancestor is an intentional horizontal scroller. */
    function insideScroller(element: Element): boolean {
      let node = element.parentElement;
      while (node && node !== document.body) {
        if (scrollsHorizontally(getComputedStyle(node))) return true;
        node = node.parentElement;
      }
      return false;
    }

    /** True when the element or an ancestor is viewport-anchored. */
    function insideFixed(element: Element): boolean {
      let node: Element | null = element;
      while (node && node !== document.body) {
        if (getComputedStyle(node).position === 'fixed') return true;
        node = node.parentElement;
      }
      return false;
    }

    const offenders: Array<{
      selector: string;
      testId: string | null;
      left: number;
      right: number;
      width: number;
    }> = [];

    for (const element of Array.from(document.querySelectorAll('body *'))) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (insideFixed(element)) continue;
      if (insideScroller(element)) continue;

      const escapesRight = rect.right > viewportWidth + TOLERANCE;
      const escapesLeft = rect.left < -TOLERANCE;
      if (!escapesRight && !escapesLeft) continue;

      offenders.push({
        selector: describe(element),
        testId: element.getAttribute('data-testid'),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      });
    }

    return offenders;
  });
}

/** The cheap backstop: does the document itself scroll sideways? */
export async function documentScrollsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth + 1;
  });
}

/** A failure message that names the offenders instead of just a count. */
export function formatOverflow(offenders: OverflowingElement[]): string {
  return offenders
    .map((o) => `  ${o.selector} (left ${o.left}, right ${o.right}, width ${o.width})`)
    .join('\n');
}
