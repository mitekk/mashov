import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
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
