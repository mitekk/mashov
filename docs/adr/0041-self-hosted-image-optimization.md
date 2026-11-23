# ADR-0041: Self-Hosted Image Optimization — AVIF-First, `sharp` Shipped Explicitly, Cache on a Volume

- **Date**: 2026-11-23
- **Status**: Accepted
- **Deciders**: User, Frontend agent
- **Related**: [ADR-0017](0017-caching-strategy-conditional-redis.md) — the project's other "cache only where it pays" decision

## Context and Problem Statement

A follow-up task puts a transparent-background PNG illustration on the sign-in page. On
that page it is almost certainly the LCP element: the form above it is a handful of text
inputs, so the largest thing the browser paints is the picture, and the sign-in page is
the first thing every parent sees.

This deployment has **no CDN**. The stack is `docker compose up` on one host; the browser
talks to the Next container directly. That single fact decides everything below, because
the thing a CDN normally provides — somebody else's CPU doing the encode, somebody else's
disk holding the result, close to the user — has to come from inside the app container or
not at all.

Next's own optimizer at `/_next/image` is therefore the only thing standing between a
source file and the browser. As found, that path was not merely unconfigured but
**non-functional**:

- `frontend/next.config.ts` had no `images` block at all. No AVIF (Next's default is
  WebP only), and the optimizer cache expired on Next's short default TTL — so a
  re-encode was never more than minutes away.
- `sharp` was **not a declared dependency**. It appeared in `frontend/package-lock.json`
  only as Next's own `optionalDependencies` entry, marked `"optional": true`. Next 15
  removed the WASM (squoosh) fallback, so there is no second encoder to fall back to, and
  Next does **not** trace `sharp` into `.next/standalone`. Nothing in
  `frontend/Dockerfile` installed or copied it into the runner stage. The first
  `<Image>` on the sign-in page would have 500'd in production while working perfectly on
  the developer's machine.
- The runner stage copies the standalone output as root and then switches to `USER app`.
  There was no `.next/cache` directory, and `app` cannot create one under a root-owned
  `/app/.next`. Even with `sharp` present, every cache write would have failed — turning
  the optimizer into a re-encoder on every single request.
- `next/core-web-vitals` sets `@next/next/no-img-element` to **warn**, which fails
  nothing. A raw `<img>` could land in a PR and nobody would be told.

## Decision Drivers

- Without a CDN, a cache miss is not a slow response — it is libvips burning the app
  container's own CPU, competing with request handling for the same parent who is waiting.
- The failure mode of a missing encoder is invisible locally and total in production.
  Anything that can be wrong only inside the container must be proven inside the
  container.
- The illustration is decoration. It must not be able to take the sign-in page down, and
  it must not cost a parent on a phone a desktop-sized download.
- Infrastructure first, asset second. Landing the plumbing on its own keeps the follow-up
  a pure `<Image>` addition and keeps this decision reviewable without a binary in the
  diff.

## Considered Options

1. **Configure the built-in optimizer properly** — AVIF-first, long TTL, `sharp` shipped
   deliberately, cache on a volume.
2. **Pre-encode at build time** — commit `.avif`/`.webp` variants beside the source and
   serve them from `/public` through `<picture>`. No runtime encode at all.
3. **Put a CDN or an image service in front** — Cloudflare Images, imgix, a Vercel deploy.
4. **Leave it alone and use plain `<img>`** — ship the PNG as-is.

## Decision Outcome

**Option 1**, with three parts that are each a direct consequence of having no CDN.

### AVIF first, WebP fallback, one-year `minimumCacheTTL`

```ts
images: {
  formats: ['image/avif', 'image/webp'],
  minimumCacheTTL: 31536000,
}
```

Order is significant: Next serves the first entry the request's `Accept` header allows.
AVIF is both the smaller file — measured on the verification probe, a 1200×800
semi-transparent PNG of 20894 bytes came back as **718 bytes of AVIF** and **630 bytes of
WebP** at `w=640&q=75` — and the slower encode. That trade is exactly the right way round
here: the encode happens once, the download happens on every cold visit, and transparency
survives in both formats.

The one-year TTL is where the absence of a CDN shows most plainly. `minimumCacheTTL` is
how long the optimizer keeps its *own* encoded copy, and every expiry is a full re-encode
on this host. There is no edge cache absorbing the miss, and the input is a build-time
asset that cannot change without a new image URL, so a short TTL buys nothing and costs
CPU. The TTL is visible in the cache filenames (`31536000.<expiry>.<etag>….avif`), which
is how it was verified rather than assumed.

No `remotePatterns`. The first asset is a local static import; widening the optimizer to
remote hosts turns it into an open image proxy and is out of scope.

### `sharp` as a real dependency, copied into the runner stage

`sharp` moves into `dependencies` in `frontend/package.json` (`^0.35.5`, the 0.35.x line
Next 15.5 already resolves), and the Dockerfile copies it into the runner:

```dockerfile
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
```

Copied **from the builder**, not installed fresh, because both stages are
`node:22-alpine`: the musl/arch-specific binary in `@img/sharp-linuxmusl-*` is by
construction the right one for the runner. Relying on Next's optional dependency was the
original bug — an optional dependency is one npm is permitted to silently skip, which is
not a thing to hang the LCP element of the sign-in page on.

