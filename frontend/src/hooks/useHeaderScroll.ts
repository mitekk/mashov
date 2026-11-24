'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** How far the page scrolls with the header still fully visible. */
export const STICKY_PX = 80;

/** How far it then takes for the header to fade and slide fully away. */
export const FADE_PX = 80;

/** The custom property the `.app-header` rule in globals.css reads. */
const PROGRESS_PROPERTY = '--app-header-p';

/**
 * Who last wrote the property.
 *
 * During an App Router transition the outgoing route's tree is still mounted
 * while the incoming one renders, so two headers exist at once. Without this,
 * the outgoing one's cleanup removes the property the incoming one has just
 * set, and the new page paints a fully opaque header over content that is
 * already scrolled past it.
 */
let owner: symbol | null = null;

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
 * The progress value does not live in state: a scroll-linked `setState` would
 * re-render the whole header subtree every frame, which includes
 * `RefreshButton` (a TanStack mutation) and the Radix dropdown, whose open
 * popover would be rebuilt mid-gesture. One rAF-throttled `passive` listener
 * writes `--app-header-p` on `<html>` instead, and the `.app-header` and
 * `.sticky-under-header` rules in globals.css read it.
 *
 * This is about not remounting Radix and TanStack subtrees mid-scroll, NOT
 * about raw style cost -- setting a custom property on `documentElement`
 * invalidates style document-wide, and `opacity`/`transform` derived from an
 * unregistered custom property are recomputed on the main thread each frame
 * rather than composited. Do not copy this as a general "CSS is cheaper"
 * pattern.
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
    const token = Symbol('app-header');
    owner = token;

    // The last element `apply` saw. `apply` itself reads `ref.current` live --
    // the focus check has to be against the node that is mounted right now --
    // but the cleanup must not, because by then the node is detached. This
    // tracks it instead.
    let attached: T | null = ref.current;

    const apply = (progress: number): void => {
      const element = ref.current ?? attached;
      attached = element;

      // Pinned open while focus is inside. Making an element inert while it
      // contains the focused node resets focus to `<body>` -- silently, per
      // spec -- so a keyboard user who tabs into the header and then scrolls
      // would lose their place with nothing to explain it.
      const holdsFocus =
        element !== null &&
        document.activeElement !== null &&
        document.activeElement !== document.body &&
        element.contains(document.activeElement);

      const next = holdsFocus ? 0 : progress;
      root.style.setProperty(PROGRESS_PROPERTY, String(next));

      if (element) {
        // Only on a real change: assigning a reflected boolean still calls
        // `setAttribute`, which invalidates style on the subtree -- once per
        // frame for as long as the parent keeps scrolling.
        const inert = next > 0.99;
        if (element.inert !== inert) element.inert = inert;
      }
    };

    let frame = 0;
    const update = (): void => {
      frame = 0;
      apply(headerProgress(window.scrollY));
    };

    const onScroll = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    // Focus crossing the header in EITHER direction has to re-apply, and
    // neither direction produces a scroll event.
    //
    // In: the page may already be deep in the fade when focus arrives -- Tab
    // from the URL bar at p = 0.87 lands on a control that is 13% opaque and
    // translated most of the way off-screen, and not yet `inert`. The browser
    // will not scroll it into view either: the header's layout box is still at
    // `top: 0`, and transforms are ignored for scroll-into-view.
    //
    // Out: the parent may have scrolled well past the fade while it was pinned
    // open, so the header has to catch up to where the page actually is.
    const onFocusChange = (): void => {
      apply(headerProgress(window.scrollY));
    };

    // `matchMedia` is absent under jsdom, so this is an optional call rather
    // than a guard the unit tests have to stub their way around.
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    let listening = false;
    const listen = (): void => {
      if (listening) return;
      window.addEventListener('scroll', onScroll, { passive: true });
      document.addEventListener('focusin', onFocusChange);
      document.addEventListener('focusout', onFocusChange);
      listening = true;
    };
    const stopListening = (): void => {
      if (!listening) return;
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('focusin', onFocusChange);
      document.removeEventListener('focusout', onFocusChange);
      listening = false;
    };

    // Re-read on every change, not once on mount: Reduce Motion is a setting a
    // parent can turn on from iOS Settings while the app is backgrounded, and
    // sampling it once leaves them with the behaviour they just turned off
    // until something remounts the header.
    const syncMotionPreference = (): void => {
      if (reducedMotion?.matches) {
        stopListening();
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        // Permanently sticky and visible, which is the whole request.
        apply(0);
        return;
      }
      listen();
      // Read the live offset rather than waiting for the next scroll: a
      // back-navigation restores it before this runs, and so does turning the
      // preference off halfway down a page.
      apply(headerProgress(window.scrollY));
    };

    syncMotionPreference();
    reducedMotion?.addEventListener?.('change', syncMotionPreference);

    return () => {
      stopListening();
      reducedMotion?.removeEventListener?.('change', syncMotionPreference);
      if (frame) window.cancelAnimationFrame(frame);

      if (attached) attached.inert = false;

      // Only if no newer header has taken over in the meantime.
      if (owner === token) {
        owner = null;
        root.style.removeProperty(PROGRESS_PROPERTY);
      }
    };
  }, []);

  return ref;
}
