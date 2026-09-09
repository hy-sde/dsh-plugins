# dsh-tool-codebase-memory — codebase-memory CLI tools for DeepSeek Harness

A standalone package, installable as **one plugin** (fourteen tools) for the
DeepSeek Harness CLI:

| package | tools | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-tool-codebase-memory` | `codebase_list_projects`, `codebase_index_repository`, `codebase_index_status`, `codebase_search_graph`, `codebase_query_graph`, `codebase_trace_path`, `codebase_get_code_snippet`, `codebase_get_graph_schema`, `codebase_get_architecture`, `codebase_search_code`, `codebase_detect_changes`, `codebase_manage_adr`, `codebase_ingest_traces`, `codebase_delete_project` | yes |

This is the DeepSeek Harness `packages/codebase-memory/tool-codebase-memory`
package — the model-facing `codebase_*` tools wrapped over the
`codebase-memory-mcp` CLI — ported to the hy-sde npm scope as a **standalone
plugin with zero upstream harness changes**: every `@deepseek-ai` dependency
resolves from the npm registry at the `0.1.2-rc.1` baseline, so it installs on
official DeepSeek Harness releases (`dsh-v0.1.2-rc.1` and later) exactly as it
runs in the fork. The CLI is not bundled: install
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (or
point `cliPath` at a non-PATH binary) and the plugin runs against the same
local daemon the stdio MCP client fronts.

## Summary

The package exposes the local codebase-memory daemon as model-facing
`codebase_*` tools that run one-shot queries from the terminal. Each call
spawns `codebase-memory-mcp cli --json <tool>` once with a temp `--args-file`
and parses the raw MCP result envelope — indexes, project mutation locks and
the index supervisor are shared with the MCP server's daemon, and no long-lived
server lives inside the session. See the package
[README](packages/tool-codebase-memory/README.md) for the full tool surface,
configuration, and the CLI-vs-MCP rationale.

## Table of Contents

- [Install](#install)
- [Mounting](#mounting)
- [License](#license)

-----

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-codebase-memory
```

`dsh plugin add` reconciles the profile's bundle list from the installed
`dsh.bundle.patch` export, so after installation the
`hy-sde-cbm-tool-codebase-memory` row below is immediately active in the named
profile.

You can also just depend on the package from your own tooling:

```bash
npm install @hy-sde-org/dsh-tool-codebase-memory   # or pnpm add / yarn add
```

### From this repository (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-tool-codebase-memory.git
cd dsh-tool-codebase-memory
pnpm install
pnpm run build

CBM_TGZ="$(cd packages/tool-codebase-memory && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$CBM_TGZ"
```

`prepack` rebuilds `dist/`, so the tarball is always current.

### Verify

```bash
dsh web --dump-config   # look for the hy-sde-cbm-tool-codebase-memory row
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-tool-codebase-memory
```

> **Already shipped?** If a future DeepSeek Harness release ships
> codebase-memory tooling itself, skip installation — adding this bundle on
> top would duplicate the loader row and fail at boot.

## Mounting

The plugin's `cordis.patch.yml` mounts **one plain agent-plane row**, exactly
like the official harness's own `tool-codebase-memory` row in the stock base
bundle. It consumes the deployment's host services — `tools` and
`systemPrompt` (stock base provides both via the agent bundle) — so it needs
no service or filesystem realm of its own:

- `hy-sde-cbm-tool-codebase-memory` — `@hy-sde-org/dsh-tool-codebase-memory`,
  registering the fourteen `codebase_*` tools and the `codebase:tools` prompt
  section.

Configure per deployment by patching the row by id:

```yaml
- id: hy-sde-cbm-tool-codebase-memory
  config:
    cliPath: /opt/codebase-memory-mcp/bin/codebase-memory-mcp
    project: my-monorepo
    timeoutMs: 60000
    indexTimeoutMs: 600000
    maxChars: 200000
```

The row id carries the `hy-sde-` prefix to avoid clashing with any shipped row
of the same name (a duplicate loader id fails the boot); if the deployment
already mounts a `tool-codebase-memory` row of its own, disable this one or
drop the insert and keep the stock row.

## License

MIT — see `LICENSE`. Derived from the DeepSeek Harness
`tool-codebase-memory` package (`@deepseek-ai/dsh-tool-codebase-memory`, MIT) —
see `THIRD-PARTY-NOTICES.md`.
