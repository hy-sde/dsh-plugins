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
- **Release infra:** [`scripts/release-public.sh`](./scripts/release-public.sh)
  (one package) and [`scripts/publish-all.sh`](./scripts/publish-all.sh) (all
  packages in dependency order).

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
