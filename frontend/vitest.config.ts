import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Make a static image import look the way Next makes it look.
 *
 * `import illustration from '@/assets/images/x.png'` yields a
 * `StaticImageData` object (`{src, width, height}`) under the Next build, which
 * is how `<Image>` reserves the box before the bytes land. Vite resolves the
 * same import to a bare URL **string**, so `<Image>` throws
 * `Image with src "…" is missing required "width" property` — a failure of the
 * test runner, not of the component, and one that would otherwise make any
 * component with an illustration in it untestable.
 *
 * The dimensions are arbitrary on purpose: nothing asserts them, and what
 * `<Image>` needs is the SHAPE. A test that cared about real dimensions would
 * be testing the asset, not the component.
 */
function nextStaticImageStub(): Plugin {
  return {
    name: 'next-static-image-stub',
    enforce: 'pre',
    load(id) {
      const [path] = id.split('?');
      if (!/\.(png|jpe?g|gif|webp|avif)$/i.test(path ?? '')) return null;
      return `export default ${JSON.stringify({
        src: path,
        width: 1000,
        height: 750,
        blurDataURL: '',
        blurWidth: 0,
        blurHeight: 0,
      })};`;
    },
  };
}

/**
 * Component-level unit tests.
 *
 * The app is Next, not Vite, so this config exists only for the test runner:
 * `src/**` has no Vite build. Anything needing the Next request pipeline
 * belongs in `tests/e2e` against the Docker stack instead — this layer is for
 * pure render logic, which is where the source-health fold lives.
 */
export default defineConfig({
  plugins: [nextStaticImageStub(), react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
