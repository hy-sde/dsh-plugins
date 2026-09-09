# dsh-session-intelligence

Session health intelligence for DeepSeek Harness — port of agentsview's
(MIT, Kenn Software) `internal/signals` engine: outcome classification
(completed/abandoned/errored/unknown), penalty-based A–F health grades with
basis + penalties, tool-health signals, prompt/workflow heuristics, and
context-pressure signals. Powers the `session_health` tool and a standalone
CLI. See [`packages/session-intelligence/README.md`](./packages/session-intelligence/README.md).

## Packages

| package | description |
| --- | --- |
| [`@hy-sde-org/dsh-session-intelligence`](./packages/session-intelligence) | engine + DSH event adapter + `session_health` tool + CLI |

## Develop

```bash
pnpm install
pnpm -r check        # tsc --noEmit
pnpm -r test         # vitest run
pnpm -r build        # tsc -p tsconfig.build.json
```

## License

MIT — see [LICENSE](./LICENSE). Ports of agentsview (MIT) and
`dsh-session-persistence-jsonl` (MIT) are attributed in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
