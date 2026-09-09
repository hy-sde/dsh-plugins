/**
 * Type shapes for the `ctx.av` service, mirroring the JSON payloads of the
 * Automic Vault CLI (`av scan --json`, `av doctor [tool] --json`,
 * `av detectors --json`, `av hardeners --json`, `av list`). Field names are
 * kept 1:1 with the CLI contract so a newer `av` release shows up as parsing
 * data rather than a schema drift.
 * @module @hy-sde-org/dsh-av/types
 */

/** One credential exposure or hazard found by `av scan`. */
export interface AvFinding {
  /** Detector / tool name that produced the finding (e.g. `gh_cli`). */
  source: string
  /** `high`, `medium` or `low`. */
  severity: string
  /** Upstream project homepage (may be absent). */
  homepage?: string
  /** Why this is a problem. */
  explanation: string
  /** Remediation steps. */
  solution: string
  /** Files and lines the finding touches (line may be absent). */
  affected: { path: string; line?: number | null }[]
  /** Automic Vault docs URL for the finding (may be absent). */
  docs_url?: string
  /** Detector names that independently produced the finding. */
  detectors: string[]
}

/** `av scan --json` payload. */
export interface ScanReport {
  findings: AvFinding[]
}

/** One hardening-verification outcome from `av doctor`. */
export interface AvDoctorIssue {
  kind: string
  command?: string
  message: string
  remediation?: string
  stub_path?: string
  target_path?: string
  resolved_path?: string
}

/** One hardener's doctor result. */
export interface AvDoctorResult {
  name: string
  commands: string[]
  issues: AvDoctorIssue[]
}

/** `av doctor [tool] --json` payload. */
export interface DoctorReport {
  results: AvDoctorResult[]
}

/** Watch scope a detector uses. */
export interface AvWatchScope {
  path: string
  recursive: boolean
}

/** `av detectors --json` entry. */
export interface AvDetector {
  name: string
  homepage?: string
  docs_url?: string
  documentation?: string
  watch_scopes: AvWatchScope[]
}

/** `av detectors --json` payload. */
export interface DetectorsReport {
  detectors: AvDetector[]
}

/** A command managed by a hardener. */
export interface AvHardenedCommand {
  name: string
  hardened: boolean
  stub_path?: string
  target_path?: string
  required_paths: string[]
}

/** Route descriptor of a Secret Gate. */
export interface AvSecretGateRoute {
  operation: string
  script_path?: string
  target_path?: string
  caller_identifiers?: string[]
  key_patterns: string[]
  replace_existing_env?: boolean
  allow_missing_keys?: boolean
}

/** Secret Gate descriptor. */
export interface AvSecretGate {
  id: string
  key_patterns: string[]
  routes: AvSecretGateRoute[]
}

/** `av hardeners --json` entry. */
export interface AvHardener {
  name: string
  documentation?: string
  hardened: boolean
  applicable: boolean
  stub_path?: string
  target_path?: string
  commands: AvHardenedCommand[]
  secret_gate?: AvSecretGate
}

/** `av hardeners --json` payload. */
export interface HardenersReport {
  hardeners: AvHardener[]
}

/** Capabilities present when the service was reached. */
export interface AvProbe {
  /** Whether the `av` CLI is reachable and answers `av --version`. */
  available: boolean
  /** CLI-reported version (e.g. `3.16.0`) when available. */
  version?: string
  /** Human-readable failure reason when unavailable. */
  reason?: string
}
