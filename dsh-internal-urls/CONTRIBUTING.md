# Contributing

Thanks for helping with `dsh-internal-urls`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **`@hy-sde-org/dsh-internal-urls` stays a library + service plugin.** It
  owns the registry and the protocol handlers; it never owns a tool name.
  Tool registration lives in the shadow-tool packages, where agent-scope
  shadowing over the stock `read`/`write`/`grep` is the entire point — never
  re-introduce host-plane rows that register `read`/`write`/`grep` (they
  collide at boot on stock harnesses).
- **No new runtime dependencies** beyond the declared `@deepseek-ai` peers and
  the `diff`/`schemastery`/`@vscode/ripgrep` deps the copied tool packages
  already carry. Runtime Node builtins are fine (the host runs Node).
- **Preserve the per-file upstream attribution headers**
  (`Ported from @oh-my-pi/...` — MIT, see `THIRD-PARTY-NOTICES.md`), and keep
  the fork's routing additions in `src/internal-routing.ts` / `read.ts` /
  `write.ts` / `grep.ts` distinguishable from the upstream code they extend.
- When diffing against a newer harness baseline: the shadow packages must stay
  behavior-identical to the upstream `dsh-tool-fs` / `dsh-tool-fs-search`
  of that baseline plus the routing hunks — a re-sync replaces the copied
  files wholesale, never by bisecting hunks.

## Development

```bash
pnpm install
pnpm -r build                      # internal-urls first (types), then the shadow packages
pnpm -r check                      # strict typecheck
pnpm -r test                       # 20 internal-urls tests + routing E2E tests
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish in dependency order
```