The lockfile was checked for the musl variants (`@img/sharp-linuxmusl-arm64`,
`@img/sharp-linuxmusl-x64`) so `npm ci` inside the alpine builder resolves a prebuilt
binary instead of trying to compile libvips.

### A named volume for the optimizer cache

```dockerfile
RUN mkdir -p .next/cache/images && chown -R app:app .next/cache
```

```yaml
volumes:
  - frontend_image_cache:/app/.next/cache/images
```

The `chown` covers all of `.next/cache`, not just `images` — Next writes its fetch cache
there too. A fresh named volume inherits the mountpoint's ownership, so the `chown` and the
volume are one decision, not two: without the `chown` the volume would come up root-owned
and the write would fail the same way it did without the volume.

The volume is what makes the one-year TTL mean anything. A container-local cache dies with
the container, so a redeploy — the most ordinary event there is — would re-encode every
variant on the first visit after it. With no CDN, that first visitor pays for it.

### Lint, not advice

`@next/next/no-img-element` is raised from `warn` to `error` in
`frontend/.eslintrc.json`. The optimizer above is worth exactly as much as the discipline
of going through it, and a warning is not discipline.

### Why not the others

**Option 2 (pre-encode at build time)** is genuinely attractive: zero runtime CPU, no
`sharp` in production, no cache to manage. It was rejected because it gives up responsive
variants — one committed width for every viewport, so a phone downloads the desktop file,
which is most of what the optimizer is for — and because every future image becomes a
manual encode-and-commit step plus hand-written `<picture>` markup. It also puts binaries
in `/public`, which (see below) is the auth-gated path.

**Option 3 (a CDN or image service)** solves the encode problem by moving it off the host,
and is the right answer the day this project has a CDN. Today it would be the first
third-party in the serving path, the first external dependency for a page that must work
when everything else is down, and — for a service like imgix — the first egress of
application assets to a vendor. Disproportionate for one illustration.

**Option 4 (plain `<img>`)** ships a full-size PNG to every device as the LCP element.
The task exists because that is the thing to avoid.

## Verification

Done against the **production** image (`docker compose -f docker-compose.yml`, not the dev
override, which builds `target: builder` and bind-mounts `public`), with a throwaway
1200×800 PNG that was never committed and was deleted from the container afterwards:

- `sharp` resolves inside the runner: `sharp 0.35.5 libvips 8.18.7 simd true`.
- AVIF: `content-type: image/avif`, `x-nextjs-cache: MISS` then `HIT`.
- WebP (AVIF withheld from `Accept`): `content-type: image/webp`.
- `.next/cache/images` holds both variants, owned `app:app`, with `31536000` in the
  filename.
- After `docker compose restart frontend` the entries are still there and the AVIF request
  answers `HIT` — the volume, not the container, is holding them.
- No `sharp`-resolution and no `Failed to write image to cache` line in the container log.

## Consequences

**Good**
- The first `<Image>` added to this app works in production, which it demonstrably would
  not have before this change.
- AVIF at the requested width, encoded once per `w`/`q` pair and then held across
  restarts and redeploys.
- A raw `<img>` now fails lint locally instead of being mentioned in passing.
- The three failures this found (undeclared `sharp`, unwritable cache, warn-level lint)
  were each invisible from the repo and each fatal or near-fatal at runtime. They are now
  closed before the asset that would have hit them exists.

**Bad / accepted**
- **The encode cost is this host's.** Every distinct `w`/`q` combination is one libvips
  run on the app container's CPU, in front of a parent who is waiting. The one-year TTL
  and the volume make it once per variant per deploy-with-a-new-asset, which is the best
  this shape allows, but it is still the app's own CPU and there is no ceiling on
  concurrent encodes.
- **The cache volume grows without bound.** One entry per `w`/`q` pair per source image,
  pruned by nothing. Small for a handful of illustrations; worth a look if image use ever
  becomes substantial. Deleting the volume is always safe — it rebuilds on demand, at the
  CPU cost above.
- **The dev container does not exercise the runner-stage fix.** The override builds
  `target: builder` and runs as root, so the `chown` and the `sharp` copy are both
  unnecessary there and both untested by local development. This path is only ever proven
  by running the production compose file, as the verification above did.
- **Frontend ESLint is not wired into CI.** `.github/workflows/ci.yml` runs
  `npx tsc --noEmit` and `npm test` for the frontend but never `npm run lint`, so the
  `no-img-element` error gate stops a developer and not a pull request. Out of scope here;
  adding a frontend lint step is the obvious follow-up.
- **`/public` images are behind the auth middleware.** `frontend/src/middleware.ts`
  excludes only `_next/static`, `_next/image`, `favicon.ico` and `manifest.json`, so an
  unauthenticated request for a file in `/public` is 307'd to `/auth/sign-in` — observed
  during verification, where the optimizer answered `400 "The requested resource isn't a
  valid image"` because its own fetch was redirected. A static import is served from
  `/_next/static/media/`, which is excluded, so the documented convention
  (`frontend/src/assets/images/README.md`) avoids this by construction. Anything that
  genuinely must live in `/public` and be reachable while signed out needs the matcher
  widened.
