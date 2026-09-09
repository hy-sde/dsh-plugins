# @hy-sde-org/dsh-tool-fs-internal-urls

The `read` / `write` / `edit` filesystem tool suite for DeepSeek Harness with
**internal-URL routing built in**: when `ctx.internalUrls` is mounted, these
tools resolve `conflict://`, `pr://`, `issue://` URLs (and `<path>:conflicts`
selectors) through the registry instead of a filesystem path, and scan plain
filesystem reads for git conflict blocks — registering them with the session
history and appending a resolution notice. This is the hy-sde fork's
`dsh-tool-fs` (with `src/internal-routing.ts` + the `read.ts`/`write.ts`
hunks) shipped as an agent-scope shadow so it works on **stock** DeepSeek
Harness releases (`dsh-v0.1.2-rc.1` and later).

Mount it in an agent preset (see `examples/agent-preset/` in
`@hy-sde-org/dsh-internal-urls`): agent-scope shadowing makes these THE
`read`/`write`/`edit` for that session, while plain filesystem behavior is
identical to the stock tools. Without a mounted `ctx.internalUrls` registry
the routing branch never triggers and the tools are stock-equivalent.

- `read` — line-numbered windows (caps: `readLimit` 2000 lines,
  `readMaxLineLength` 2000 chars, `readMaxBytes` 50 KiB, stream threshold
  10 MiB), `fs/observed` emission, internal-URL virtual reads, conflict
  surfacing + notice.
- `write` — create/overwrite with sandbox-policy escalation
  (`fs/write-intent` waterfall, error remediation). Internal-URL writes
  (`conflict://<N>` resolution) dispatch to the handler with the session
  context and the resolved policy so the backing-file splice stays fenced.
- `edit` — literal single-match (or replace-all) edits over `ctx.fs` with
  guard + remediation, unchanged from the harness (this package keeps the
  trio together).
- `read_image` — registers only while `attachments` is mounted, unchanged.

## Install

As a routing surface this package is useless without
`@hy-sde-org/dsh-internal-urls`; follow that package's README — all three
packages install together:

```bash
dsh plugin --profile web add @hy-sde-org/dsh-internal-urls \
  @hy-sde-org/dsh-tool-fs-internal-urls \
  @hy-sde-org/dsh-tool-fs-search-internal-urls
```

Then copy the preset from `packages/internal-urls/examples/agent-preset/` in
this repo (or the installed package) to `~/.dsh/.agent-presets/<id>/` — its
`tool-fs-internal-urls` row is this package.

## Defaults & caps

| Key | Default | Meaning |
|---|---|---|
| `readLimit` | `2000` | lines per `read` call |
| `readMaxLineLength` | `2000` | chars per returned line |
| `readMaxBytes` | `50 KiB` | bytes of selected output |
| `readStreamMinSize` | `10 MiB` | stream files at/above this size |
| `enableEdit` | `true` | set `false` to leave `edit` to another provider |
