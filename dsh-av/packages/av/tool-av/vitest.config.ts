/**
 * Vitest config for @hy-sde-org/dsh-tool-av tests.
 *
 * The tests mount the tool plugin and assert its behavior, and the source
 * imports the workspace `@hy-sde-org/dsh-av` package by name. Alias the
 * workspace packages to their TS sources so vitest executes ONE copy of each
 * module and so `pnpm -r test` is green on a fresh checkout before
 * `pnpm -r build` has produced `dist/`. This mirrors the harness fork's
 * `vite-tsconfig-paths` setup ("paths must win over package exports so built
 * lib/ never loads a second module-singleton copy").
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const avSrc = fileURLToPath(new URL('../av/src', import.meta.url))
const toolAvSrc = fileURLToPath(new URL('./src/index.ts', import.meta.url))

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
