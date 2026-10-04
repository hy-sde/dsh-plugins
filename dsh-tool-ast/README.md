<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-tool-ast`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-ast)
<!-- MIRROR-NOTE:END -->

# dsh-tool-ast — structural search & rewrite for DeepSeek Harness

A standalone package, installable as **one plugin** (two tools) for the DeepSeek
Harness CLI:

| package | tools | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-tool-ast` | `ast_grep` (structural code search) + `ast_edit` (structural rewrite, preview-first) | yes |

`ast_grep` and `ast_edit` are a full parity port of oh-my-pi's coding-agent
ast tools onto the harness tool contract (`ctx.tools`, `ctx.fs`,
`ctx.subprocess`, `ctx.systemPrompt`). The engine is the **packaged
`@ast-grep/cli` native binary** — it ships inside the npm dependency, so the
plugin works on stock DeepSeek Harness deployments with **zero upstream
changes** and no system `ast-grep` install.

## The two tools

- **`ast_grep`** — syntax-aware structural search. Find every function, call,
  class, or declaration matching a tree pattern instead of a text substring:
  `console.log($MSG)` finds every console.log call, `fn($X)` finds every
  function `fn` with one argument. Patterns bind metavariables (`$NAME`,
  `$_`, `$$$NAME`) so a search can be turned directly into a rewrite.
- **`ast_edit`** — structural rewrite. Replace every node matching a pattern
  with a template that references the captured metavariables
  (`console.log($MSG)` → `log.debug($MSG)`). **It always PREVIEWS first**
  (`apply` defaults to `false`); pass `apply: true` to write the files.
  Rewrites are 1:1 structural substitutions — never text search-and-replace.

Both share one engine, one error vocabulary (`AST_*`), one set of caps, and
one filesystem seam — which is why they ship in one package rather than two.

## Relationship to the `edit` tool

For coding agents, `edit` (targeted, literal, line-anchored text changes) and
`ast_edit` (structural AST changes) are **complementary, not alternatives**:

| | `edit` / `ast_edit` in omp | `edit` / `ast_edit` in this package |
|---|---|---|
| pairing | auto-added together when `edit` is requested | both tools ship in this one package |
| apply model | `edit` applies directly; `ast_edit` previews + staged resolve | `ast_edit` previews by default; `apply: true` writes |
| guidance | "For one-off text edits, prefer the Edit tool" | idiomatic: `ast_edit` for codemods → `edit` for follow-ups |

Both mutation paths write through the same `ctx.fs` seam (observation
watermark, version guard, sandbox policy), so they compose safely in one
session. The harness companion-preset pattern (`code-edit`) mounts a rich
`edit` beside `ast_edit`; this package's bundle (below) provides
`read`/`write` beside `ast_grep`/`ast_edit`, and can be pointed at the rich
`@hy-sde-org/dsh-tool-edit` if you want the full editor.

## Why

Text grep answers "where does this string appear"; an AST pattern answers "where does
this code shape appear". `ast_grep` matches tree structure — `console.log($MSG)` finds
every console.log call, `fn($X)` every one-argument call to `fn` — so a codemod cannot
be missed because of formatting or string coincidence. Because patterns bind
metavariables (`$NAME`, `$_`, `$$$NAME`), the match that found the problem turns
directly into the fix: `ast_edit` rewrites every matched node with a template
referencing the captures, always previews first (`apply` defaults to `false`), and
writes only on `apply: true` — a 1:1 structural substitution, never a text
search-and-replace.

For coding agents this is complementary to the `edit` tool, not an alternative: the
idiomatic flow is `ast_edit` for codemods, `edit` for follow-ups. Both mutation paths
write through the same `ctx.fs` seam, so they compose safely in one session — the
relationship is detailed under *Relationship to the `edit` tool* below.

## Prerequisites

