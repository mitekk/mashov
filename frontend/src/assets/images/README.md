# Image assets

Source images that are rendered through `next/image`. Everything here is
imported from a component — nothing in this directory is served directly.

- **Static import over `/public`** for anything rendered through `next/image`.
  The import hands `<Image>` the file's intrinsic width and height (so the
  layout reserves the right box and nothing shifts) and is what makes
  `placeholder="blur"` possible at all — Next generates the blur data at build
  time from the imported module. A file in `/public` gives neither: the
  dimensions have to be typed in by hand and kept correct, and a blur
  placeholder needs `blurDataURL` supplied manually.
- **`/public` only** for files that need a stable, externally-referenceable
  URL: favicons, `manifest.json` icons, and Open Graph images. A static import
  gets a content-hashed filename, which is exactly wrong for a URL that a
  crawler, a manifest, or someone else's site holds a copy of.
- **Always set `sizes`** when the image is not fixed-width. Without it Next
  assumes the image spans the viewport (`100vw`) and the optimizer encodes for
  the largest device width in `deviceSizes` on every viewport — a phone
  downloads a desktop-sized file. `sizes` is a description of the rendered
  width, e.g. `sizes="(max-width: 768px) 100vw, 480px"`.
- **One `priority` per route.** Reserve it for that route's LCP element.
  `priority` preloads the image and takes it out of the lazy-loading queue;
  marking several images on one page means they compete for the same early
  bandwidth and none of them arrives sooner, which removes the benefit.
