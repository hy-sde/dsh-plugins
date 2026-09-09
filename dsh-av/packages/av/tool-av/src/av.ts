/**
 * Model-facing Automic Vault tools over the host `ctx.av` service.
 *
 * The surface is deliberately read-only: `av_scan` (audit the Mac for exposed
 * credential configurations and hazards), `av_doctor` (verify hardening),
 * `av_catalog` (which detectors/hardeners Automic Vault knows), and `av_list`
 * (saved secret NAMES only). The value-releasing and system-mutating verbs of
 * the `av` CLI (`inject` / `proxy` / `save` / `harden`) are intentionally NOT
 * exposed — they stay human-in-the-loop in a terminal the user controls, and
 * no tool output ever contains a Secret Value.
 * @module @hy-sde-org/dsh-tool-av/av
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { AvCommandError } from '@hy-sde-org/dsh-av'
import type { AvService, ScanReport, DoctorReport } from '@hy-sde-org/dsh-av'

/** Tool configuration; all values optional (service defaults apply). */
export interface AvToolConfig {
  /** Cap on `av_scan` findings rendered + returned (default 30). */
  maxFindings?: number
  /** Cap on catalog entries per scope (default 60). */
  maxCatalogEntries?: number
}

const SEVERITIES = ['high', 'medium', 'low'] as const
/**
 * Av Severity.
 *
 */
export type AvSeverity = (typeof SEVERITIES)[number]

/**
 * Av Scan Args.
 *
 */
export interface AvScanArgs {
  /** Only findings at or above this severity (null = all). */
  severity?: AvSeverity
  /** Detector name (from `av_catalog`) to narrow the scan to one tool. */
  detector?: string
  /** Cap on returned findings (default 30). */
  max_findings?: number
}

/**
 * Av Scan Finding Value.
 *
 */
export interface AvScanFindingValue {
  source: string
  severity: string
  explanation: string
  solution: string
  affected: string[]
  detectors: string[]
}

/**
 * Av Scan Value.
 *
 */
export interface AvScanValue {
  /** Whether the Automic Vault CLI is reachable (install hint when false). */
  available: boolean
  version?: string
  /** Why the surface is unavailable, when it is. */
  reason?: string
  summary: { total: number; high: number; medium: number; low: number }
  findings: AvScanFindingValue[]
  truncated?: boolean
}

/**
 * Av Doctor Args.
 *
 */
export interface AvDoctorArgs {
  /** Hardener name to verify (empty = all applicable). */
  tool?: string
}

/**
 * Av Doctor Issue Value.
 *
 */
export interface AvDoctorIssueValue {
  kind: string
  message: string
  remediation?: string
  stub_path?: string
  target_path?: string
}

/**
 * Av Doctor Result Value.
 *
 */
export interface AvDoctorResultValue {
  name: string
  healthy: boolean
  commands: string[]
  issues: AvDoctorIssueValue[]
}

/**
 * Av Doctor Value.
 *
 */
export interface AvDoctorValue {
  available: boolean
  version?: string
  /** Why the surface is unavailable, when it is. */
  reason?: string
  results: AvDoctorResultValue[]
}

/**
 * Av Catalogs Args.
 *
 */
export interface AvCatalogsArgs {
  /** Which catalog to return (default both). */
  scope?: 'detectors' | 'hardeners' | 'both'
  /** Cap on entries per scope (default 60). */
  max_entries?: number
}

/**
 * Av Catalog Entry Value.
 *
 */
export interface AvCatalogEntryValue {
  name: string
  docs?: string
}

/** Hardener catalog entries carry hardening/applicable status. */
export interface AvHardenerCatalogEntryValue {
  name: string
  docs?: string
  hardened: boolean
  applicable: boolean
}

/**
 * Av Catalog Value.
 *
 */
export interface AvCatalogValue {
  available: boolean
  version?: string
  /** Why the surface is unavailable, when it is. */
  reason?: string
  detectors?: AvCatalogEntryValue[]
  hardeners?: AvHardenerCatalogEntryValue[]
  truncated?: boolean
}

/**
 * Av List Value.
 *
 */
export interface AvListValue {
  available: boolean
  version?: string
  /** Why the surface is unavailable, when it is. */
  reason?: string
  names: string[]
}

