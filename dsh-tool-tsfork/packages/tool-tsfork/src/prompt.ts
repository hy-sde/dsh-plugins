/**
 * The `tsfork:tools` system-prompt section: what the devices are for, when to
 * reach for them, and the one gotcha (buildinfo version-tagging) that saves an
 * agent from a confusing cold-run surprise.
 * @module @hy-sde-org/dsh-tool-tsfork/prompt
 */

/** The prompt section registered by the plugin. */
export function buildTsforkPromptSection(): { name: string; order: number; text: string } {
  return {
    name: 'tsfork:tools',
    order: 120,
    text:
      'tsfork_* devices drive a parked Go-native TypeScript compiler (TS 7.1.0-dev, can1357/TypeScript '
      + 'perf/checker-speedups-v3): tsfork_check runs `tsc -b <project>` with parsed diagnostics and wall time — '
      + 'measured ~7.7× faster cold than the repo\'s stock typescript@6.0.3 over the 337-project host graph with '
      + 'byte-identical output; tsfork_status reports the binary and build stamp. Use it for perf trials and '
      + 'experimental gates; pass cwd (and project) explicitly when working outside the default checkout. '
      + 'GOTCHA: .tsbuildinfo is compiler-version-tagged — alternating tsfork_check with stock `tsc` runs '
      + 'invalidates the other side\'s incremental caches (runs go cold). tsfork does NOT replace the pinned '
      + 'toolchain: oxlint typeAware and the typert generator keep using typescript@6.0.3.',
  }
}
