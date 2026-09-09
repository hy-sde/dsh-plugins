# Contributing

Thanks for helping with `dsh-logseq`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-logseq-graph` beyond its
  declared peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-invariants`) and no
  new `@deepseek-ai` dependencies for `@hy-sde-org/dsh-tool-logseq` beyond its
  declared peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-invariants`,
  `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tools`). Runtime Node
  builtins are fine (the host runs Node).
- **The tool surface must stay CLI-attached.** Never depend on the desktop
  MCP bridge or a network service — the whole point is that the tools run the
  installed `logseq` CLI headlessly with zero extra services.
- **Preserve upstream attribution.** Files ported from
  `@deepseek-ai/dsh-logseq-graph` / `@deepseek-ai/dsh-tool-logseq` keep their
  structure and module JSDoc (rebranded to `@hy-sde-org/...`); see
  `THIRD-PARTY-NOTICES.md` for provenance.
- **Testkit parity.** Ported test specs keep their hermetic shim coverage;
  live-integration blocks stay gated behind `LOGSEQ_INTEGRATION=1` and are
  skipped in CI.
- Keep `README.md` and `README.zh.md` in sync (and re-record the
  `README.i18n.yaml` blob hashes with `git hash-object` after either side
  changes).

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of both packages
pnpm -r test       # logseq-graph + tool-logseq tests (shim CLI, hermetic)
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish logseq-graph then tool-logseq
```