/** Install hint surfaced when the `av` CLI is missing. */
const INSTALL_HINT =
  'The Automic Vault CLI (av) is not available on this machine. Install it first: `brew install --cask automic-vault/isotopes/automic-vault`, then re-run.'

function safeText(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function affectedLines(affected: ScanReport['findings'][number]['affected']): string[] {
  return affected.map(a => `${a.path}${a.line != null ? `:${a.line}` : ''}`)
}

/** Render an unavailable probe as a one-line reason. */
function unavailableValue(reason: string): { available: false; reason: string } {
  // Typed as a minimal available:false contract; callers assert it onto their
  // concrete value shape (reason is part of every tool's output schema).
  return { available: false, reason }
}

/**
 * Apply Av Tools.
 *
 * @param ctx - The ctx parameter.
 * @param config - The config parameter.
 */
export function applyAvTools(ctx: Context, config: AvToolConfig = {}): void {
  const av: AvService = ctx.av
  const maxFindings = config.maxFindings ?? 30
  const maxCatalogEntries = config.maxCatalogEntries ?? 60

  ctx.tools.register(defineTool({
    name: 'av_scan',
    description:
      'Audit the Mac for supported credential exposures and security hazards using Automic Vault (runs `av scan --json`): '
      + 'files/lines where developer-tool secrets are exposed in plaintext config, keychains, or ambient helpers, with an '
      + 'explanation and remediation per finding. Read-only; never returns stored secret values. Narrow with `detector` '
      + '(a name from `av_catalog` scope=detectors) or keep the full audit. Report findings to the user and propose the '
      + 'documented `av harden <tool>`-style fix — running hardening is a human decision in a terminal.',
    parameters: {
      severity: {
        type: 'string',
        enum: [...SEVERITIES],
        description: 'Only findings at or above this severity (default: all).',
      },
      detector: {
        type: 'string',
        description: 'Detector name (e.g. gh_cli) to scan only that tool; from `av_catalog` scope=detectors.',
      },
      max_findings: {
        type: 'integer',
        description: `Cap on returned findings (default ${maxFindings}); remaining findings are summarized.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          version: { type: 'string' },
          reason: { type: 'string' },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              high: { type: 'integer', required: true },
              medium: { type: 'integer', required: true },
              low: { type: 'integer', required: true },
            },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                explanation: { type: 'string', required: true },
                solution: { type: 'string', required: true },
                affected: { type: 'array', items: { type: 'string' }, required: true },
                detectors: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args: AvScanArgs, value: AvScanValue) => [{ type: 'text', text: renderScan(value) }],
    },
    async execute(args: AvScanArgs): Promise<AvScanValue> {
      const probe = await av.probe()
      if (!probe.available) {
        return unavailableValue(`${INSTALL_HINT} (${probe.reason ?? 'unknown'})`) as AvScanValue      }
      const detectors = args.detector !== undefined && args.detector.length > 0 ? [args.detector] : []
      const report = await av.scan(detectors)
      return summarizeScan(report, args, maxFindings, probe.version)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'av_doctor',
    description:
      'Verify Automic Vault hardening status of installed developer tools (runs `av doctor [tool] --json`): which '
      + 'hardened tools are healthy and which have issues, with the remediation step per issue (stub/target paths). '
      + 'Read-only; the agent reports, the user runs hardening. Use `av_catalog` first to see tool names.',
    parameters: {
      tool: {
        type: 'string',
        description: 'Hardener/tool name to check (default: all applicable).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          version: { type: 'string' },
          reason: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                healthy: { type: 'boolean', required: true },
                commands: { type: 'array', items: { type: 'string' }, required: true },
                issues: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true },
                      message: { type: 'string', required: true },
                      remediation: { type: 'string' },
                      stub_path: { type: 'string' },
                      target_path: { type: 'string' },
                    },
                  },
                  required: true,
                },
              },
            },
          },
        },
      },
      render: (_args: AvDoctorArgs, value: AvDoctorValue) => [{ type: 'text', text: renderDoctor(value) }],
    },
    async execute(args: AvDoctorArgs): Promise<AvDoctorValue> {
      const probe = await av.probe()
      if (!probe.available) {
        return unavailableValue(`${INSTALL_HINT} (${probe.reason ?? 'unknown'})`) as AvDoctorValue
      }
      const report = await av.doctor(args.tool)
      return summarizeDoctor(report, probe.version)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'av_catalog',
    description:
      'List which tools Automic Vault knows: detectors (scan coverage; names feed `av_scan` `detector`) and hardeners '
      + '(hardening status; names feed `av_doctor` `tool`), each with its docs link. Read-only metadata from '
      + '`av detectors --json` and `av hardeners --json`.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['detectors', 'hardeners', 'both'],
        description: 'Which catalog to return (default both).',
      },
      max_entries: {
        type: 'integer',
        description: `Cap on entries per scope (default ${maxCatalogEntries}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          version: { type: 'string' },
          reason: { type: 'string' },
          detectors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                docs: { type: 'string' },
              },
            },
          },
          hardeners: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                docs: { type: 'string' },
                hardened: { type: 'boolean', required: true },
                applicable: { type: 'boolean', required: true },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args: AvCatalogsArgs, value: AvCatalogValue) => [{ type: 'text', text: renderCatalog(value) }],
    },
    async execute(args: AvCatalogsArgs): Promise<AvCatalogValue> {
      const probe = await av.probe()
      if (!probe.available) {
        return unavailableValue(`${INSTALL_HINT} (${probe.reason ?? 'unknown'})`) as AvCatalogValue
      }
      const scope = args.scope ?? 'both'
      const cap = Math.max(1, args.max_entries ?? maxCatalogEntries)
      let truncated = false
      const value: AvCatalogValue = { available: true, ...probe.version !== undefined ? { version: probe.version } : {} }
      if (scope === 'detectors' || scope === 'both') {
        const report = await av.detectors()
        const entries = report.detectors.map(d => ({ name: d.name, ...d.docs_url !== undefined ? { docs: d.docs_url } : {} }))
        if (entries.length > cap) {
          value.detectors = entries.slice(0, cap)
          truncated = true
        } else {
          value.detectors = entries
        }
      }
      if (scope === 'hardeners' || scope === 'both') {
        const report = await av.hardeners()
        const entries = report.hardeners.map(h => ({
          name: h.name,
          ...h.documentation !== undefined ? { docs: h.documentation } : {},
          hardened: h.hardened,
          applicable: h.applicable,
        }))
        if (entries.length > cap) {
          value.hardeners = entries.slice(0, cap)
          truncated = true
        } else {
          value.hardeners = entries
        }
      }
      return { ...value, ...truncated ? { truncated } : {} }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'av_list',
    description:
      'List the names of secrets stored in Automic Vault (`av list`). Returns NAMES ONLY — never values, and never '
      + 'releases a secret. Use it to tell the user what the vault holds, then let the user decide what to do.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          version: { type: 'string' },
          reason: { type: 'string' },
          names: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args: Record<string, never>, value: AvListValue) => [{ type: 'text', text: renderList(value) }],
    },
    async execute(): Promise<AvListValue> {
      const probe = await av.probe()
      if (!probe.available) {
        return unavailableValue(`${INSTALL_HINT} (${probe.reason ?? 'unknown'})`) as AvListValue
      }
      const names = await av.list()
      return { available: true, ...probe.version !== undefined ? { version: probe.version } : {}, names }
    },
  }))
}

