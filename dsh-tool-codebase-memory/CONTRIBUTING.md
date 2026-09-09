# Contributing

Thanks for helping with `dsh-tool-codebase-memory`. This is a small,
dependency-light monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-tool-codebase-memory`
  beyond its declared peers (`@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-system-prompt`,
  `@deepseek-ai/dsh-tools`). Runtime Node builtins are fine (the host runs
  Node).
- **The tool surface must stay CLI-attached.** Never embed a long-lived MCP
  server or a network service — the whole point is that each call spawns
  `codebase-memory-mcp cli --json <tool>` once against the local daemon, with
  zero extra processes in the session.
- **Preserve upstream attribution.** Files ported from
  `@deepseek-ai/dsh-tool-codebase-memory` keep their structure and module
  JSDoc (rebranded to `@hy-sde-org/...`); see `THIRD-PARTY-NOTICES.md` for
  provenance.
- **Testkit parity.** Ported test specs keep their hermetic shim coverage;
  the live-integration block stays gated behind `CBM_INTEGRATION=1` and is
  skipped in CI.
- Keep `README.md` and `README.zh.md` in sync (and re-record the
  `README.i18n.yaml` blob hashes with `git hash-object` after either side
  changes).

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of the package
pnpm -r test       # tool tests (shim CLI, hermetic)
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```
