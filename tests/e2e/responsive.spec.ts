import { test, expect } from '@playwright/test';
import {
  documentScrollsHorizontally,
  findHorizontalOverflow,
  formatOverflow,
} from './helpers/overflow';
import { CONVERSATION_ID, ROUTES, STUDENT_GUID, installApiStubs } from './helpers/viewports';

/**
 * The adaptive-layout regression suite.
 *
 * It runs three times -- `mobile-360`, `tablet-768`, `desktop-1280` -- and is
 * the ONLY spec that does. The other twelve specs encode the desktop DOM and
 * deliberately keep their single 1280 project: re-running them at 360 would
 * fail on every lg-only element and triple CI time for no signal.
 *
 * Playwright's `testProject` is how one spec asserts different things per
 * width without a `useMediaQuery` of its own.
 *
 * Two deliberate departures from .claude/rules/testing.md, recorded here
 * rather than left to be rediscovered:
 *
 * 1. It addresses the DOM with `getByTestId` instead of the page objects in
 *    tests/e2e/pages/. Those classes model one route's behaviour each; this
 *    spec sweeps thirteen routes asserting one geometric property apiece, and
 *    threading it through thirteen page objects would add indirection without
 *    adding meaning. The testids it uses are the same ones those classes wrap.
 *
 * 2. It stubs every `/api/v1/**` call in the browser rather than exercising
 *    the Dockerized backend, so it would stay green against a broken one. That
 *    is the point: layout at a given width must not depend on which rows a
 *    seeded database happens to hold, and there is no fixture that puts all
 *    thirteen routes into a rendered state. The other twelve specs cover the
 *    stack; this one covers geometry, and `installApiStubs` is tuned to the
 *    hard case -- two schools, long labels, a 900px table -- precisely because
 *    fixtures are the only lever it has.
 */

const MOBILE = 'mobile-360';
const TABLET = 'tablet-768';
const DESKTOP = 'desktop-1280';

/** Below this the nav is a bottom bar; at and above it, a side rail. */
const RAIL_BREAKPOINT = 1024;
const RAIL_WIDTH = 80;
const MIN_TAP_TARGET = 44;

test.beforeEach(async ({ page }) => {
  await installApiStubs(page);
});

test.describe('pinch-zoom', () => {
  test('is not blocked by the viewport meta', async ({ page }) => {
    // `maximumScale: 1` used to be set in app/layout.tsx, which is a WCAG
    // 1.4.4 failure. This is asserted under `isMobile: true` projects, where
    // Chromium actually applies meta-viewport emulation.
    await page.goto('/home');

    const content = await page
      .locator('meta[name="viewport"]')
      .first()
      .getAttribute('content');

    expect(content).not.toBeNull();
    expect(content ?? '').not.toMatch(/maximum-scale/i);
    expect(content ?? '').not.toMatch(/user-scalable\s*=\s*(no|0)/i);
  });
});

test.describe('nav shape', () => {
  test('is a bottom bar below lg and a side rail at lg', async ({ page }, testInfo) => {
    await page.goto('/home');

    const nav = page.getByTestId('bottom-nav');
    // One node, not two: a bottom bar plus a separate side rail would resolve
    // this twice and throw in strict mode.
    await expect(nav).toHaveCount(1);
    await expect(nav).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const { width, height } = viewport!;

    const box = await nav.boundingBox();
    expect(box).not.toBeNull();

    if (width >= RAIL_BREAKPOINT) {
      expect(testInfo.project.name).toBe(DESKTOP);
      // Full-height, rail-wide, and flush against the START edge -- which
      // under dir="rtl" is the RIGHT edge, hence x + width ~= viewport width.
      expect(box!.height).toBeGreaterThan(height * 0.9);
      expect(Math.abs(box!.width - RAIL_WIDTH)).toBeLessThanOrEqual(2);
      expect(Math.abs(box!.x + box!.width - width)).toBeLessThanOrEqual(2);
    } else {
      expect([MOBILE, TABLET]).toContain(testInfo.project.name);
      expect(Math.abs(box!.y + box!.height - height)).toBeLessThanOrEqual(2);
      expect(Math.abs(box!.width - width)).toBeLessThanOrEqual(2);
    }
  });

  test('renders the unread count as text at every width', async ({ page }) => {
    // school-filter.spec.ts pins this at 1280; a rail that degraded the badge
    // to a dot would break it, so it is asserted at all three widths here too.
    await page.goto('/home');

    await expect(page.getByTestId('nav-inbox')).toContainText('64');
  });
});