function summarizeScan(
  report: ScanReport,
  args: AvScanArgs,
  cap: number,
  version: string | undefined,
): AvScanValue {
  const all = args.severity !== undefined
    ? report.findings.filter(f => f.severity === args.severity)
    : report.findings
  const summary = {
    total: all.length,
    high: all.filter(f => f.severity === 'high').length,
    medium: all.filter(f => f.severity === 'medium').length,
    low: all.filter(f => f.severity === 'low').length,
  }
  let truncated = false
  let findings = all.map(f => ({
    source: f.source,
    severity: f.severity,
    explanation: safeText(f.explanation),
    solution: safeText(f.solution),
    affected: affectedLines(f.affected),
    detectors: f.detectors,
  }))
  if (findings.length > cap) {
    findings = findings.slice(0, cap)
    truncated = true
  }
  return {
    available: true,
    ...version !== undefined ? { version } : {},
    summary,
    findings,
    ...truncated ? { truncated } : {},
  }
}

function summarizeDoctor(report: DoctorReport, version: string | undefined): AvDoctorValue {
  return {
    available: true,
    ...version !== undefined ? { version } : {},
    results: report.results.map(r => ({
      name: r.name,
      healthy: r.issues.length === 0,
      commands: r.commands,
      issues: r.issues.map(i => ({
        kind: i.kind,
        message: i.message,
        ...i.remediation !== undefined ? { remediation: i.remediation } : {},
        ...i.stub_path !== undefined ? { stub_path: i.stub_path } : {},
        ...i.target_path !== undefined ? { target_path: i.target_path } : {},
      })),
    })),
  }
}

