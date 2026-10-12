/**
 * Model-facing tsfork devices (`tsfork_status`, `tsfork_check`) over a parked
 * Go-native TypeScript compiler binary. This layer owns schemas, argument
 * handling, and presentation; the engine (binary resolution, spawn, parse)
 * lives in `core.ts`.
 * @module @hy-sde-org/dsh-tool-tsfork/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DefineToolOptions,
  ParameterSchemaSpec,
  ValueSchemaSpec,
  defineTool,
} from '@deepseek-ai/dsh-tools'
import {
  TSFORK_DEFAULT_BINARY,
  TSFORK_DEFAULT_TIMEOUT_MS,
  TsforkError,
  parseDiagnostics,
  parseVersionLine,
  readStamp,
  resolveBinary,
  resolveProjectPath,
  runTsfork,
} from './core.ts'
import { buildTsforkPromptSection } from './prompt.ts'

/**
 * `defineTool` passthrough that additionally accepts the fork's `device`
 * device-catalog marker (same compat shim as tool-codebase-memory). A consumer
 * registry without the device concept simply ignores it at runtime.
 */
function defineTsforkTool<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O> & { device?: boolean },
) {
  return defineTool<S, O>(options)
}

/** Tool-level configuration (all optional; deployment defaults ride the row). */
export interface TsforkToolConfig {
  /** Compiler binary (expandable `~`; default `~/.dsh/tsfork/tsc`). */
  binary?: string
  /** Default `-b` project applied when a call omits `project`. */
  defaultProject?: string
  /** Default working directory applied when a call omits `cwd`. */
  defaultCwd?: string
  /** Default per-call timeout in ms (default 900000). */
  timeoutMs?: number
  /** Default GOMAXPROCS written to the child env (lane-friendly parallelism cap). */
  gomaxprocs?: number
  /** Cap on captured stdout/stderr bytes per side (default 4000000). */
  maxOutputBytes?: number
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

function errorPayload(e: unknown): { code: string; message: string } {
  if (e instanceof TsforkError) return { code: e.code, message: e.message }
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) }
}

/**
 * Register both tsfork devices (the prompt section is added here too; the
 * plugin `apply` in index.ts stays a thin shell).
 * @param ctx - Cordis context carrying `tools` and `systemPrompt`.
 * @param config - tool-level configuration (binary/defaults/timeouts/caps).
 */
export function applyTsforkTools(ctx: Context, config: TsforkToolConfig = {}): void {
  const binary = config.binary ?? TSFORK_DEFAULT_BINARY

  ctx.systemPrompt.section(buildTsforkPromptSection())

  ctx.tools.register(defineTsforkTool({
    name: 'tsfork_status',
    device: true,
    description:
      'Report the parked tsfork Go-native TypeScript compiler: resolved binary path, version banner, '
      + 'build stamp (source branch/commit/toolchain), and a 20s health probe. Zero parameters — call it '
      + 'before trusting tsfork_check results.',
    parameters: {},
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute() {
      try {
        const resolved = resolveBinary(binary)
        const run = await runTsfork({ binary: resolved, args: ['--version'], timeoutMs: 20_000 })
        return { text: JSON.stringify({
          ok: run.code === 0,
          binary: resolved,
          version: parseVersionLine(run.stdout),
          rawVersion: run.stdout.trim(),
          stamp: readStamp(resolved),
          wallMs: run.wallMs,
        }) }
      } catch (e) {
        return { text: JSON.stringify({ ok: false, error: errorPayload(e) }) }
      }
    },
  }))

  ctx.tools.register(defineTsforkTool({
    name: 'tsfork_check',
    device: true,
    description:
      "Run the parked tsfork Go-native TypeScript compiler (`tsc -b <project>`) over a project graph and "
      + 'return exit code, wall time, and parsed diagnostics (errorCount/warningCount plus per-diagnostic '
      + 'file:line:col TSxxxx). Measured ~7.7x faster cold than stock tsc on the 337-project host graph with '
      + 'byte-identical output. Pass cwd (and project) explicitly when working outside the default checkout. '
      + "GOTCHA: .tsbuildinfo is compiler-version-tagged — alternating with the repo's stock `tsc` invalidates "
      + "the other side's incremental caches (runs go cold).",
    parameters: {
      project: { type: 'string', description: 'tsconfig path (file or directory) for `-b`; resolved against cwd. Defaults to the deployment defaultProject.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI args appended verbatim after the project (e.g. ["--dry"]).' },
      cwd: { type: 'string', description: 'Working directory; defaults to the deployment defaultCwd.' },
      dry: { type: 'boolean', description: 'Prepend --dry: list the projects a build would run without building (cheap graph-coverage probe).' },
      timeoutMs: { type: 'number', description: 'Per-call timeout in ms (default 900000); on expiry partial output is returned with timedOut: true.' },
      gomaxprocs: { type: 'number', description: 'GOMAXPROCS override for this run (deployment default caps lane oversubscription).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(input) {
      const cwd = input.cwd ?? config.defaultCwd ?? process.cwd()
      try {
        const resolved = resolveBinary(binary)
        const project = input.project ?? config.defaultProject
        if (project === undefined) {
          throw new TsforkError('project_missing', 'No project given and no deployment defaultProject configured.')
        }
        const projectArg = resolveProjectPath(project, cwd)
        // Order matters for the Go parser: -b must precede the project;
        // post-project flags (--dry etc.) are accepted after it.
        const argv = ['-b', projectArg, ...(input.dry ? ['--dry'] : []), ...(input.args ?? [])]
        const run = await runTsfork({
          binary: resolved,
          args: argv,
          cwd,
          timeoutMs: input.timeoutMs ?? config.timeoutMs ?? TSFORK_DEFAULT_TIMEOUT_MS,
          gomaxprocs: input.gomaxprocs ?? config.gomaxprocs,
          maxOutputBytes: config.maxOutputBytes,
        })
        const parsed = parseDiagnostics(`${run.stdout}\n${run.stderr}`)
        return { text: JSON.stringify({
          ok: !run.timedOut && run.signal === null && run.code === 0,
          exitCode: run.code,
          timedOut: run.timedOut,
          signal: run.signal,
          wallMs: run.wallMs,
          errorCount: parsed.errorCount,
          warningCount: parsed.warningCount,
          diagnostics: parsed.diagnostics,
          diagnosticsTruncated: parsed.truncated,
          outputTruncated: run.truncated,
          command: `tsc ${argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
          cwd,
          outputTail: `${run.stdout}\n${run.stderr}`.trim().slice(-2000),
        }) }
      } catch (e) {
        return { text: JSON.stringify({ ok: false, error: errorPayload(e), cwd }) }
      }
    },
  }))
}