test.describe('tap targets at every width', () => {
  test('every nav destination is at least 44x44', async ({ page }) => {
    await page.goto('/home');
    await expect(page.getByTestId('home-header')).toBeVisible({ timeout: 15_000 });

    for (const testId of ['nav-home', 'nav-children', 'nav-inbox', 'nav-more']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, `${testId} has no box`).not.toBeNull();
      expect(box!.width, `${testId} width`).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
      expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    }
  });

  test('every workspace section tab is at least 44x44', async ({ page }) => {
    // The guard for `.tap-target` surviving the rail's `lg:w-full lg:flex-none`
    // and the sidebar flip.
    await page.goto(`/children/${STUDENT_GUID}?section=homework`);
    await expect(page.getByTestId('child-workspace')).toBeVisible({ timeout: 15_000 });

    const tabs = page.locator('[data-testid^="section-tab-"]');
    const count = await tabs.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const tab = tabs.nth(index);
      const testId = await tab.getAttribute('data-testid');
      const box = await tab.boundingBox();
      expect(box, `${testId} has no box`).not.toBeNull();
      expect(box!.width, `${testId} width`).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
      expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    }
  });
});

test.describe('app header', () => {
  test('collapses its controls into one menu below sm', async ({ page }, testInfo) => {
    // The header's three app-wide buttons plus an avatar do not fit beside a
    // page title at 360, so below `sm` they become one overflow menu. Both
    // branches are in the DOM at every width -- Tailwind hides one -- which is
    // why each control still resolves to exactly one node.
    await page.goto('/home');
    await expect(page.getByTestId('app-header')).toBeVisible();

    const trigger = page.getByTestId('header-menu-trigger');
    const inline = page.getByTestId('theme-toggle');

    await expect(trigger).toHaveCount(1);
    await expect(inline).toHaveCount(1);

    if (testInfo.project.name === MOBILE) {
      await expect(trigger).toBeVisible();
      await expect(inline).toBeHidden();
      await expect(page.getByTestId('refresh-button')).toBeHidden();
      await expect(page.getByTestId('feedback-launcher-button')).toBeHidden();
    } else {
      await expect(trigger).toBeHidden();
      await expect(inline).toBeVisible();
      await expect(page.getByTestId('refresh-button')).toBeVisible();
    }
  });

  test('keeps the overflow trigger a 44x44 tap target', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE, 'The trigger is hidden from sm up.');
    await page.goto('/home');
    await expect(page.getByTestId('app-header')).toBeVisible();

    const box = await page.getByTestId('header-menu-trigger').boundingBox();
    expect(box, 'header-menu-trigger has no box').not.toBeNull();
    expect(box!.width, 'header-menu-trigger width').toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    expect(box!.height, 'header-menu-trigger height').toBeGreaterThanOrEqual(MIN_TAP_TARGET);
  });

  test('toggles the theme from the overflow menu', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE, 'The menu exists only below sm.');
    await page.goto('/home');
    await expect(page.getByTestId('app-header')).toBeVisible();

    const wasDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );

    await page.getByTestId('header-menu-trigger').click();
    await expect(page.getByTestId('header-menu-theme')).toBeVisible();
    await page.getByTestId('header-menu-theme').click();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(!wasDark);
  });

  test('keeps the avatar out of the menu at every width', async ({ page }) => {
    // The one control that does NOT collapse: the profile link stays on the
    // bar at 360, because it is the way back to /more and an identity cue, not
    // an action.
    await page.goto('/home');
    await expect(page.getByTestId('app-header')).toBeVisible();

    await expect(page.getByTestId('header-profile-link')).toBeVisible();
    await expect(page.getByTestId('header-profile-link')).toHaveCount(1);
  });

  test('drives the overflow menu from the keyboard and gives focus back', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE, 'The menu exists only below sm.');
    // `dir="rtl"` on the Radix root is what makes the arrow keys follow the
    // writing direction, and Escape restoring focus to the trigger is the only
    // thing that stops a keyboard user being dumped at the top of the document.
    await page.goto('/home');
    await expect(page.getByTestId('app-header')).toBeVisible();

    const trigger = page.getByTestId('header-menu-trigger');
    await trigger.focus();
    await page.keyboard.press('Enter');
    // Opening from the keyboard lands on the first item, so the parent is
    // already somewhere useful rather than on the panel itself.
    await expect(page.getByTestId('header-menu-feedback')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('header-menu-theme')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('header-menu-theme')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('offers feedback and sync from the overflow menu', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE, 'The menu exists only below sm.');
    await page.goto('/home');
    await expect(page.getByTestId('app-header')).toBeVisible();

    await page.getByTestId('header-menu-trigger').click();

    // None of these reuses an inline testid: strict mode counts hidden
    // matches, so a duplicate would resolve two nodes everywhere.
    await expect(page.getByTestId('header-menu-feedback')).toBeVisible();
    await expect(page.getByTestId('header-menu-refresh')).toBeVisible();

    await page.getByTestId('header-menu-feedback').click();
    await expect(page.getByTestId('feedback-dialog')).toBeVisible();
  });
});

