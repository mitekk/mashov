'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** How far the page scrolls with the header still fully visible. */
export const STICKY_PX = 80;

/** How far it then takes for the header to fade and slide fully away. */
export const FADE_PX = 80;

/** The custom property the `.app-header` rule in globals.css reads. */
const PROGRESS_PROPERTY = '--app-header-p';

/**
 * 0 while the header is fully visible, 1 once it is fully gone.
 *
 * Clamped at both ends: iOS rubber-band gives a negative `scrollY`, which
 * un-clamped would translate the header *down* over the content.
 */
export function headerProgress(scrollY: number): number {
  const progress = (scrollY - STICKY_PX) / FADE_PX;
  if (!(progress > 0)) return 0;
  if (progress > 1) return 1;
  return progress;
}

/**
 * Drive the app header's scroll fade without re-rendering React.
 *
 * The progress value deliberately does NOT live in state. A scroll-linked
 * `setState` would re-render the whole header subtree on every frame -- which
 * includes `RefreshButton` (a TanStack mutation) and the Radix dropdown, whose
 * open popover would be rebuilt mid-gesture. Instead one rAF-throttled
 * `passive` listener writes `--app-header-p` on `<html>` and CSS does the
 * animating; see the `.app-header` and `.sticky-under-header` rules in
 * globals.css.
 *
 * Returns a ref for the header element: at the end of the fade the element is
 * marked `inert`, which removes it from hit testing AND from the tab order in
 * one attribute -- cleaner than pairing `aria-hidden` with
 * `pointer-events: none`, which leaves it focusable.
 *
 * Under `prefers-reduced-motion: reduce` the listener is never attached and
 * the property stays at 0: the header is simply sticky and always visible.
 */
export function useHeaderScroll<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    // Captured once: React has populated the ref before effects run, and
    // reading `ref.current` in the cleanup would be reading it after the node
    // is gone.
    const element = ref.current;

    const apply = (progress: number): void => {
      root.style.setProperty(PROGRESS_PROPERTY, String(progress));
      if (element) element.inert = progress > 0.99;
    };

    // `matchMedia` is absent under jsdom, so this is an optional call rather
    // than a guard the unit tests have to stub their way around.
    const prefersReducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    )?.matches;

    if (prefersReducedMotion) {
      apply(0);
      return () => {
        root.style.removeProperty(PROGRESS_PROPERTY);
      };
    }

    // Read on mount, not only on the first scroll: a back-navigation restores
    // the scroll offset before this runs.
    apply(headerProgress(window.scrollY));

    let frame = 0;
    const onScroll = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply(headerProgress(window.scrollY));
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      root.style.removeProperty(PROGRESS_PROPERTY);
      if (element) element.inert = false;
    };
  }, []);

  return ref;
}
