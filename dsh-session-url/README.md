<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-session-url`](https://www.npmjs.com/package/@hy-sde-org/dsh-session-url)
<!-- MIRROR-NOTE:END -->

# dsh-session-url — session:// scheme for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-session-url`** — the
`session://` internal-URL scheme handler that exposes the harness's own
session history as file-shaped resources for internal-URL-aware `read` and
`grep` tools: directory listings, rendered transcripts, exact per-event JSON,
and FTS-backed cross-session search.

Published **standalone** so any official DeepSeek Harness installation can
mount the scheme without adopting the fork that originally hosted
`@deepseek-ai/dsh-session-url`. The only fork-only dependency of the original
(`@deepseek-ai/dsh-internal-urls`, unpublished in the stock harness) is
**vendored** (types + parse + router, see `src/vendor/internal-urls/`) with a
keep-in-sync marker, so this package compiles and tests with **no unpublished
dependency** — its runtime deps (`@deepseek-ai/dsh-session-query`,
`@deepseek-ai/dsh-session`) are all published.

## Why

Your own session history becomes files: past sessions — transcripts, exact
per-event JSON, listings, FTS search — are read and grepped through the
ordinary internal-URL-aware `read`/`grep` tools, so the model navigates its
own history with the file tools it already has instead of a bespoke
interface.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- DeepSeek Harness `0.1.1-rc.2` or later (per the shipped
  `cordis.patch.yml`: the insert never breaks boot on a stock release from
  that floor on), including the standard `dsh` CLI;
- the `session-url` row stays **dormant** until the process also mounts both
  `ctx.internalUrls` (the internal-URL registry, e.g. the standalone
  `@hy-sde-org/dsh-internal-urls`) and a session-query engine
  (`ctx.sessionQuery`, published `@deepseek-ai/dsh-session-query`) —
  installing this package alone is harmless;
- peers `@deepseek-ai/cordis` `~4.0.4`, `@deepseek-ai/dsh-session`
  `^0.2.0-rc.2`, `@deepseek-ai/dsh-session-query` `^0.2.0-rc.2` — npm
  resolves them on install.

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-session-url
```

The shipped `cordis.patch.yml` inserts the host-plane `session-url` row on
install; it touches no existing row.

### Route B — from source (validate this checkout or hack on the handler)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-session-url build

SESSIONURL_TGZ="$(cd dsh-session-url/packages/session-url && pnpm pack --pack-destination /tmp | tail -n 1)"
dsh plugin --profile web add "$SESSIONURL_TGZ"
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing
`dist/`.

### Verify the composed configuration

```bash
dsh web --dump-config        # the session-url row is present in the base bundle
```

Then smoke-test the scheme through an internal-URL-aware read tool, per the
Use examples: `list session://*` (known sessions, newest first), then
`read session://<id>` for one rendered transcript. Until the registry and a
session-query engine are also mounted, the row reports it is "waiting for"
them instead of serving resources.

### Run

```bash
dsh web
```

Ask the model to navigate its own history as files — the file-shaped
examples are in [Use](#use).

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-session-url
```

The inserted `session-url` row goes with the package; the internal-URL
registry and the session-query engine are separate installs and stay.

## Use

Mount it as a host-plane plugin row next to the internal-URL registry it
extends (`ctx.internalUrls`, provided by the standalone
`@hy-sde-org/dsh-internal-urls`) and require a session-query engine
(`ctx.sessionQuery`, published `@deepseek-ai/dsh-session-query`) — the
shipped `cordis.patch.yml` inserts exactly this row on `dsh plugin add`;
author it by hand only when composing manually:

```yaml
- id: session-url
  name: '@hy-sde-org/dsh-session-url'
```

Then the internal-URL-aware `read` / `grep` tools navigate history as files:

```
read session://0a1b2c3d4e          # rendered transcript
read session://0a1b2c3d4e/event/42 # one exact event as JSON
list session://*                    # known sessions, newest first
grep tsconfig session://0a1b2c3d4e  # grep the transcript
read "session://search?q=tsconfig"  # FTS hits (degrades when search is disabled)
```

Read-only by design: every resource is immutable, sizes are capped (600-event
transcripts / 12 000 for grep / 200-session listings / 128 KiB event JSON),
and the handler performs no filesystem access.

## Development

```bash
pnpm install
pnpm -r check       # strict typecheck (src + tests)
pnpm -r test        # handler + router-integration tests
pnpm -r build       # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## Layout

```
packages/session-url/   @hy-sde-org/dsh-session-url — the session:// scheme
  src/index.ts                       plugin apply: register into ctx.internalUrls
  src/handler.ts                     SessionProtocolHandler (resolve/complete)
  src/vendor/internal-urls/          vendored fork-only internal-urls surface
  tests/handler.spec.ts              13 handler + router-integration tests
```

## License and attribution

This repo is licensed MIT — see [LICENSE](LICENSE) (© 2026 hy-sde). The
`session://` scheme handler (transcript / event-JSON / listing / search
surface and its Cordis `apply`) is derived from the DeepSeek Harness codebase
(MIT, © 2026 DeepSeek), ported from `packages/session-query/session-url`; the
vendored `src/vendor/internal-urls/` surface is likewise DeepSeek Harness
code (the fork-only `@deepseek-ai/dsh-internal-urls`), kept verbatim. The
full provenance is aggregated in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). This is a separately
installable package; the harness remains the property of its own project.
