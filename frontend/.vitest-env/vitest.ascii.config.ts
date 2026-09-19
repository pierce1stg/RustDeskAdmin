import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')

export default defineConfig({
  root: '/tmp/rda-test-src',
  cacheDir: path.join(here, '.vite-cache'),
  resolve: {
    alias: { '@': '/tmp/rda-test-src/src' },
    preserveSymlinks: false,
  },
  // NOTE: on this machine the checkout lives under a Cyrillic path that the
  // installed Vite cannot load modules from — run-tests.sh syncs src/ to
  // /tmp/rda-test-src and overrides root + alias from the CLI (see script).
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/lib/rustdesk/**/*.ts'],
      exclude: ['**/*.test.ts', '**/vendor/**'],
    },
  },
})
