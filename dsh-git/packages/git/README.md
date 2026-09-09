# @hy-sde-org/dsh-git

Host-plane `ctx.git` service for the DeepSeek Harness: a stateless, thin
wrapper around the `git` CLI through the `ctx.subprocess` seam, plus the
diff-parsing primitives and split-commit execution verbs the model-facing
tools need. Consumed by `@hy-sde-org/dsh-tool-git`; never called by the model
directly.

- `GitService` — `run` / `status` / `diffText` / `diffStat` /
  `stagedFiles` / `resetIndex` / `stageHunks` / `commit` / `log` /
  `currentBranch` / `isWorktree`, plus `push` with remote/branch/upstream
  options and `root` for the review gate.
- `parseFileDiffs` / `parseNumstat` / `computeDependencyOrder` /
  `LOCK_FILES` — pure diff + topo-sort + lock-file primitives.
- `vcs` — TS contract port of omp's native `pi-vcs` surface (error taxonomy,
  repo discovery, newline-safe `joinPatches`, HEAD stat-poll `watch`).
- `withRepoLock` — in-process per-repository mutation queue (`repo-lock`).
- `acquireWorktree` / `releaseWorktree` / `listWorktrees` / `pruneWorktrees`
  / `destroyWorktree` — a durable-lease worktree pool with dry-run safety
  (`worktree`).
- `conventional` — llm-git canonical commit-type vocabulary plus commit
  message normalization / validation (scopes, summaries, bodies, pep-595
  length rules).
- `apply(ctx, config)` registers `ctx.git` (subprocess seam required).

Port of omp (oh-my-pi)'s git layer — see LICENSE. The
service owns no durable state and shells out per call, so one host instance
serves every session; which repo the tools act on comes from the calling
agent's session cwd at call time.

## Install & mount

See the repo `README.md` — as a plugin:

```bash
dsh plugin --profile web add @hy-sde-org/dsh-git
```

The bundle `cordis.patch.yml` inserts the `git` row into the profile's base
composition (stock INSERT patch form, safe on official releases). The tools
mount from any user preset that copies `examples/agent-preset/`.

## Development

```bash
pnpm install
pnpm run check   # tsc --noEmit
pnpm run build   # tsc -p tsconfig.build.json → dist/
pnpm run test    # vitest (89 tests: conventional/repo-lock/vcs/worktree/service/unit on real temp repos)
```
