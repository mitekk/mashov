import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolved from the vitest root (frontend/), not `import.meta.url`: under the
// jsdom environment that is not a file: URL.
const css = readFileSync(resolve('src/app/globals.css'), 'utf8');
const tailwindConfig = readFileSync(resolve('tailwind.config.ts'), 'utf8');

/** Class names globals.css defines by hand, e.g. `.pb-nav` -> `pb-nav`. */
function handWrittenUtilities(): string[] {
  return [...css.matchAll(/^\s*\.([a-z0-9-]+)\s*\{/gm)].map((m) => m[1]);
}

/** Keys of the `spacing: { … }` block in tailwind.config.ts. */
function spacingTokens(): string[] {
  const block = /spacing:\s*\{([\s\S]*?)\n\s{6}\},/.exec(tailwindConfig);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*'?([A-Za-z0-9-]+)'?:/gm)].map((m) => m[1]);
}

describe('globals.css and tailwind.config.ts', () => {
  it('names no spacing token that collides with a hand-written utility', () => {
    // A `spacing: { nav: '4rem' }` token makes Tailwind emit `.pb-nav
    // { padding-bottom: 4rem }` -- a SECOND rule for the hand-written
    // `.pb-nav`, which carries the safe-area inset a plain token cannot
    // express. Which one wins is then emission order, not intent.
    const hand = handWrittenUtilities();
    const collisions = spacingTokens().filter((token) =>
      hand.some((cls) => cls.endsWith(`-${token}`)),
    );

    expect(collisions).toEqual([]);
  });

  it('still defines the rail width the shell offset depends on', () => {
    expect(spacingTokens()).toContain('rail');
  });

  it('guards horizontal overflow with clip, and reaches for hidden only as a fallback', () => {
    // `overflow: hidden` on html/body makes them a scroll container, which
    // breaks every `position: sticky` descendant -- and the child workspace's
    // tab rail is `sticky top-2`. `clip` creates none, so `hidden` is allowed
    // only behind `@supports not (overflow: clip)`.
    expect(css).toMatch(/html,\s*\n?\s*body\s*\{[^}]*overflow-x:\s*clip/);

    const withoutFallback = css.replace(
      /@supports not \(overflow: clip\) \{[\s\S]*?\n  \}/,
      '',
    );
    expect(css).toContain('@supports not (overflow: clip)');
    expect(withoutFallback).not.toContain('overflow-x: hidden');
  });

  it('counts the notch into the header height every sticky element offsets from', () => {
    // `.sticky-under-header` offsets by `--app-header-h`, but the header is
    // `h-14` PLUS `pt-safe`. With the inset left out, the child workspace's
    // tab rail -- `sticky` at every width, not only at `lg` -- parks ~47px
    // behind a translucent header on a notched iPhone: half-covered, and the
    // top of it unclickable. Chromium resolves `env()` to 0, so no Playwright
    // project can catch this.
    const root = /:root\s*\{([\s\S]*?)\n  \}/.exec(css);
    expect(root).not.toBeNull();
    expect(root![1]).toMatch(/--app-header-h:\s*calc\(3\.5rem \+ env\(safe-area-inset-top\)\)/);
  });

  it('drops the notch back out of that height at lg, where nothing overlays the status bar', () => {
    // `pt-safe` is cancelled by `lg:pt-0` on the header, so the token has to
    // follow it or every `lg:sticky` element gains a phantom inset.
    const lgOverride = /@media \(min-width: 1024px\) \{\s*:root\s*\{([^}]*)\}/.exec(css);
    expect(lgOverride).not.toBeNull();
    expect(lgOverride![1]).toMatch(/--app-header-h:\s*3\.5rem/);
  });

  it('keeps touch-action off body, where it would re-block pinch-zoom', () => {
    const bodyRules = [...css.matchAll(/\n\s*body\s*\{([^}]*)\}/g)].map((m) => m[1]);
    for (const rule of bodyRules) {
      expect(rule).not.toContain('touch-action');
    }
  });

  it('defines the narrowing primitives after the ones they narrow', () => {
    // `.page-shell measure` and `.page-shell page-shell-wide` are both pairs of
    // @layer components classes setting max-width. Between two rules in one
    // layer the later one wins regardless of specificity, so this order IS the
    // behaviour: flip it and every `.measure` page silently widens to 64rem.
    const order = (cls: string) => css.indexOf(`.${cls} {`);

    expect(order('page-shell')).toBeGreaterThan(-1);
    expect(order('measure')).toBeGreaterThan(order('page-shell'));
    expect(order('page-shell-wide')).toBeGreaterThan(order('page-shell'));
  });

  it('defines the one scrollbar-hiding utility that files already reference', () => {
    expect(css).toContain('.scrollbar-hide');
    expect(css).toMatch(/\.scrollbar-hide::-webkit-scrollbar\s*\{\s*display:\s*none/);
  });
});