test.describe('timetable presentation', () => {
  test('is the day agenda below md and the week grid at md and up', async ({ page }, testInfo) => {
    // The assertion that proves the CSS flip landed -- and the one that would
    // catch a hydration flip, because a JS-switched presentation would show
    // the wrong arm on first paint.
    await page.goto(`/children/${STUDENT_GUID}?section=timetable`);
    await expect(page.getByTestId('timetable-section')).toBeVisible({ timeout: 15_000 });

    const agendaLesson = page.getByTestId('timetable-agenda-lesson').first();
    const gridCell = page.getByTestId('timetable-lesson-cell').first();

    if (testInfo.project.name === MOBILE) {
      await expect(agendaLesson).toBeVisible();
      await expect(gridCell).toBeHidden();
      // Today is the selected tab, which is what replaced auto-scrolling a
      // 950px table to today.
      await expect(page.locator('[data-testid^="timetable-agenda-day-"][aria-pressed="true"]')).toHaveCount(1);
    } else {
      await expect(gridCell).toBeVisible();
      await expect(agendaLesson).toBeHidden();
    }
  });
});

test.describe('attachment viewer', () => {
  test('is full-bleed below lg and a centred panel at lg', async ({ page }, testInfo) => {
    // Defect 8 had no automated coverage at all: `fixed inset-0` at every
    // width, and no safe-area padding on its bars. The sweep below cannot
    // reach it, because the walk deliberately skips `position:fixed` subtrees.
    await page.goto(`/inbox/${CONVERSATION_ID}`);
    await expect(page.getByTestId('conversation-page')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('attachment-item-file-1').click();
    const viewer = page.getByTestId('attachment-viewer');
    await expect(viewer).toBeVisible();

    const viewport = page.viewportSize()!;
    const box = (await viewer.boundingBox())!;

    if (testInfo.project.name === DESKTOP) {
      // Constrained and centred, not edge to edge: a 1280px desktop does not
      // need a photo of a permission slip filling the screen.
      expect(box.width).toBeLessThan(viewport.width);
      expect(box.height).toBeLessThan(viewport.height);
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
    } else {
      expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.height - viewport.height)).toBeLessThanOrEqual(2);
    }

    // The filename is an LTR island inside an RTL page, and it must not widen
    // the header whatever its length.
    const title = (await page.getByTestId('attachment-viewer-title').boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(-1);
    expect(title.x + title.width).toBeLessThanOrEqual(viewport.width + 1);
  });
});

test.describe('school-sent HTML', () => {
  test('keeps a 900px table and an oversized image inside the viewport', async ({ page }) => {
    // Defect 3. The table gets its OWN scroller rather than widening the
    // document, and the image is capped at 100%. The overflow sweep below
    // skips anything inside a horizontal scroller, so the table is asserted
    // here, by measuring the scroller itself.
    await page.goto(`/inbox/${CONVERSATION_ID}`);
    await expect(page.getByTestId('conversation-page')).toBeVisible({ timeout: 15_000 });

    const viewport = page.viewportSize()!;
    const table = page.locator('[data-testid="message-thread"] table').first();
    const image = page.locator('[data-testid="message-thread"] img').first();

    // Polled rather than read once. The body is injected via
    // dangerouslySetInnerHTML from a client-only DOMPurify pass, so the server
    // markup carries no table at all and the node is replaced at hydration --
    // a one-shot boundingBox() after toBeVisible() races that swap and comes
    // back null.
    await expect
      .poll(async () => (await table.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(viewport.width + 1);

    await expect
      .poll(async () => (await image.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(viewport.width + 1);
  });
});

test.describe('no horizontal overflow', () => {
  for (const route of ROUTES) {
    test(`on ${route.name}`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByTestId(route.readyTestId)).toBeVisible({ timeout: 15_000 });

      const offenders = await findHorizontalOverflow(page);
      expect(
        offenders,
        `${route.path} has ${offenders.length} element(s) outside the viewport:\n${formatOverflow(offenders)}`,
      ).toEqual([]);

      // The cheap backstop. It can only ever catch what `overflow-x: clip`
      // does not already hide, which is why the rect walk above is primary.
      expect(await documentScrollsHorizontally(page), `${route.path} scrolls sideways`).toBe(
        false,
      );
    });
  }
});
