/**
 * Minimal exec wrapper around the installed `logseq` CLI. Self-contained on
 * purpose: this host service must not depend on the agent-plane tool package
 * (`@hy-sde-org/dsh-tool-logseq`), so the ~40 lines of exec/parse logic are
 * mirrored here and kept deliberately small and stable.
 */

import { execFile } from 'node:child_process'

/** Result of one CLI invocation, decoded from `--output json` (or text passthrough). */
export interface CliResult {
  /** The blob after a status:'ok' envelope; null for text output. */
  data: unknown
  /** The raw stdout text (human output or unparsable). */
  text: string
}

/** Envelope error the CLI reports inside `--output json` (status:'error'). */
export class LogseqCliError extends Error {
  /** The full argv sent to the CLI. */
  readonly args: string[]
  /** Captured stdout at failure time. */
  readonly stdout: string
  /** Captured stderr (usually empty for envelope errors). */
  readonly stderr: string
  /** Process exit code when the CLI actually ran; null for spawn failures. */
  readonly exitCode: number | null
  /** Original `status:'error'` payload (string, or the parsed object form with code/message/hint). */
  readonly payload: string | { code?: string; message?: string; hint?: string }
  constructor(
    message: string, args: string[], stdout: string, stderr: string,
    exitCode: number | null, payload?: string | { code?: string; message?: string; hint?: string },
  ) {
    super(message)
    this.name = 'LogseqCliError'
    this.args = args
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
    this.payload = payload ?? message
  }
}

/** Render an envelope `error` field (string or object) into a readable message. */
function formatEnvelopeError(error: { code?: string; message?: string; hint?: string } | string | undefined): string {
  if (typeof error === 'string') return error || 'unknown CLI error'
  if (error === undefined) return 'unknown CLI error'
  const parts = [error.message, error.code !== undefined ? `(${error.code})` : '', error.hint !== undefined ? `— ${error.hint}` : ''].filter(Boolean)
  return parts.join(' ') || 'unknown CLI error'
}

/** Run the logseq CLI with the given args and return its decoded output.
 * @param cliPath - executable to spawn (default `logseq` on PATH).
 * @param args - CLI args after the base graph/runtime flags.
 * @param options - execution options: timeout, base graph name, max buffer.
 * @returns the decoded envelope data (or raw text when not JSON). Throws LogseqCliError
 * on spawn failure, non-zero exit, or `status:'error'` envelopes.
 */
export function execCli(
  cliPath: string,
  args: string[],
  options: { timeoutMs?: number; graph?: string; maxBuffer?: number },
): Promise<CliResult> {
  const { timeoutMs = 60_000, graph, maxBuffer = 64 * 1024 * 1024 } = options
  const full = [...(graph ? ['--graph', graph] : []), ...args, '--output', 'json']
  return new Promise<CliResult>((resolve, reject) => {
    execFile(cliPath, full, { timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : (error as { code?: number } | null)?.code ?? 1
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        reject(new LogseqCliError(`logseq CLI not found at ${cliPath} — install it (opam exec -- dune build @bundle) or set cliPath`, full, '', stderr, null))
        return
      }
      if (error && typeof (error as { code?: number }).code !== 'number') {
        reject(new LogseqCliError(`logseq CLI failed: ${error.message}`, full, stdout, stderr, null))
        return
      }
      const text = stdout
      let envelope: { status?: string; data?: unknown; error?: { code?: string; message?: string; hint?: string } | string } | null = null
      try {
        envelope = JSON.parse(text) as
          { status?: string; data?: unknown; error?: { code?: string; message?: string; hint?: string } | string } | null
      } catch {
        envelope = null
      }
      if (envelope && envelope.status === 'error') {
        reject(new LogseqCliError(formatEnvelopeError(envelope.error), full, text, stderr, exitCode, envelope.error))
        return
      }
      if (error || exitCode !== 0) {
        reject(new LogseqCliError(text.trim() || `logseq exited with code ${String(exitCode)}`, full, text, stderr, exitCode))
        return
      }
      if (envelope) {
        resolve({ data: envelope.data ?? null, text })
      } else if (text.trim().startsWith('Error (')) {
        reject(new LogseqCliError(text.trim(), full, text, stderr, 0)) // raw text passthrough
      } else {
        resolve({ data: null, text })
      }
    })
  })
}

/**
 * Split a string on newlines, preserving empty tags for joiners.
 * @param input - the text to split.
 * @returns the lines, including trailing empties.
 */
export function lines(input: string): string[] {
  return input.split('\n')
}
