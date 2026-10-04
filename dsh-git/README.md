<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-git`](https://www.npmjs.com/package/@hy-sde-org/dsh-git) · [`@hy-sde-org/dsh-tool-git`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-git)
<!-- MIRROR-NOTE:END -->

# dsh-git — agentic git commit + review for DeepSeek Harness

Two standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-git` | the plugin: host-plane `ctx.git` service (bundle row + preset example) + `vcs`/`repo-lock`/`worktree`/`conventional` layers | yes |
| `@hy-sde-org/dsh-tool-git` | the model-facing tools (`commit` / `commit_apply` / `review` / `worktree`) + `git:tools` prompt section | yes |

This is the oh-my-pi agentic git commit + review surface, ported onto the
harness `ctx.git` service
contract as a **standalone plugin with zero upstream harness changes**: the
service row ships as a `cordis.patch.yml` bundle, the tool row ships as a
ready-to-copy agent preset, and every `@deepseek-ai` dependency resolves from
the npm registry at the `0.2.0-rc.2` baseline — so it installs on official
DeepSeek Harness releases (`dsh-v0.2.0-rc.2` and later) exactly as it runs in
the hy-sde fork.

## Why

Hand-rolled git hygiene loses to the machinery: messages drift out of
conventional style, hunks get staged from memory instead of against the
real diff, a broken split is discovered only after the commits exist, and
pushes go out with no review at all. This plugin makes the flow
model-driven but validated end to end: `commit` is read-only analysis that
proposes a conventional `SplitCommitPlan` (per-file counts, bounded diff,
lock-file hints, a 22-type canonical vocabulary), and `commit_apply` writes
nothing until that plan validates — every staged file covered exactly once,
hunk selectors checked against the real diff, dependencies resolved
topologically with cycles rejected up front — and resets the index on any
failure, so nothing is lost. `review` fans the diff out to read-only
reviewer subagents that return P0–P3-ranked findings with a ship/reject
verdict, and under a `review-gated` posture that verdict is the only thing
that releases `commit_apply --push`.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- DeepSeek Harness `0.2.0-rc.2` or newer including the standard `dsh` CLI —
  the package's `@deepseek-ai/*` peer range is `^0.2.0-rc.2`
  (`@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-subprocess`;
  `@deepseek-ai/cordis` pins `~4.0.4`);
- `git` on `PATH` — the service is a stateless wrapper over the `git` CLI
  (diff capture/parsing, hunk staging, commit/push/log).

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
dsh --version
```

## The surface

- **`commit`** — read-only analysis of the current git changes: staged (or
  auto-staged working) tree, per-file add/delete counts, bounded diff text,
  lock-file hints, and a suggested conventional-commit split-plan skeleton
  (22-type llm-git canonical vocabulary). The model authors a precise
  `SplitCommitPlan` and passes it to `commit_apply`.
- **`commit_apply`** — validate-then-execute: every staged file must be
  covered exactly once, lock files are placed automatically on the group
  owning their sibling manifest, hunk selectors are validated against the
  real diff, dependencies are resolved topologically (cycles rejected
  **before** anything is written), and each commit is created atomically in
  dependency order. Any failure resets the index — nothing is lost.
  `--push` pushes the current named branch to `origin` with upstream
  recording, and is released by the P2 review gate (`review --target staged`)
  only — a `reject`, missing, or identity-stale verdict refuses the push.
- **`review`** — parallel code review over git changes (working tree, staged,
  or a commit range) with dedicated reviewer subagents. Every finding is
  ranked **P0–P3** with a confidence score; the tool returns all findings
  sorted by severity plus a ship/reject verdict. Reviewers are read-only and
  never edit files or run builds. A `staged` review records the verdict that
  releases `commit_apply --push` under a `review-gated` posture.
- **`worktree`** — a persistent pool of isolated per-task git worktrees with
  durable leases (firstmate/treehouse model): `acquire` (named `--branch`
  support for PR/push flows), `release` (lease-checked, dirty/leased slots
  refused), `list`, `prune`, and `destroy` with dry-run defaults. Pass the
  lease `path` as a subagent task's workspace and `release` when it settles.

## Install

### Direct from npm (published)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-git @hy-sde-org/dsh-tool-git
```

Then copy the preset from `packages/git/examples/agent-preset/` to
`~/.dsh/.agent-presets/<id>/` and select it in the Web UI preset picker:

```bash
mkdir -p ~/.dsh/.agent-presets/my-git
cp packages/git/examples/agent-preset/agent.cordis.yml \
   packages/git/examples/agent-preset/preset.yml \
   ~/.dsh/.agent-presets/my-git/
```

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-git build

GIT_TGZ="$(cd dsh-git/packages/git && pnpm pack --pack-destination /tmp | tail -n 1)"
TOOLGIT_TGZ="$(cd dsh-git/packages/git/tool-git && pnpm pack --pack-destination /tmp | tail -n 1)"
dsh plugin --profile web add "$GIT_TGZ" "$TOOLGIT_TGZ"
```

### Verify

```bash
dsh web --dump-config        # the git row is present in the base bundle
```

### Uninstall

Remove the `git` row from the base bundle and the `tool-git` row from any
preset that mounts it, then remove the packages:

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-git @hy-sde-org/dsh-tool-git
```

## Project layout

```
packages/git/              @hy-sde-org/dsh-git — the ctx.git service
  cordis.patch.yml         host-bundle insert row (stock INSERT form)
  examples/agent-preset/   ready-to-copy user preset (tool row + config)
  src/                     service + diff/topo-sort/lock-files/vcs/repo-lock/
                           worktree + conventional/ primitives
  tests/                   unit + real-repo integration tests
packages/git/tool-git/     @hy-sde-org/dsh-tool-git — the model tools
  src/                     commit.ts / review.ts / worktree.ts / push-gate.ts /
                           reads.ts / prompt.ts
  tests/                   commit + review + worktree + push-gate end-to-end tests
```

## Development

```bash
pnpm install
pnpm run check          # tsc --noEmit on both packages
pnpm run build          # tsc -p tsconfig.build.json per package
pnpm run test           # vitest (89 git-service + 47 tool tests on real temp repos)
pnpm run release:check  # build + clean-tree + pack guard before publishing
```

## License and attribution

This package is licensed MIT — the same license as its upstream
[oh-my-pi](https://github.com/can1357/oh-my-pi). The agentic git commit +
review surface is ported from oh-my-pi (MIT License, © Mario Zechner 2025,
© Can Bölük 2025-2026); the upstream copyright holders are recorded in
LICENSE next to this package's own notice, and the upstream notice text is
reproduced in full in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
