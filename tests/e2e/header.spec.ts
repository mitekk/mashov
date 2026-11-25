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
 * This runs in the `chromium` project only, at 1280x720. The header has one
 * shape at every width -- title, child switcher, profile avatar -- so the
 * per-width assertions belong to responsive.spec.ts, the one spec with a
 * 360px project.
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

/**
 * Take the spacer away again, for the one test that interacts with the header
 * after scrolling it.
 *
 * The spacer hangs off `document.body`, OUTSIDE the Next root -- deliberately,
 * so it survives a client-side navigation -- which leaves the document taller
 * than the header's sticky containing block. In that geometry Chromium's
 * focus-driven `scrollIntoView` for the sticky, transformed header jumps the
 * document to its maximum offset: focusing `header-profile-trigger` at offset
 * 0 lands at 1668, the header fades to `p: 1` and `useHeaderScroll` marks it
 * `inert` mid-gesture, so a menu opened in that frame is torn straight back
 * down. It does not reproduce when the scroll height comes from content inside
 * the sticky container, which is every real page -- responsive.spec.ts drives
 * the same menu after the same scroll round trip and passes. So the spacer
 * goes once it has done its job, rather than the header's geometry bending to
 * accommodate it.
 */
async function removeSpacer(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('[data-testid="header-spec-spacer"]')?.remove();
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

/**
 * Every header action lives behind the avatar now, so reaching one is two
 * clicks. The menu closes on select, which is why each caller re-opens.
 */
async function openHeaderMenu(page: Page): Promise<void> {
  await page.getByTestId('header-profile-trigger').click();
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
  test('offers the one action trigger on every authenticated route', async ({ page }) => {
    // The whole point of the change: theme and sync used to be copy-pasted
    // into six page headers, and a seventh page would simply not have them.
    // They now have exactly one home, and `toHaveCount(1)` is what keeps it
    // that way -- Playwright's strict mode counts hidden matches, so a second
    // copy of the trigger anywhere in the tree would resolve two nodes here.
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
      await expect(page.getByTestId('header-profile-trigger')).toHaveCount(1);
      await expect(page.getByTestId('header-profile-trigger')).toBeVisible();
    }
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
    // The LOWER bound is what proves stickiness. `boundingBox().y` is
    // viewport-relative and goes negative for content scrolled off the top, so
    // a `<= 1` assertion alone passes for a header that scrolled away at
    // y = -80 -- this test would not have failed if `sticky top-0` were
    // dropped. Pinned at the top means y is 0, from both sides.
    expect(box!.y).toBeGreaterThanOrEqual(0);
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

    // The translate is the half of `.app-header` that actually gets the header
    // out of the way. Opacity alone would leave an invisible but still
    // hit-testable 56px box over the top of the content for every p <= 0.99,
    // and nothing else here would notice: delete the `translateY` and every
    // other assertion in this file still passes.
    const transform = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="app-header"]');
      return header ? getComputedStyle(header).transform : '';
    });
    // `matrix(a, b, c, d, tx, ty)` -- ty is the vertical translate, and it has
    // to be meaningfully negative (the header sliding up), not 0.
    const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
    expect(matrix, `expected a matrix transform, got ${transform}`).not.toBeNull();
    const translateY = Number(matrix![1].split(',')[5]);
    expect(translateY).toBeLessThan(-5);
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

  /**
   * The fade is pinned open while the header holds focus -- but the menu's
   * content is portaled to `<body>`, so opening it moves focus OUT of the
   * header and `focusout` re-applies the real progress. Unfixed, the header
   * fades to nothing and goes inert under its own open menu: a popover left
   * floating with no visible trigger, and an Escape that restores focus to an
   * inert node, which silently means `<body>`.
   *
   * The order matters. Focus first, then scroll, then open: that is the only
   * way to be past the fade distance with the trigger still clickable, since
   * the pin is what keeps it out of `inert` on the way down.
   */
  test('stays visible while its own menu is open past the fade distance', async ({ page }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    await ensureScrollable(page);

    const trigger = page.getByTestId('header-profile-trigger');
    await trigger.focus();
    await scrollTo(page, STICKY_PX + FADE_PX + 40);
    expect(await progress(page)).toBe(0);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('header-menu-settings')).toBeVisible();

    expect(await progress(page)).toBe(0);
    expect(await opacity(page)).toBe(1);
    await expect(page.getByTestId('app-header')).not.toHaveAttribute('inert', '');
    await expect(trigger).toBeVisible();

    // And the trigger is still a live node to come back to.
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
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

    await openHeaderMenu(page);
    await page.getByTestId('header-menu-feedback').click();
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

    await openHeaderMenu(page);
    await page.getByTestId('header-menu-feedback').click();
    await expect(page.getByTestId('feedback-dialog')).toBeVisible();

    // One provider, so one live region -- not one per trigger.
    await expect(page.getByTestId('feedback-thanks-live')).toHaveCount(1);
  });

  /**
   * `STICKY_PX` and `FADE_PX` are re-declared here as literals -- a Playwright
   * spec cannot import from `frontend/src` across the tsconfig boundary. The
   * danger of a copied constant is not that it goes wrong but that it goes
   * VACUOUS: raise the hook's `STICKY_PX` to 200 and "still fully visible at
   * 80" keeps passing while testing nothing.
   *
   * So pin the boundaries themselves. Each of these fails if the real curve
   * moves in either direction.
   */
  test('starts fading exactly where the hook says, and finishes where it says', async ({
    page,
  }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    await ensureScrollable(page);

    await scrollTo(page, STICKY_PX);
    expect(await progress(page)).toBe(0);

    // Just past the sticky stretch it must already have started moving.
    await scrollTo(page, STICKY_PX + 4);
    expect(await progress(page)).toBeGreaterThan(0);

    // Just before the end of the fade it must NOT be finished yet.
    await scrollTo(page, STICKY_PX + FADE_PX - 4);
    expect(await progress(page)).toBeLessThan(1);

    await scrollTo(page, STICKY_PX + FADE_PX);
    expect(await progress(page)).toBe(1);
  });

  /**
   * The remount path. `--app-header-p` is global state on `<html>` written by
   * whichever header is mounted, and during an App Router transition the
   * outgoing route's tree is still mounted while the incoming one renders. A
   * header that landed on a fresh route still faded out -- or worse, inert --
   * would be a dead top bar the parent cannot use.
   */
  test('comes back visible after navigating away while faded out', async ({ page }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible();
    await ensureScrollable(page);

    await scrollTo(page, 400);
    expect(await progress(page)).toBe(1);
    await expect(page.getByTestId('app-header')).toHaveAttribute('inert', '');

    await page.getByTestId('nav-inbox').click();
    await expect(page.getByTestId('inbox-page')).toBeVisible();

    // Still scrolled: `ensureScrollable` appends its spacer to `document.body`,
    // outside the Next root, so it survives a client-side navigation and the
    // offset is preserved. A faded header is the CORRECT answer here -- what
    // matters is that the property still tracks the real offset rather than
    // having been wiped to the `:root` fallback of 0 by the outgoing header's
    // cleanup, which would paint a solid header over scrolled content.
    expect(await progress(page)).toBe(1);

    // And it is not dead: scrolling back up on the new route brings it round.
    await scrollTo(page, 0);
    expect(await progress(page)).toBe(0);
    expect(await opacity(page)).toBe(1);
    await expect(page.getByTestId('app-header')).not.toHaveAttribute('inert', '');

    // Every assertion above is about the scroll offset surviving the
    // navigation, so the spacer has done its job by here. See `removeSpacer`.
    await removeSpacer(page);
    await expect(page.getByTestId('header-profile-trigger')).toBeVisible();
    await openHeaderMenu(page);
    await page.getByTestId('header-menu-theme').click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true);
  });

  test('is absent from the centred shell, which has no household to act on', async ({ page }) => {
    await page.goto('/more/telegram');
    await expect(page.getByTestId('telegram-setup-page')).toBeVisible();

    await expect(page.getByTestId('app-header')).toHaveCount(0);
  });
});
