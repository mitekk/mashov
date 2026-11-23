import { test, expect } from '@playwright/test';
import {
  documentScrollsHorizontally,
  findHorizontalOverflow,
  formatOverflow,
} from './helpers/overflow';
import { ROUTES, STUDENT_GUID, installApiStubs } from './helpers/viewports';

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
