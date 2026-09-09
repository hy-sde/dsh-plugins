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

## Install

```bash
pnpm add @hy-sde-org/dsh-session-url
# or: npm install @hy-sde-org/dsh-session-url
```

Node `>=22.19.0`.

## Use

Mount it as a host-plane plugin row next to the internal-URL registry it
extends (`ctx.internalUrls`, provided by the standalone
`@hy-sde-org/dsh-internal-urls`) and require a session-query engine
(`ctx.sessionQuery`, published `@deepseek-ai/dsh-session-query`):

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
