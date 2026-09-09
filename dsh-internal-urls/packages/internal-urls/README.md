# @hy-sde-org/dsh-internal-urls

FS-shaped **internal URL schemes** for DeepSeek Harness: `conflict://`,
`issue://`, `pr://`, and `agent://` resolved through one resolver registry
(`ctx.internalUrls`) that the read/grep/write tools consult before touching
the filesystem. Ported from the [@oh-my-pi](https://github.com/oh-my-pi)
coding-agent `internal-urls` system (the port lives in the
[hy-sde fork](https://github.com/hy-sde/deepseek-harness)) and shipped as
a **standalone plugin**: the registry row installs via `cordis.patch.yml`, and
the routing tools install as agent-scope shadows
(`@hy-sde-org/dsh-tool-fs-internal-urls` /
`@hy-sde-org/dsh-tool-fs-search-internal-urls`). Nothing in the upstream
DeepSeek Harness (`dsh-v0.1.2-rc.1` and later) needs to change.

## URL shapes

- `conflict://<N>` — a recorded git conflict block (register one by reading
  the conflicted file; `read` appends a resolution notice with the ids).
  `conflict://<N>/ours|theirs|base` renders one side; `conflict://*` summarizes
  every registered block. `write({ path: "conflict://<N>", content })` splices
  the resolution into the backing file (`@ours` / `@theirs` / `@base` /
  `@both` line tokens expand; `conflict://*` bulk-resolves). `<path>:conflicts`
  reads a whole-file conflict summary.
- `issue://` / `pr://` — GitHub-as-filesystem through the `gh` CLI:
  `issue://owner/repo`, `issue://123`, `issue://owner/repo/123`,
  `pr://N/diff`, `pr://N/diff/all`, `pr://N/diff/<i>`, list options
  (`?state=open&limit=30`, `?comments=0`).
- `agent://<id>` — one subagent's final assistant output (a child session id
  with `origin === 'subagent'`). `agent://<parent>/<child>` walks the
  `parentSession` chain to a nested child output. Outputs are read-only
  markdown backed by the published `@deepseek-ai/dsh-session-query` service
  (`ctx.sessionQuery`), which is an **optional peer**: without it every
  `agent://` read reports a corrective "outputs unavailable" error instead of
  failing registration. The omp `?q=` JSON extraction form is **not
  supported** — agent outputs are markdown, not jq-able documents — and
  returns an explicit error.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

All three packages are published on the npm registry under the `hy-sde-org`
organization (version `0.1.2-rc.1`). Add the service, then mount the routing
tools via a preset:

```bash
dsh plugin --profile web add @hy-sde-org/dsh-internal-urls \
  @hy-sde-org/dsh-tool-fs-internal-urls \
  @hy-sde-org/dsh-tool-fs-search-internal-urls
```

Then copy `examples/agent-preset/` from the installed package (or this repo)
to `~/.dsh/.agent-presets/<id>/` and select it in the Web UI preset picker.

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-internal-urls.git
cd dsh-internal-urls
pnpm install
pnpm run build

IU_TGZ="$(cd packages/internal-urls && pnpm pack --silent --pack-destination /tmp)"
FS_TGZ="$(cd packages/tool-fs-internal-urls && pnpm pack --silent --pack-destination /tmp)"
SEARCH_TGZ="$(cd packages/tool-fs-search-internal-urls && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$IU_TGZ" "$FS_TGZ" "$SEARCH_TGZ"
```

## How stock-harness routing works

The official harness ships `dsh-tool-fs` (`read`/`write`/`edit`) and
`dsh-tool-fs-search` (`grep`) host-wide, with no seam into `ctx.internalUrls`
(that routing only exists in the hy-sde fork). This plugin therefore mounts
agent-scope **shadow** copies of those two tool suites that behave identically
on plain filesystem paths and route internal URLs through the registry when
mounted — harness scoped-tools semantics let the agent's own registration
shadow the global one, so only sessions using the preset preset get the
routing, and stock tool behavior elsewhere is untouched.

## Service API

```ts ignore-check
await ctx.plugin(InternalUrls)

const iu = ctx.internalUrls                  // InternalUrlsService
iu.register(handler)                         // one ProtocolHandler per scheme
await iu.resolve('conflict://1', { sessionKey, cwd, signal })
await iu.write('conflict://1', '@theirs', { sessionKey, cwd, signal, sandboxPolicy })
iu.conflicts(sessionKey)                     // per-session ConflictHistory
```

Handlers are plain objects (`{ scheme, immutable, resolve, write?, complete? }`)
registered per scheme; the shipped `conflict://`, `issue://`, `pr://`,
`agent://` handlers mount with the plugin and are removed on unmount. The
`agent://` handler resolves its session-query store lazily at resolve time, so
deployments without the optional `@deepseek-ai/dsh-session-query` peer keep
the registry healthy.

## Config (the `internal-urls` row)

No configuration today — the row is inserted bare. Handler state (conflict
histories) is keyed by session inside the service; the optional
`SandboxExecutionPolicy` rides the write context opaque from the routing tool.

## Tests

```sh
pnpm -r --filter @hy-sde-org/dsh-internal-urls test
```
