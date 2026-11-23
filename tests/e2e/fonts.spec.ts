import { test, expect } from '@playwright/test';

const SIGN_IN = '/auth/sign-in';

/**
 * Assistant is self-hosted from committed woff2 files (ADR-0042) so that
 * `next build` makes no network request. Nothing else in the suite asserts on
 * fonts, preloads or head contents, which left three failure modes unguarded --
 * all three silent, all three leaving a page that still renders:
 *
 *  1. A subset vanishing. The next/font webpack rule is `sideEffects: false`, so
 *     a localFont() call whose object stops being referenced is tree-shaken out
 *     of the production bundle while still working in dev.
 *  2. The preload set regressing. #32 corrected it from `latin` alone -- which
 *     renders almost nothing in a `lang="he" dir="rtl"` app -- to hebrew+latin.
 *  3. The `Assistant Fallback` shim winning. That face is `src: local("Arial")`
 *     with no unicode-range, so it matches every glyph; if it ever outranks a
 *     real face, text renders in size-adjusted Arial with no error anywhere.
 */
test.describe('Assistant font delivery', () => {
  test('preloads exactly the hebrew and latin subsets, fetchable anonymously', async ({
    request,
  }) => {
    const response = await request.get(SIGN_IN);
    expect(response.ok()).toBeTruthy();
    const html = await response.text();

    const preloads = html.match(/<link[^>]*as="font"[^>]*>/g) ?? [];
    expect(preloads, 'hebrew + latin, never latin-ext').toHaveLength(2);

    for (const link of preloads) {
      expect(link).toContain('rel="preload"');
      expect(link).toContain('/_next/static/media/');
      expect(link).toContain('crossorigin');
      // Never fonts.gstatic.com -- the point of ADR-0042 is that we serve these.
      expect(link).not.toContain('gstatic');
    }

    // An empty preload array makes Next emit a <link rel="preconnect"> to
    // /_next instead, which is the tell that preloading collapsed entirely.
    expect(html).not.toMatch(/<link[^>]*rel="preconnect"[^>]*\/_next/);

    // Each preloaded file must really be reachable by a signed-out visitor --
    // middleware auth-gates /public, which is why these live under /_next.
    for (const link of preloads) {
      const href = /href="([^"]+)"/.exec(link)?.[1];
      expect(href).toBeTruthy();
      const font = await request.get(href as string);
      expect(font.status(), `${href} must 200 for a signed-out visitor`).toBe(200);
      // The two preloaded files are hebrew (~7.3 KB) and latin (~22 KB); the
      // ~11 KB latin-ext must never be among them.
      const bytes = (await font.body()).length;
      expect(bytes, `${href} is the wrong subset`).not.toBeGreaterThan(23_000);
    }
  });

  test('declares all three subsets plus exactly one fallback shim', async ({ page }) => {
    await page.goto(SIGN_IN);
    await expect(page.getByTestId('sign-in-submit')).toBeVisible();

    const faces = await page.evaluate(() =>
      [...document.fonts].map((face) => ({
        family: face.family.replace(/^["']|["']$/g, ''),
        unicodeRange: face.unicodeRange,
      })),
    );

    const assistant = faces.filter((f) => f.family === 'Assistant');
    const shims = faces.filter((f) => f.family === 'Assistant Fallback');

    // Three real subsets, all under the ONE shared family name. A count of 2
    // means a call got tree-shaken; see failure mode 1 above.
    expect(assistant, 'hebrew, latin and latin-ext must all be declared').toHaveLength(3);
    // Exactly one shim: more means an `adjustFontFallback: false` was dropped.
    expect(shims).toHaveLength(1);

    // Every real face is range-limited; the shim is the only unranged face.
    const covers = (range: string, cp: number) =>
      range.split(',').some((part) => {
        const [lo, hi] = part.trim().replace(/^u\+/i, '').split('-');
        const low = Number.parseInt(lo, 16);
        return cp >= low && cp <= (hi ? Number.parseInt(hi, 16) : low);
      });

    expect(assistant.some((f) => covers(f.unicodeRange, 0x0590)), 'hebrew').toBeTruthy();
    expect(assistant.some((f) => covers(f.unicodeRange, 0x0041)), 'latin').toBeTruthy();
    expect(assistant.some((f) => covers(f.unicodeRange, 0xa720)), 'latin-ext').toBeTruthy();
    expect(shims[0].unicodeRange).toBe('U+0-10FFFF');
  });

  test('renders Hebrew and Latin in the real font, not the Arial shim', async ({ page }) => {
    await page.goto(SIGN_IN);
    await expect(page.getByTestId('sign-in-submit')).toBeVisible();

    // Ask for the Hebrew face explicitly and wait for it. `document.fonts.ready`
    // is not enough -- it resolves even if the only thing that loaded was the
    // shim. Ranges are compared numerically because the CSSOM normalises
    // `unicode-range` (it strips leading zeros, reporting `U+590-5FF`), so a
    // literal string match against the authored value does not hold.
    await page.evaluate(() => document.fonts.load('400 16px Assistant', 'שלום'));
    await page.waitForFunction(() => {
      const covers = (range: string, cp: number) =>
        range.split(',').some((part) => {
          const [lo, hi] = part.trim().replace(/^u\+/i, '').split('-');
          const low = Number.parseInt(lo, 16);
          return cp >= low && cp <= (hi ? Number.parseInt(hi, 16) : low);
        });
      return [...document.fonts].some(
        (f) =>
          f.status === 'loaded' &&
          f.family.replace(/^["']|["']$/g, '') === 'Assistant' &&
          covers(f.unicodeRange, 0x0590),
      );
    });

    // Measure the inherited stack against the two families it could resolve to.
    // If the shim ever outranks the real face, the stack's width matches Arial's
    // rather than Assistant's -- this is the assertion that settles it.
    const widths = await page.evaluate(() => {
      const measure = (fontFamily: string, text: string) => {
        const span = document.createElement('span');
        span.style.cssText =
          'position:absolute;visibility:hidden;white-space:pre;font:400 16px ' + fontFamily;
        span.textContent = text;
        document.body.appendChild(span);
        const width = span.offsetWidth;
        span.remove();
        return width;
      };
      // <body>, not documentElement: the font classes are applied there.
      const stack = getComputedStyle(document.body).fontFamily;
      return {
        stack,
        latinStack: measure(stack, '0123456789'),
        latinReal: measure('Assistant', '0123456789'),
        latinShim: measure("'Assistant Fallback'", '0123456789'),
        hebrewStack: measure(stack, 'שלום עולם'),
        hebrewReal: measure('Assistant', 'שלום עולם'),
      };
    });

    // The inherited stack must name a real family, not have collapsed to the
    // system font.
    expect(widths.stack).toContain('Assistant');
    expect(widths.latinReal).toBeGreaterThan(0);

    expect(widths.latinStack, 'Latin must render in Assistant').toBe(widths.latinReal);
    expect(widths.latinStack, 'Latin must not render in the Arial shim').not.toBe(
      widths.latinShim,
    );
    expect(widths.hebrewStack, 'Hebrew must render in Assistant').toBe(widths.hebrewReal);
  });
});
