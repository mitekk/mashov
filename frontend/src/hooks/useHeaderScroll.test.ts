import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FADE_PX, STICKY_PX, headerProgress, useHeaderScroll } from './useHeaderScroll';

/**
 * `inert` is not implemented in jsdom -- assigning it sets a property nothing
 * reflects to an attribute -- so these tests assert the custom property, which
 * is what the CSS in globals.css actually reads. The `inert` half of the
 * contract is covered by tests/e2e/header.spec.ts in a real engine.
 */
function progress(): string {
  return document.documentElement.style.getPropertyValue('--app-header-p');
}

/**
 * Let the pin's post-popover settle window expire. The hook re-checks on its
 * own rAF while focus is in flight, so the frames have to be run out before a
 * collapse can be asserted.
 */
function flushFrames(): void {
  act(() => {
    vi.advanceTimersByTime(100);
  });
}

function scrollTo(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
    // The listener is rAF-throttled; vitest's fake timers fake rAF too.
    vi.advanceTimersByTime(32);
  });
}

describe('headerProgress', () => {
  it('holds the header fully visible for the first sticky stretch', () => {
    expect(headerProgress(0)).toBe(0);
    expect(headerProgress(STICKY_PX / 2)).toBe(0);
    expect(headerProgress(STICKY_PX)).toBe(0);
  });

  it('ramps linearly across the fade distance', () => {
    expect(headerProgress(STICKY_PX + FADE_PX / 2)).toBeCloseTo(0.5, 5);
    expect(headerProgress(STICKY_PX + FADE_PX)).toBe(1);
  });

  it('clamps at both ends', () => {
    // Over-scroll (negative scrollY on iOS rubber-band) must not invert it.
    expect(headerProgress(-200)).toBe(0);
    expect(headerProgress(300)).toBe(1);
  });
});

