/**
 * Vitest config for @hy-sde-org/dsh-av tests.
 *
 * Alias the workspace packages to their TS sources so every suite executes
 * ONE copy of each module (a built-dist copy plus a src copy would be two
 * different singletons). This mirrors the harness fork's
 * `vite-tsconfig-paths` setup and keeps `pnpm -r test` green on a fresh
 * checkout before `pnpm -r build` has produced `dist/`.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const avSrc = fileURLToPath(new URL('./src', import.meta.url))
const toolAvSrc = fileURLToPath(new URL('../tool-av/src/index.ts', import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: [
      // Subpath exports first (`/types`, `/service`), then the root.
      { find: /^@hy-sde-org\/dsh-av\/(.+)$/, replacement: `${avSrc}/$1.ts` },
      { find: '@hy-sde-org/dsh-av', replacement: `${avSrc}/index.ts` },
      { find: '@hy-sde-org/dsh-tool-av', replacement: toolAvSrc },
    ],
  },
})
