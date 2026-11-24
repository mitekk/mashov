import type { NextConfig } from 'next';
import { version as packageVersion } from './package.json';

/**
 * Which build the parent is running, inlined into the bundle.
 *
 * Derived here rather than configured, so a stack needs no env var to report
 * something: `APP_VERSION` when it is set -- how CI or ops stamp a tag or a
 * git sha onto a deployment -- and this package's own version otherwise.
 * `||`, not `??`: the Dockerfile declares APP_VERSION as a build ARG, so it is
 * always PRESENT at build time and arrives as '' when nobody set it.
 *
 * Worth knowing: frontend/package.json's version has not moved since the file
 * was created, so the fallback alone cannot tell two builds apart. It is a
 * floor, not a release process.
 */
const appVersion = process.env.APP_VERSION?.trim() || packageVersion;

const nextConfig: NextConfig = {
  output: 'standalone',
  // Inlined at build time, for client and server components alike.
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  images: {
    // AVIF first, WebP fallback. Order matters: Next picks the first entry the
    // request's Accept header allows.
    formats: ['image/avif', 'image/webp'],
    // One year. There is no CDN in front of this app, so every cache miss is a
    // full re-encode on the app container's own CPU.
    minimumCacheTTL: 31536000,
  },
};

export default nextConfig;
