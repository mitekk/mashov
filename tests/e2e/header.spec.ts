import { test, expect, type Page } from '@playwright/test';
import { CONVERSATION_ID, STUDENT_GUID, installApiStubs } from './helpers/viewports';

/**
 * The app-wide sticky header, in a real engine.
 *
 * Only this layer can show the fade at all: `useHeaderScroll` writes
 * `--app-header-p` on `<html>` from a rAF-throttled scroll listener and CSS
 * turns it into opacity and a translate, so there is nothing for a jsdom test
 * to observe -- jsdom has no layout, and `inert` is unimplemented there.
 * src/hooks/useHeaderScroll.test.ts covers the curve; this covers what the
 * curve does to the page.
 *
 * This runs in the `chromium` project only, at 1280x720, so it exercises the
 * inline control row. The overflow menu below `sm` belongs to
 * responsive.spec.ts, the one spec with a 360px project.
 *
 * Every `/api/v1/**` call is stubbed, like responsive.spec.ts and for the same
 * reason: scroll geometry must not depend on how many rows a seeded database
 * happens to hold.
 */

/** The first sticky stretch, and the fade distance after it. See the hook. */
const STICKY_PX = 80;
const FADE_PX = 80;

/**
 * Give the document room to scroll past the end of the fade.
 *
 * The stubbed pages are not reliably taller than the viewport, and a page that
 * cannot scroll 200px would make every assertion below vacuously true. A
 * spacer is honest about that rather than depending on fixture volume -- what
 * is under test is the header's response to a scroll offset, not how much
 * content a route happens to render.
 */
async function ensureScrollable(page: Page): Promise<void> {
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.dataset.testid = 'header-spec-spacer';
    spacer.style.height = '2000px';
    document.body.appendChild(spacer);
  });
}

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  // Two frames: one for the listener's rAF callback, one for the style to land.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function progress(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(
      getComputedStyle(document.documentElement).getPropertyValue('--app-header-p').trim() ||
        '0',
    ),
  );
}

function opacity(page: Page): Promise<number> {
  return page.evaluate(() => {
    const header = document.querySelector('[data-testid="app-header"]');
    return header ? Number(getComputedStyle(header).opacity) : -1;
  });
}

test.beforeEach(async ({ page }) => {
  await installApiStubs(page);
});