describe('useHeaderScroll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.style.removeProperty('--app-header-p');
    // @ts-expect-error -- the stub is only installed by the reduced-motion test.
    delete window.matchMedia;
  });

  it('starts at zero so the header is visible on a fresh page', () => {
    renderHook(() => useHeaderScroll<HTMLElement>());

    expect(progress()).toBe('0');
  });

  it('writes the fade curve to the document as the page scrolls', () => {
    renderHook(() => useHeaderScroll<HTMLElement>());

    scrollTo(0);
    expect(progress()).toBe('0');

    scrollTo(80);
    expect(progress()).toBe('0');

    scrollTo(120);
    expect(Number(progress())).toBeCloseTo(0.5, 5);

    scrollTo(160);
    expect(progress()).toBe('1');

    scrollTo(300);
    expect(progress()).toBe('1');
  });

  it('fades back in on the way up', () => {
    renderHook(() => useHeaderScroll<HTMLElement>());

    scrollTo(300);
    expect(progress()).toBe('1');

    scrollTo(100);
    expect(Number(progress())).toBeCloseTo(0.25, 5);

    scrollTo(0);
    expect(progress()).toBe('0');
  });

  it('picks up the scroll position it mounts at, not only later scrolls', () => {
    // A back-navigation restores scroll before the header mounts; reading
    // `scrollY` only in the listener would leave a visible header over content
    // that is already scrolled past it.
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true, writable: true });

    renderHook(() => useHeaderScroll<HTMLElement>());

    expect(progress()).toBe('1');
  });

  it('coalesces a burst of scroll events into one frame', () => {
    renderHook(() => useHeaderScroll<HTMLElement>());
    const raf = vi.spyOn(window, 'requestAnimationFrame');

    Object.defineProperty(window, 'scrollY', { value: 200, configurable: true, writable: true });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));
    });

    expect(raf).toHaveBeenCalledTimes(1);
    raf.mockRestore();
  });

  it('leaves the header permanently visible under prefers-reduced-motion', () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(window, 'matchMedia', {
      value: matchMedia,
      configurable: true,
      writable: true,
    });

    renderHook(() => useHeaderScroll<HTMLElement>());

    scrollTo(400);

    expect(progress()).toBe('0');
  });

  /**
   * Going inert while the header holds focus resets `document.activeElement`
   * to `<body>` -- per spec, and silently. A keyboard user who tabs to the
   * theme toggle and then scrolls on loses their place entirely: the next Tab
   * restarts at the top of the document, with no announcement and nothing on
   * screen to explain it. So the fade is pinned open while focus is inside.
   */
  it('stays open while the header holds keyboard focus', () => {
    const header = document.createElement('header');
    const button = document.createElement('button');
    header.appendChild(button);
    document.body.appendChild(header);

    const { result } = renderHook(() => useHeaderScroll<HTMLElement>());
    result.current.current = header;
    button.focus();

    scrollTo(400);

    expect(progress()).toBe('0');
    expect(document.activeElement).toBe(button);

    header.remove();
  });

  /**
   * The other ordering, and the one a `focusout` listener alone misses: the
   * page is ALREADY scrolled into the fade when focus arrives. Tab in from the
   * URL bar at p = 0.87 and the header is 13% opaque and translated 87% up,
   * but not yet `inert` (that needs p > 0.99) -- so focus lands on a control
   * that is all but invisible and mostly off-screen. The browser will not
   * rescue it: the header's layout box is still at `top: 0` and transforms are
   * ignored for scroll-into-view, so no scroll event is generated either.
   */
  it('pins open when focus arrives while it is already faded', () => {
    const header = document.createElement('header');
    const button = document.createElement('button');
    header.appendChild(button);
    document.body.appendChild(header);

    const { result } = renderHook(() => useHeaderScroll<HTMLElement>());
    result.current.current = header;

    // Scroll FIRST, focus second.
    scrollTo(150);
    expect(Number(progress())).toBeGreaterThan(0.8);

    act(() => {
      button.focus();
    });

    expect(progress()).toBe('0');

    header.remove();
  });

  it('resumes fading once focus leaves the header', () => {
    const header = document.createElement('header');
    const button = document.createElement('button');
    header.appendChild(button);
    document.body.appendChild(header);

    const { result } = renderHook(() => useHeaderScroll<HTMLElement>());
    result.current.current = header;
    button.focus();
    scrollTo(400);
    expect(progress()).toBe('0');

    act(() => {
      button.blur();
    });
    scrollTo(400);

    expect(progress()).toBe('1');

    header.remove();
  });

  /**
   * The profile menu's content is portaled to `<body>`, so while it is open
   * the focused node is NOT inside the header and `focusout` has already
   * re-applied the real progress. Without the popover clause the header fades
   * out and goes inert under its own open menu: the popover is left floating
   * with no visible trigger, and Escape restores focus to an inert node, which
   * means `<body>`.
   */
  it('stays open while its own portaled menu is open', () => {
    const header = document.createElement('header');
    const trigger = document.createElement('button');
    trigger.dataset.state = 'open';
    header.appendChild(trigger);
    document.body.appendChild(header);

    // Where Radix actually puts the content: a sibling of the header, not a
    // descendant of it.
    const content = document.createElement('div');
    const item = document.createElement('button');
    content.appendChild(item);
    document.body.appendChild(content);

    const { result } = renderHook(() => useHeaderScroll<HTMLElement>());
    result.current.current = header;

    act(() => {
      item.focus();
    });
    scrollTo(400);

    expect(header.contains(document.activeElement)).toBe(false);
    expect(progress()).toBe('0');
    expect(header.inert).toBe(false);

    header.remove();
    content.remove();
  });

  it('resumes fading once that menu closes', () => {
    const header = document.createElement('header');
    const trigger = document.createElement('button');
    trigger.dataset.state = 'open';
    header.appendChild(trigger);
    document.body.appendChild(header);

    const { result } = renderHook(() => useHeaderScroll<HTMLElement>());
    result.current.current = header;

    scrollTo(400);
    expect(progress()).toBe('0');

    trigger.dataset.state = 'closed';
    scrollTo(400);
    // Not immediately: the pin outlives the popover by a few frames so Radix's
    // focus restore has a live trigger to land on.
    expect(progress()).toBe('0');

    flushFrames();

    expect(progress()).toBe('1');

    header.remove();
  });

  /**
   * The point of the settle window: Radix unmounts the content first and only
   * then calls `focus()` on the trigger, so there is a gap where nothing holds
   * focus. Collapse during the gap and the restore lands on an inert node,
   * which the spec resolves by putting focus on `<body>` and saying nothing.
   */
  it('keeps the trigger focusable for the restore that follows a close', () => {
    const header = document.createElement('header');
    const trigger = document.createElement('button');
    trigger.dataset.state = 'open';
    header.appendChild(trigger);
    document.body.appendChild(header);

    const { result } = renderHook(() => useHeaderScroll<HTMLElement>());
    result.current.current = header;

    scrollTo(400);
    expect(progress()).toBe('0');

    // Close, then restore a frame later, as Radix does.
    trigger.dataset.state = 'closed';
    scrollTo(400);
    act(() => {
      trigger.focus();
    });
    flushFrames();

    expect(document.activeElement).toBe(trigger);
    expect(progress()).toBe('0');

    header.remove();
  });

  /**
   * Two headers are briefly mounted at once during an App Router transition.
   * An unconditional `removeProperty` in the outgoing one's cleanup wipes the
   * incoming one's value back to 0 -- a fully opaque header over content that
   * is already scrolled past it.
   */
  it('does not let an unmounting header clear a newer one value', () => {
    const first = renderHook(() => useHeaderScroll<HTMLElement>());
    scrollTo(400);
    expect(progress()).toBe('1');

    // A second header mounts and takes ownership...
    renderHook(() => useHeaderScroll<HTMLElement>());
    // ...then the first unmounts, as the outgoing route tears down.
    first.unmount();

    expect(progress()).toBe('1');
  });

  /**
   * Reduce Motion is a setting, not a constant. A parent who turns it on from
   * iOS Settings while the app is backgrounded would otherwise keep the fade
   * until something remounts the header -- and one who turns it off would be
   * left with a permanently pinned header.
   */
  it('follows prefers-reduced-motion when it changes under it', () => {
    const listeners: Array<() => void> = [];
    const query = {
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'matchMedia', {
      value: () => query,
      configurable: true,
      writable: true,
    });

    renderHook(() => useHeaderScroll<HTMLElement>());

    scrollTo(300);
    expect(progress()).toBe('1');

    // The parent turns Reduce Motion ON.
    query.matches = true;
    act(() => {
      listeners.forEach((listener) => listener());
    });
    expect(progress()).toBe('0');

    // ...and scrolling no longer moves it.
    scrollTo(400);
    expect(progress()).toBe('0');

    // Turned back OFF, the fade resumes without a remount.
    query.matches = false;
    act(() => {
      listeners.forEach((listener) => listener());
    });
    expect(progress()).toBe('1');
  });

  it('cleans the custom property up when the header unmounts', () => {
    const { unmount } = renderHook(() => useHeaderScroll<HTMLElement>());
    scrollTo(300);

    unmount();

    expect(progress()).toBe('');
  });
});
