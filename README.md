# dsh-plugins

Monorepo of standalone `@hy-sde-org/dsh-*` plugins for DeepSeek Harness
(working fork: [`deepseek-harness`](https://github.com/hy-sde/deepseek-harness),
upstream `deepseek-ai/deepseek-harness`).

- **Read first:** [`WORKFLOW.md`](./WORKFLOW.md) — standalone-first (B) vs
  fork-first (A), and the build → `file:` verify → publish → `pkg:version` pipeline.
- **Phase 0 recon:** [`scripts/recon/`](./scripts/recon/) — one command turns a
  candidate-repo list into clones + codebase-memory indexes + analysis notes.
- **Publication tracker:** [`plugin-list.txt`](./plugin-list.txt) — published
  versions per plugin + still-to-publish queue.
- **Private plugins:** excluded/never-publish plugins live OUTSIDE this repo, in
  [`dsh-plugins-private`](../dsh-plugins-private) (client UI slots, private API
  controllers). The publish flow blocks them via
  [`scripts/excluded-plugins.list`](./scripts/excluded-plugins.list) —
  see [`WORKFLOW.md`](./WORKFLOW.md) → "Private / never-publish plugins".
- **Release infra:** [`scripts/release-public.sh`](./scripts/release-public.sh)
  (one package) and [`scripts/publish-all.sh`](./scripts/publish-all.sh) (all
  packages in dependency order).

## Plugin catalog

Each row is one *capability*, told as a user story. Rows with several packages
are **atomic groups** — they come from one port (or one engine+tool pair) and
only make sense mounted together; a group row's packages share the same origin
and the same "why". Single-package rows are self-sufficient. Private/never-publish
plugins (client UI, private API controllers) are not here — they live in
[`dsh-plugins-private`](../dsh-plugins-private).

| Capability | Packages | User story | Ported from |
|---|---|---|---|
| [**Parallel orchestration layer**](dsh-orchestration-policy/README.md) | `dsh-orchestration-policy` · `dsh-llm-slots` · `dsh-tool-subagent-report` | You run a multi-agent session on a shared inference endpoint: model-call slots stay predictable (FIFO budget, `ctx.modelSlots`), every continuable child reports findings back before it ends (`report` tool, child-scoped), and work fans out in parallel by default with a fail-closed isolation guard + review-gate posture on pushes. **Only useful together** — three packages, one dispatch profile. | [firstmate](https://github.com/kunchenguid/firstmate) |
| [**Agentic git flow**](dsh-git/README.md) | `dsh-git` (engine: `ctx.git`) · `dsh-tool-git` (model) | The model proposes a conventional commit split for your changes, applies it hunk-aware with log autoplacement and a P2 review gate on push, and works in per-task worktrees with durable leases — commit plan/apply split keeps every step read-only-then-validated. | fork `packages/git/tool-git` |
| [**Long-horizon memory**](dsh-memory/README.md) | `dsh-memory` · `dsh-tool-memory` · `dsh-memory-extraction` | The agent keeps durable project memory across sessions (`retain`/`recall`/`reflect`/`learn`/`memory_edit`, first-turn prompt injection), and `memory-extraction` automatically projects, proposes and commits durable facts at every compaction checkpoint. Full loop = all three. | [oh-my-pi](https://github.com/can1357/oh-my-pi) memory surface |
| [**Rich file editing**](dsh-tool-edit/README.md) | `dsh-hashline` (engine) · `dsh-tool-edit` (model) | The four-mode `edit` tool (replace / patch / apply_patch / hashline) with embedded LSP format-on-write and diagnostics, replacing stock `str_replace_editor` on official releases. `hashline` is the dependency-free patch engine behind the hashline mode and has no standalone value. | [oh-my-pi](https://github.com/can1357/oh-my-pi) |
| [**Internal URL routing**](dsh-internal-urls/README.md) | `dsh-internal-urls` · `dsh-tool-fs-internal-urls` · `dsh-tool-fs-search-internal-urls` | `conflict://`, `pr://`, `issue://` resolve through one registry before the FS is touched, so the normal read/write semantics apply to conflicts, PRs and issues — and grep/glob can search them with ripgrep semantics. | [oh-my-pi](https://github.com/can1357/oh-my-pi) |
| [**Debugging**](dsh-tool-debug/README.md) | `dsh-dap` (engine) · `dsh-tool-debug` (model) | One `debug` tool, 28 operations: launch/attach real debuggers (debugpy, lldb-dap, gdb, dlv, …), source/function/instruction/data breakpoints, continue/step/pause, threads, stack traces, scopes/variables/evaluate, memory read/write. | Debug Adapter Protocol (fork) |
| [**Agentic browser**](dsh-browser/README.md) | `dsh-browser` (engine) · `dsh-tool-browser` (model) | The model opens/closes real browser sessions over CDP (launch with stealth, attach to the user's own Chrome via local relay + companion extension) and reads ARIA snapshots + screenshots. | [oh-my-pi](https://github.com/can1357/oh-my-pi) |
| [**Secret / hardening audit**](dsh-av/README.md) | `dsh-av` (engine) · `dsh-tool-av` (model) | Read-only vault audit: scan for exposed credentials, check hardening, inspect the detector/hardener catalog, list secret *names* — the tool never returns a secret value. | macOS `av` CLI (+ omp-style tooling) |
| [**OpenWiki engine**](dsh-openwiki/README.md) | `dsh-openwiki` (engine) · `dsh-tool-openwiki` (model) | Model-free repository wiki construction: begin → submit plan → next page → submit page → finish, in-process and resumable (durable run/page manifests, Grounded Claims store). The tools are just the lifecycle verbs over the engine. | [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki) 0.4.3 |
| [**Logseq graph**](dsh-logseq/README.md) | `dsh-logseq-graph` (engine) · `dsh-tool-logseq` (model) | Drive a Logseq database headlessly: list/show/search/Datalog-query/upsert/remove plus graph & server lifecycle — a terminal-first alternative to the desktop MCP bridge. | Logseq CLI |
| **Code kernels** | `dsh-code-runtime-kernels` | Persistent Python/JS kernels with session state that survives across calls — `run_kernel_code` with state snapshots, magics/`await` support. Already mounted in the `cordis-plus` preset. | DSH |
| **Structural code tools** | `dsh-tool-ast` | `ast_grep` structural search + `ast_edit` structural rewrite over the packaged native ast-grep engine (AST-aware, not text). | ast-grep (fork) |
| **Codebase memory** | `dsh-tool-codebase-memory` | One-shot codebase-memory queries (`index_repository`, `search_graph`, `query_graph`, `trace_path`, …) against the local codebase-memory daemon — the same daemon the stdio MCP client fronts. | codebase-memory CLI |
| **Library search** | `dsh-tool-library-search` | Free "has this already been built?" across npm/crates.io/Maven/Go/PyPI/RubyGems + GitHub — exact-name ranked, stars/downloads as fitness signals, no API key. *(still unpublished)* | DSH |
| **Session health** | `dsh-session-intelligence` | `session_health`: how did past sessions actually go — outcome classification (with confidence), A–F grading with per-signal penalties, tool-health and context-pressure signals. | DSH |
| **Stream rules** | `dsh-stream-rules` | Time-traveling behavioral guard: project rules stay dormant until a regex matches the live token stream, then the request aborts, the rule is injected as a system reminder and retried from the same point. | [oh-my-pi](https://github.com/can1357/oh-my-pi) |
| **VCS surfaces** | `dsh-vcs` | `ctx.vcs`: narrow read-only VCS over the user-installed pi-vcs CLI — rev/staged/worktree diffs with `--name-only`/`--numstat`, status counts, branch detection, HEAD info. | pi-vcs (native CLI) |
| **Session URL scheme** | `dsh-session-url` | `session://` handler: your own session history becomes files — list sessions, rendered transcripts, exact event JSON, FTS cross-session search via internal-URL-aware read/grep. Optional companion to internal-URL routing. | DSH |
| **Credential-free web search** | `dsh-web-search-public` | One `web_search` call fans out to Startpage/DuckDuckGo/Ecosia/Google/Mojeek in parallel, merges by consensus, respects soft/hard deadlines — zero API keys. | DSH |
| **Zstd frames** | `dsh-zstd-frame` | Zstandard frame primitives (scan / compress / decompress / multi-frame decoder) shared by the session persistence backend (`session.jsonl.zstd`) and project memory bank (`bank.jsonl.zstd`). | DSH |
| **Archive engine** | `dsh-fs-archive` | Pure-TS multi-format archive library — zip/tar/tar.gz/rar/7z/iso/deb/rpm/cpio/cab/arj/asar plus codecs (gzip, bzip2, LZW, xz, deflate, zstd). | [oh-my-pi](https://github.com/can1357/oh-my-pi) `pi-utils` |

## Layout

```
dsh-<plugin>/                container dir (private root package, docs, tests)
  packages/<pkg>/            publishable package → npm @hy-sde-org/dsh-<name>
dsh-web-search-public/       flat package (publishes from its root)
scripts/                     shared infra: recon, release guards, publish runner
```

One git repo, one pnpm workspace (`pnpm-workspace.yaml` — all publishable
`@hy-sde-org/dsh-*` packages, including nested members like
`dsh-git/packages/git/tool-git`), one lockfile. The previous per-plugin git repos
are archived under `~/.dsh/archives/dsh-plugins-git/`.

## Typical commands (from the root)

```bash
pnpm install                 # one install for everything (native builds whitelisted)
pnpm -r check                # typecheck all packages
pnpm -r test                 # run every package's tests
pnpm -r build                # build every package
bash scripts/publish-all.sh --check     # validate all packages, no publishing
bash scripts/publish-all.sh --publish   # publish in dependency order (prompts each)
bash scripts/release-public.sh dsh-vcs/packages/vcs --check   # one package
```

Intra-monorepo dependencies use `workspace:^` — pnpm rewrites them to the real
version ranges on `pnpm publish` (never use bare `npm publish`, it leaks
`workspace:^` into the tarball).