test.describe('app header', () => {
  test('owns the four household controls on every authenticated route', async ({ page }) => {
    // The whole point of the change: theme and sync used to be copy-pasted
    // into six page headers, and a seventh page would simply not have them.
    const routes = [
      '/home',
      '/children',
      '/inbox',
      '/more',
      `/children/${STUDENT_GUID}?section=homework`,
      `/inbox/${CONVERSATION_ID}`,
    ];

    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByTestId('app-header')).toBeVisible();
      await expect(page.getByTestId('theme-toggle')).toBeVisible();
      await expect(page.getByTestId('refresh-button')).toBeVisible();
      await expect(page.getByTestId('feedback-launcher-button')).toBeVisible();
      await expect(page.getByTestId('header-profile-link')).toBeVisible();
    }
  });

  test('resolves each control to exactly one node, inline branch and menu both mounted', async ({
    page,
  }) => {
    // Both branches are in the DOM at every width, one hidden by Tailwind, and
    // Playwright's strict mode counts hidden matches. A duplicate testid here
    // would break theme.spec.ts and feedback.spec.ts.
    await page.goto('/home');
    await expect(page.getByTestId('app-header')).toBeVisible();

    await expect(page.getByTestId('theme-toggle')).toHaveCount(1);
    await expect(page.getByTestId('refresh-button')).toHaveCount(1);
    await expect(page.getByTestId('feedback-launcher-button')).toHaveCount(1);
    await expect(page.getByTestId('header-menu-trigger')).toHaveCount(1);
    // ...and at 1280 the menu trigger is the hidden one.
    await expect(page.getByTestId('header-menu-trigger')).toBeHidden();
  });

  test('sticks to the viewport top while the page scrolls under it', async ({ page }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    await ensureScrollable(page);

    const header = page.getByTestId('app-header');

    await scrollTo(page, 0);
    expect(await progress(page)).toBe(0);
    await expect(header).toBeVisible();

    // Still fully visible at the end of the sticky stretch.
    await scrollTo(page, STICKY_PX);
    expect(await progress(page)).toBe(0);
    expect(await opacity(page)).toBe(1);
    const box = await header.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThanOrEqual(1);
  });

  test('fades gradually across the fade distance', async ({ page }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    await ensureScrollable(page);

    await scrollTo(page, STICKY_PX + FADE_PX / 2);

    const halfway = await progress(page);
    expect(halfway).toBeGreaterThan(0.3);
    expect(halfway).toBeLessThan(0.7);
    // Partly faded, not snapped to either end.
    const partial = await opacity(page);
    expect(partial).toBeGreaterThan(0.2);
    expect(partial).toBeLessThan(0.8);
  });

  test('goes inert once it is fully gone, so nothing invisible takes a tap or a tab', async ({
    page,
  }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    await ensureScrollable(page);

    await scrollTo(page, STICKY_PX + FADE_PX + 40);

    expect(await progress(page)).toBe(1);
    expect(await opacity(page)).toBe(0);
    // `inert` blocks pointer events AND focus in one attribute -- the reason it
    // is used here rather than `aria-hidden` plus `pointer-events: none`,
    // which leaves the buttons tabbable.
    await expect(page.getByTestId('app-header')).toHaveAttribute('inert', '');
  });

  test('fades back in on the way up', async ({ page }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    await ensureScrollable(page);

    await scrollTo(page, 300);
    expect(await progress(page)).toBe(1);

    await scrollTo(page, STICKY_PX + FADE_PX / 4);
    const partial = await progress(page);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);

    await scrollTo(page, 0);
    expect(await progress(page)).toBe(0);
    expect(await opacity(page)).toBe(1);
    await expect(page.getByTestId('app-header')).not.toHaveAttribute('inert', '');
  });

  /**
   * The point of `.sticky-under-header`, and it only shows up once the element
   * is actually STUCK -- at scroll 0 it sits in normal flow and any "is it
   * below the header" assertion passes for free. So each of these scrolls far
   * enough to pin the element, twice: once with the header still there, once
   * after it has gone.
   */
  async function stickyTopAt(page: Page, testId: string, y: number): Promise<number> {
    await scrollTo(page, y);
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${testId} has no box at scroll ${y}`).not.toBeNull();
    return box!.y;
  }

  test('keeps the inbox bulk-action bar below the header, then lets it ride up', async ({
    page,
  }) => {
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-page')).toBeVisible();

    await page.getByTestId(`conversation-select-${CONVERSATION_ID}`).first().click();
    await expect(page.getByTestId('inbox-bulk-actions')).toBeVisible();
    await ensureScrollable(page);

    // Stuck, header fully present: clear of the header's 3.5rem, plus the
    // 0.5rem gap.
    const withHeader = await stickyTopAt(page, 'inbox-bulk-actions', STICKY_PX);
    expect(await progress(page)).toBe(0);
    expect(withHeader).toBeGreaterThan(50);

    // Header gone: the bar takes its place, ending where a plain `top-2` would
    // have put it all along.
    const withoutHeader = await stickyTopAt(page, 'inbox-bulk-actions', 400);
    expect(await progress(page)).toBe(1);
    expect(withoutHeader).toBeLessThan(withHeader);
    expect(withoutHeader).toBeLessThanOrEqual(12);
  });

  test('keeps the child workspace tab rail below the header, then lets it ride up', async ({
    page,
  }) => {
    await page.goto(`/children/${STUDENT_GUID}?section=homework`);
    await expect(page.getByTestId('child-workspace')).toBeVisible();
    await ensureScrollable(page);

    const withHeader = await stickyTopAt(page, 'section-tab-homework', STICKY_PX);
    expect(await progress(page)).toBe(0);

    const headerBox = await page.getByTestId('app-header').boundingBox();
    expect(headerBox).not.toBeNull();
    // Below the header's bottom edge while the header is there.
    expect(withHeader).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);

    const withoutHeader = await stickyTopAt(page, 'section-tab-homework', 400);
    expect(await progress(page)).toBe(1);
    expect(withoutHeader).toBeLessThan(withHeader);
  });

  test('sits under an open dialog, not over it', async ({ page }) => {
    // `z-40` against the overlay's `z-50`. A header that floated over a modal
    // would let a parent fire theme or sync from behind it.
    await page.goto('/more');
    await expect(page.getByTestId('more-page')).toBeVisible();

    await page.getByTestId('feedback-launcher-button').click();
    await expect(page.getByTestId('feedback-dialog')).toBeVisible();

    const zIndexes = await page.evaluate(() => {
      const read = (selector: string): number => {
        const element = document.querySelector(selector);
        return element ? Number(getComputedStyle(element).zIndex) : Number.NaN;
      };
      return {
        header: read('[data-testid="app-header"]'),
        dialog: read('[data-testid="feedback-dialog"]'),
      };
    });

    expect(zIndexes.header).toBe(40);
    expect(zIndexes.dialog).toBeGreaterThan(zIndexes.header);
  });

  test('thanks the parent exactly once, however many triggers there are', async ({ page }) => {
    await page.goto('/more');
    await expect(page.getByTestId('more-page')).toBeVisible();

    await page.getByTestId('feedback-launcher-button').click();
    await expect(page.getByTestId('feedback-dialog')).toBeVisible();

    // One provider, so one live region -- not one per trigger.
    await expect(page.getByTestId('feedback-thanks-live')).toHaveCount(1);
  });

  test('is absent from the centred shell, which has no household to act on', async ({ page }) => {
    await page.goto('/more/telegram');
    await expect(page.getByTestId('telegram-setup-page')).toBeVisible();

    await expect(page.getByTestId('app-header')).toHaveCount(0);
  });
});
