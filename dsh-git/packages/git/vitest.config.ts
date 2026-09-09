/**
 * Vitest config for @hy-sde-org/dsh-git tests.
 *
 * `vitest run` from this directory also sweeps the nested
 * `tool-git/tests/**` suites (tool-git lives under packages/git). Alias the
 * workspace packages to their TS sources so every suite executes ONE copy of
 * each module: `push-gate.ts` keeps a module-level verdict map, and a
 * built-dist copy plus a src copy would be two different singletons (tests
 * record into one while the tool reads the other). This mirrors the harness
 * fork's `vite-tsconfig-paths` setup ("paths must win over package exports so
 * built lib/ never loads a second module-singleton copy").
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const gitSrc = fileURLToPath(new URL('./src', import.meta.url))
const toolGitSrc = fileURLToPath(new URL('./tool-git/src/index.ts', import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: [
      // Subpath exports first (`/worktree`, `/repo-lock`, ...), then the root.
      { find: /^@hy-sde-org\/dsh-git\/(.+)$/, replacement: `${gitSrc}/$1.ts` },
      { find: '@hy-sde-org/dsh-git', replacement: `${gitSrc}/index.ts` },
      { find: '@hy-sde-org/dsh-tool-git', replacement: toolGitSrc },
    ],
  },
})
