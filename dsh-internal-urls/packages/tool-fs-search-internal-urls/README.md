# @hy-sde-org/dsh-tool-fs-search-internal-urls

The `glob` / `grep` discovery tool suite for DeepSeek Harness with
**internal-URL grep routing**: when `ctx.internalUrls` is mounted, `grep` can
search a `conflict://`, `pr://`, or `issue://` resource with the same ripgrep
semantics as a filesystem grep (a `sourcePath`-backed resource is searched on
disk; a purely virtual resource is materialized to a per-call temp file,
searched, and removed — the reported path is always the URL). This is the
hy-sde fork's `dsh-tool-fs-search` (with the `src/grep.ts` routing hunks)
shipped as an agent-scope shadow so it works on **stock** DeepSeek Harness
releases (`dsh-v0.1.2-rc.1` and later).

Mount it in an agent preset (see `examples/agent-preset/` in
`@hy-sde-org/dsh-internal-urls`), beside
`@hy-sde-org/dsh-tool-fs-internal-urls`. Without a mounted `ctx.internalUrls`
registry the routing branch never triggers and `grep`/`glob` are
stock-equivalent (`@vscode/ripgrep` ships inside this npm dependency, so no
system `rg` install is required).

- `grep` — ripgrep `--json` parsing, 50-match inline pages with a
  continuation cursor (pass it back unchanged with the same pattern/path/
  include), git-dirty files ranked first (`[M in git]` headers) and shown
  workdir-relative, grouped by file, with spill recovery for the complete
  result. Also searches internal URL resources (`path: 'conflict://3'`,
  `'pr://owner/repo/123/diff'`, …).
- `glob` — pattern discovery with over-cap sampling, unchanged from the harness.

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
`tool-fs-search-internal-urls` row is this package.

## Defaults & caps

| Key | Default | Meaning |
|---|---|---|
| `grepMaxMatches` | `50` | page size: flat matches retained inline per call; later matches ride the continuation cursor |
| `grepMaxLineBytes` | `2000` | bytes per matched-line preview |
| `grepGitRank` | `true` | one `git status` probe per call ranks git-dirty files first and annotates them `[M in git]` |
| `searchMetaMaxBytes` | `64 KiB` | serialized presentation meta cap |
| `rawOutputMaxBytes` | `20 MiB` | raw `rg` stdout parse cap |
| `graceMs` | `3000` | terminate grace for the search process |
| `stderrMaxBytes` | `64 KiB` | retained `rg` stderr tail |
| `timeoutMs` | `30000` | cooperative tool-call budget |
| `sampleOverCapGlobResults` | _(required)_ | page over-cap glob results across top-level entries |
