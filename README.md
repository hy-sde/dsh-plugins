# dsh-plugins

Standalone plugin collection for DeepSeek Harness (working fork:
`deepseek-harness`, upstream `deepseek-ai/deepseek-harness`).

- **Read first:** [`WORKFLOW.md`](./WORKFLOW.md) — standalone-first (B) vs
  fork-first (A), and the build → `file:` verify → publish → `pkg:version` pipeline.
- **Phase 0 recon:** [`scripts/recon/`](./scripts/recon/) — one command turns a
  candidate-repo list into clones + codebase-memory indexes + analysis notes.
- **Publication tracker:** [`plugin-list.txt`](./plugin-list.txt) — published
  versions per plugin + still-to-publish queue.

Each `dsh-*/` directory is a monorepo: root `package.json` is `private: true`, and
the publishable package is `packages/<name>/` → npm `@hy-sde-org/dsh-<name>`.
