/**
 * Standalone CLI availability probe for `@hy-sde-org/dsh-tool-logseq`.
 * Spawns `<cli> --version` once with an 8s budget.
 * @module @hy-sde-org/dsh-tool-logseq/cli-check
 */

import { execFile } from 'node:child_process'

/**
 * Verify the `logseq` CLI resolves and runs.
 * @param cliPath - CLI executable to verify (default `logseq` on PATH).
 * @returns a promise settling once the probe succeeds.
 * @throws a descriptive error with an install hint when the probe fails.
 */
export function checkLogseqCli(cliPath: string = 'logseq'): Promise<void> {
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
      reject(new Error(`tool-logseq: ${hint}. Install the Logseq CLI from the logseq repository (opam exec -- dune build @bundle) then re-run, or set config.cliPath.`))
    })
  })
}