/**
 * Wrap an av command failure into a model-visible message.
 * @param error - the failure thrown by the av CLI or service.
 * @returns never - always throws with a model-visible message.
 */
export function rethrowAvError(error: unknown): never {
  if (error instanceof AvCommandError) {
    const detail = error.stderr.trim()
    throw new Error(`${error.message}${detail.length > 0 ? `\n${detail}` : ''}`)
  }
  throw error
}

/* ── rendering ─────────────────────────────────────────────────────────── */

/**
 * Render Scan.
 *
 * @param value - The value parameter.
 * @returns - The result of the operation.
 */
export function renderScan(value: AvScanValue): string {
  if (!value.available) return value.reason ?? 'av unavailable'
  const head = [`Automic Vault audit — ${value.summary.total} finding(s)`, `  high: ${value.summary.high}  medium: ${value.summary.medium}  low: ${value.summary.low}`]
  const lines = [...head]
  for (const f of value.findings) {
    lines.push(`[${f.severity}] ${f.source}`)
    if (f.affected.length > 0) lines.push(`  files: ${f.affected.join(', ')}`)
    lines.push(`  ${f.explanation}`)
    lines.push(`  fix: ${f.solution}`)
  }
  if (value.truncated) lines.push(`… ${value.summary.total - value.findings.length} more finding(s) not shown`)
  return lines.join('\n')
}

/**
 * Render Doctor.
 *
 * @param value - The value parameter.
 * @returns - The result of the operation.
 */
export function renderDoctor(value: AvDoctorValue): string {
  if (!value.available) return value.reason ?? 'av unavailable'
  if (value.results.length === 0) return 'av doctor: no applicable hardeners'
  const lines = ['Automic Vault hardening status:']
  for (const r of value.results) {
    if (r.healthy) {
      lines.push(`  ${r.name}: healthy`)
      continue
    }
    lines.push(`  ${r.name}: issues`)
    for (const issue of r.issues) {
      lines.push(`    - ${issue.message}`)
      if (issue.remediation) lines.push(`      fix: ${issue.remediation}`)
      const paths = [issue.stub_path, issue.target_path].filter(Boolean).join(' → ')
      if (paths.length > 0) lines.push(`      ${paths}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render Catalog.
 *
 * @param value - The value parameter.
 * @returns - The result of the operation.
 */
export function renderCatalog(value: AvCatalogValue): string {
  if (!value.available) return value.reason ?? 'av unavailable'
  const lines = ['Automic Vault catalog:']
  if (value.detectors !== undefined) {
    lines.push('  detectors (scan coverage):')
    for (const d of value.detectors) lines.push(`    - ${d.name}${d.docs ? ` (${d.docs})` : ''}`)
  }
  if (value.hardeners !== undefined) {
    lines.push('  hardeners:')
    for (const h of value.hardeners) {
      const state = h.applicable ? (h.hardened ? 'hardened' : 'not hardened') : 'not applicable'
      lines.push(`    - ${h.name} — ${state}${h.docs ? ` (${h.docs})` : ''}`)
    }
  }
  if (value.truncated) lines.push('… catalog truncated to configured entry cap')
  return lines.join('\n')
}

/**
 * Render List.
 *
 * @param value - The value parameter.
 * @returns - The result of the operation.
 */
export function renderList(value: AvListValue): string {
  if (!value.available) return value.reason ?? 'av unavailable'
  if (value.names.length === 0) return 'Automic Vault holds no saved secrets.'
  return ['Automic Vault secret names (values never exposed):', ...value.names.map(n => `  - ${n}`)].join('\n')
}