- Node.js 22.19 or newer (the package's `engines` floor) with npm and pnpm on `PATH`;
- a DeepSeek Harness installation including the standard `dsh` CLI — the package's peer
  baseline is `@deepseek-ai/cordis ~4.0.4` and `@deepseek-ai/dsh-* ^0.2.0-rc.2`;
- nothing else: the `@ast-grep/cli` native binary ships inside the npm dependency, so no
  system `ast-grep` install is needed.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

```bash
# both tools arrive in one command
dsh plugin --profile web add @hy-sde-org/dsh-tool-ast
```

`dsh plugin add` reconciles the profile's bundle list from the installed
`dsh.bundle.patch` export, so after installation the `hy-sde-ast-tool-ast`
row below is immediately active in the named profile.

You can also just depend on the package from your own tooling:

```bash
npm install @hy-sde-org/dsh-tool-ast   # or pnpm add / yarn add
```

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-tool-ast build

AST_TGZ="$(cd dsh-tool-ast/packages/tool-ast && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$AST_TGZ"
```

### Verify

```bash
dsh web --dump-config   # look for the hy-sde-ast-tool-ast row
```

### Run

Start the harness (`dsh web`) and ask the agent to search or rewrite structurally. The
model-facing calls:

- `ast_grep` with `pat: "console.log($MSG)"` and `lang: "TypeScript"` — every
  console.log call, matched by tree shape rather than text, first 100 matches with
  `$MSG` captured per node.
- `ast_edit` with `pat: "console.log($MSG)"`, `rewrite: "log.debug($MSG)"`,
  `path: "src"` — previews every proposed rewrite; re-run with `apply: true` to write
  the files through the fs edit-intent waterfall (version-guarded, observation ledger).

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-tool-ast
```

> **Already shipped?** If a future DeepSeek Harness release adopts structural
> search/rewrite itself, skip installation — adding this bundle on top would
> duplicate the loader row and fail at boot.

## What the bundle does

The plugin's `cordis.patch.yml` mounts **one plain host row**, exactly like
the official harness's own `tool-ast` row in the stock base bundle. It
consumes the deployment's host services — `tools`, `subprocess` (stock base
mounts `@deepseek-ai/dsh-subprocess-local`), `systemPrompt`, and `fs` (stock
base provides `ctx.fs` host-wide via `@deepseek-ai/dsh-fs-sandbox`) — so it
needs no filesystem realm of its own:

- `hy-sde-ast-tool-ast` — `@hy-sde-org/dsh-tool-ast`, registering
  `ast_grep`/`ast_edit` beside the deployment's `read`/`write`/`edit` tools,
  sharing their fs instance, observation ledger, and sandbox policy.

Configure per deployment by patching the row by id:

```yaml
- id: hy-sde-ast-tool-ast
  config:
    astGrepMaxMatches: 200
    astEditMaxHunkBytes: 8000
    timeoutMs: 45000
```

### Pairing with the rich `edit` plugin

Install `@hy-sde-org/dsh-tool-edit` and this bundle together — that is the
verified composition. Neither owns a filesystem realm, they share the host
`ctx.fs`, and their tool sets are disjoint (`ast_grep`/`ast_edit` vs `edit`),
so they compose freely on stock and hy-sde harnesses alike.

## Engine behavior

- **Spawn.** The engine is a subpath of the `@ast-grep/cli` package, resolved
  by `createRequire` from the plugin — the platform binary arrives with
  `pnpm install`, identical to how ripgrep tooling ships.
- **No shell layer.** Every model input (pattern, rewrite, lang, strictness,
  globs, paths) is its own argv element — a hostile pattern stays inert.
- **Strict parse.** `--json=stream` output is parsed line-by-line; a
  malformed line fails the run (`AST_FAILED`) rather than being dropped.
- **Exit semantics.** exit 0 = matches; exit 1 + clean stderr = zero matches;
  exit 1 + stderr = `AST_FIND_ERROR` (bad path); exit 2 = `AST_USAGE_ERROR`;
  else `AST_FAILED`. Cooperative timeout / cancellation → `AST_ABORTED`.
- **Apply is preview-first and version-guarded.** `ast_edit` defaults to
  preview; `apply: true` writes only through the fs edit-intent waterfall
  with the observation/version guard, never a raw engine write.
- **Caps.** All result caps are configurable (see `Config`). The defaults:
  `astGrepMaxMatches` 100, `astGrepMaxNodeBytes` 2000, `astEditMaxHunkBytes`
  4000, `astEditMaxFiles` 200, `searchMetaMaxBytes` 65536, `rawOutputMaxBytes`
  8 MiB, `graceMs` 3000, `stderrMaxBytes` 64 KiB, `timeoutMs` 30000.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (tsc --noEmit)
pnpm -r test       # engine unit tests + real-engine integration suite
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

The test suite runs the REAL packaged ast-grep against real temp files,
exercising `ast_grep`, `ast_edit` preview and apply (observation/version
guard), sandbox denial mapping, and abort classification — no mocks of the
engine.

## Layout

```
packages/tool-ast/   @hy-sde-org/dsh-tool-ast — the plugin (both tools)
  cordis.patch.yml   the installable harness bundle
  src/core.ts        the engine: binary resolution, spawn, argv, JSON parse,
                     error vocabulary
  src/search.ts      the ast_grep tool body
  src/edit.ts        the ast_edit tool body (preview / apply)
```
