/**
 * Invariant companion for `@hy-sde-org/dsh-logseq-graph`: the host-plane
 * graph service needs the same installed CLI the tools require. Fails fast at
 * host boot with an install hint instead of surfacing ENOENT deep inside a UI
 * request.
 * @module @hy-sde-org/dsh-logseq-graph/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { execFile } from 'node:child_process'

const PACKAGE_NAME = '@hy-sde-org/dsh-logseq-graph'

/** Check that the logseq CLI is reachable (spawns `--version` once).
 * @param cliPath - executable to probe; default `logseq`.
 * @returns a promise resolving when the CLI answers.
 */
export function checkLogseqCli(cliPath = 'logseq'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(cliPath, ['--version'], { timeout: 8000 }, (error) => {
      if (error) {
        reject(new Error(
          `the logseq CLI is required (tried ${cliPath}) — install it from the logseq repo: opam exec -- dune build @bundle, then put \`logseq\` on PATH or set cliPath.`,
        ))
        return
      }
      resolve()
    })
  })
}

/** Cordis companion plugin name. */
export const name = 'logseq-graph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the activation invariant: the `logseq` CLI must resolve and run,
 * otherwise every graph read would fail at call time. Config-level `cliPath`
 * overrides are per-call concerns; the companion check uses the PATH default.
 */
const install: InvariantInstaller = async (_ctx, fail) => {
  try {
    await checkLogseqCli()
  } catch (err) {
    fail((err as Error).message)
  }
}

/** Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
