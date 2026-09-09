/**
 * Standalone CLI availability probe for `@hy-sde-org/dsh-tool-codebase-memory`.
 * Spawns `<cli> --version` once with an 8s budget.
 * @module @hy-sde-org/dsh-tool-codebase-memory/cli-check
 */

import { execFile } from 'node:child_process'

/**
 * Verify the `codebase-memory-mcp` CLI resolves and runs.
 * @param cliPath - CLI executable to verify (default `codebase-memory-mcp` on PATH).
 * @returns a promise settling once the probe succeeds.
 * @throws a descriptive error with an install hint when the probe fails.
 */
export function checkCodebaseMemoryCli(cliPath: string = 'codebase-memory-mcp'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(cliPath, ['--version'], { timeout: 8000, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) {
        resolve()
        return
      }
      const code = typeof (err as { code?: unknown }).code === 'number'
      const hint = code
        ? `the \`${cliPath}\` CLI exited with code ${(err as { code: number }).code}: ${(stderr || '').trim().slice(0, 200)}`
        : `\`${cliPath}\` was not found on PATH`
      reject(new Error(`tool-codebase-memory: ${hint}. Install the codebase-memory CLI from the codebase-memory-mcp releases (https://github.com/DeusData/codebase-memory-mcp/releases): tar xzf then ./install.sh, or set config.cliPath.`))
    })
  })
}
