import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Component-level unit tests.
 *
 * The app is Next, not Vite, so this config exists only for the test runner:
 * `src/**` has no Vite build. Anything needing the Next request pipeline
 * belongs in `tests/e2e` against the Docker stack instead — this layer is for
 * pure render logic, which is where the source-health fold lives.
 */
export default defineConfig({
  plugins: [react()],
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
