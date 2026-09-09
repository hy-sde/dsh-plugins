# @hy-sde-org/dsh-tool-git

Model-facing agentic git tools over the host `ctx.git` service:

- **`commit`** — analyze the current git changes and produce a
  conventional-commit split proposal (read-only; never edits the repo).
- **`commit_apply`** — execute a validated split-commit plan: hunk-aware
  staging, lock-file autoplacement, topological dependency order, cycle
  rejection before any write, atomic per-commit execution, `dryRun` preview.
  `--push` pushes the current named branch (upstream recorded) and is
  released only by a current `review --target staged` ship verdict.
- **`review`** — fan the diff out to parallel reviewer subagents, rank every
  finding P0–P3 with confidence, and aggregate a ship/reject verdict; a
  `staged` review records the verdict consumed by the `commit_apply --push`
  gate.
- **`worktree`** — `acquire` / `release` / `list` / `prune` / `destroy` over
  a persistent pool of isolated git worktrees with durable leases.

Read surfaces (`commit` / `review`) resolve through a host `vcs` service when
one is registered and probing clean, and otherwise degrade to `ctx.git` —
the unpublished `@deepseek-ai/dsh-vcs` is never required.

Plus the `git:tools` system-prompt section. Agent-plane: the package mounts
as a preset row (`inject` = tools, systemPrompt, git) and resolves the host
`git` service; it registers no service of its own.

## Install & mount

```bash
dsh plugin --profile web add @hy-sde-org/dsh-git @hy-sde-org/dsh-tool-git
```

Copy `examples/agent-preset/` to `~/.dsh/.agent-presets/<id>/` and select it
in the Web UI preset picker. The preset row configures
`reviewProvider: spawn` and `maxReviewers: 4`.

## Development

```bash
pnpm install
pnpm run check   # tsc --noEmit
pnpm run build   # tsc -p tsconfig.build.json → dist/
pnpm run test    # vitest (47 tests: commit/review/worktree/push-gate end-to-end on real temp repos)
```
