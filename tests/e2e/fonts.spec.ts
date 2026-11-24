import { test, expect, request as playwrightRequest } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SIGN_IN = '/auth/sign-in';
const FONT_DIR = path.join(__dirname, '..', '..', 'frontend', 'src', 'assets', 'fonts');

/** Byte size of each committed subset, read from the repo rather than hardcoded, so
 *  these assertions survive a font update without silently going vacuous. */
function subsetSizes(): Record<'hebrew' | 'latin' | 'latinExt', number> {
  const size = (f: string) => fs.statSync(path.join(FONT_DIR, f)).size;
  return {
    hebrew: size('assistant-hebrew.woff2'),
    latin: size('assistant-latin.woff2'),
    latinExt: size('assistant-latin-ext.woff2'),
  };
}

/**
 * Assistant is self-hosted from committed woff2 files (ADR-0043) so that
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
    baseURL,
  }) => {
    // A deliberately clean context. The `chromium` project's `use` block sets a
    // storageState, a custom userAgent and the `x-mashov-e2e-auth-bypass`
    // header, and the built-in `request` fixture inherits all three -- which
    // would mean this test never exercises the anonymous access that is the
    // whole reason the fonts live under /_next instead of /public (ADR-0043).
    const anon = await playwrightRequest.newContext({ baseURL });
    try {
      const response = await anon.get(SIGN_IN);
      expect(response.ok()).toBeTruthy();
      const html = await response.text();

      const preloads = html.match(/<link[^>]*as="font"[^>]*>/g) ?? [];
      expect(preloads, 'hebrew + latin, never latin-ext').toHaveLength(2);

      for (const link of preloads) {
        expect(link).toContain('rel="preload"');
        expect(link).toContain('/_next/static/media/');
        expect(link).toContain('crossorigin');
        // Never fonts.gstatic.com -- the point of ADR-0043 is that we serve these.
        expect(link).not.toContain('gstatic');
      }

      // Identify which subset each preloaded file actually is, by byte size
      // against the committed sources. A plain "<= 23 KB" bound would not
      // notice latin-ext (11 KB) being preloaded in place of latin.
      const sizes = subsetSizes();
      expect(
        new Set([sizes.hebrew, sizes.latin, sizes.latinExt]).size,
        'subset sizes must stay distinct for this check to identify files',
      ).toBe(3);

      const served: number[] = [];
      for (const link of preloads) {
        const href = /href="([^"]+)"/.exec(link)?.[1];
        expect(href).toBeTruthy();
        const font = await anon.get(href as string);
        // Must 200 for a signed-out visitor: middleware auth-gates /public,
        // which is why these are emitted under /_next/static/media instead.
        expect(font.status(), `${href} must 200 for a signed-out visitor`).toBe(200);
        served.push((await font.body()).length);
      }

      expect(served.sort((a, b) => a - b)).toEqual(
        [sizes.hebrew, sizes.latin].sort((a, b) => a - b),
      );
      expect(served, 'latin-ext must never be preloaded').not.toContain(sizes.latinExt);
    } finally {
      await anon.dispose();
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

    // Ranges are compared numerically because the CSSOM normalises
    // `unicode-range`: it strips leading zeros, reporting the authored
    // `U+0590-05FF` as `U+590-5FF`.
    const covers = (range: string, cp: number) =>
      range.split(',').some((part) => {
        const [lo, hi] = part.trim().replace(/^u\+/i, '').split('-');
        const low = Number.parseInt(lo, 16);
        return cp >= low && cp <= (hi ? Number.parseInt(hi, 16) : low);
      });

    const assistant = faces.filter((f) => f.family === 'Assistant');
    const shims = faces.filter((f) => f.family === 'Assistant Fallback');

    // All three subsets must be present, under the ONE shared family name. A
    // missing one means that call got tree-shaken; see failure mode 1 above.
    // Compared as a set of ranges because Next emits the font CSS into more
    // than one chunk, so document.fonts holds duplicate FontFace objects.
    for (const [label, cp] of [
      ['hebrew', 0x0590],
      ['latin', 0x0041],
      ['latin-ext', 0xa720],
    ] as const) {
      expect(
        assistant.some((f) => covers(f.unicodeRange, cp)),
        `the ${label} subset must be declared`,
      ).toBeTruthy();
    }

    // Exactly one distinct shim: more means an `adjustFontFallback: false` was
    // dropped. It is the only face without a unicode-range.
    expect(shims.length, 'the Arial shim must be declared').toBeGreaterThan(0);
    expect(new Set(shims.map((s) => s.unicodeRange))).toEqual(new Set(['U+0-10FFFF']));
    expect(
      assistant.every((f) => f.unicodeRange !== 'U+0-10FFFF'),
      'no real Assistant face may be unranged',
    ).toBeTruthy();
  });

  test('renders Hebrew and Latin in the real font, not the Arial shim', async ({ page }) => {
    await page.goto(SIGN_IN);
    await expect(page.getByTestId('sign-in-submit')).toBeVisible();

    // Ask for both faces explicitly. `document.fonts.ready` is not enough -- it
    // resolves even if the only thing that loaded was the shim. The latin face
    // does get activated by this page (its text contains U+0020 spaces, which
    // fall in latin's range), but relying on that is incidental; requesting it
    // by name keeps the measurement below deterministic.
    await page.evaluate(() =>
      Promise.all([
        document.fonts.load('400 16px Assistant', 'שלום'),
        document.fonts.load('400 16px Assistant', 'Hamburgefonstiv 0123456789'),
      ]),
    );
    await page.waitForFunction(() => {
      const covers = (range: string, cp: number) =>
        range.split(',').some((part) => {
          const [lo, hi] = part.trim().replace(/^u\+/i, '').split('-');
          const low = Number.parseInt(lo, 16);
          return cp >= low && cp <= (hi ? Number.parseInt(hi, 16) : low);
        });
      const loaded = [...document.fonts].filter(
        (f) => f.status === 'loaded' && f.family.replace(/^["']|["']$/g, '') === 'Assistant',
      );
      return (
        loaded.some((f) => covers(f.unicodeRange, 0x0590)) &&
        loaded.some((f) => covers(f.unicodeRange, 0x0041))
      );
    });

    // Measure the inherited stack against the two families it could resolve to.
    // If the shim ever outranks the real face, the stack's width matches Arial's
    // rather than Assistant's -- this is the assertion that settles it. The
    // sample is long on purpose: Assistant and size-adjusted Arial differ by
    // only ~1px over ten digits, which is too tight to trust.
    const LATIN = 'Hamburgefonstiv 0123456789 Hamburgefonstiv';
    const HEBREW = 'שלום עולם ברוכים הבאים למרכז הורים';
    const widths = await page.evaluate(
      ({ latin, hebrew }) => {
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
          latinStack: measure(stack, latin),
          latinReal: measure('Assistant', latin),
          latinShim: measure("'Assistant Fallback'", latin),
          hebrewStack: measure(stack, hebrew),
          hebrewReal: measure('Assistant', hebrew),
        };
      },
      { latin: LATIN, hebrew: HEBREW },
    );

    // The inherited stack must name a real family, not have collapsed to the
    // system font.
    expect(widths.stack).toContain('Assistant');
    expect(widths.latinReal).toBeGreaterThan(0);
    expect(widths.hebrewReal).toBeGreaterThan(0);

    // The sample must actually discriminate, or the next assertion is vacuous.
    expect(
      Math.abs(widths.latinReal - widths.latinShim),
      'Assistant and the Arial shim must measure differently',
    ).toBeGreaterThan(2);

    expect(widths.latinStack, 'Latin must render in Assistant').toBe(widths.latinReal);
    expect(widths.latinStack, 'Latin must not render in the Arial shim').not.toBe(
      widths.latinShim,
    );
    expect(widths.hebrewStack, 'Hebrew must render in Assistant').toBe(widths.hebrewReal);
  });
});
