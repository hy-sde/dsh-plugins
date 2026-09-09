# @hy-sde-org/dsh-tool-openwiki

Model-facing repository wiki lifecycle tools — `openwiki_begin`,
`openwiki_submit_plan`, `openwiki_next_page`, `openwiki_submit_page`,
`openwiki_finish` — that drive the deterministic openwiki 0.4 engine core
(`@hy-sde-org/dsh-openwiki`) **in-process**. The five-tool contract and every
model-facing description match upstream openwiki 0.4, so harness agents run
the same resumable, claim-grounded wiki generation with no external
`openwiki` CLI and with `codebase-memory` for structural discovery.

## Surface

One Cordis agent-plane plugin (mounts as a preset or profile-patch row,
injects `tools` + `systemPrompt`, registers no service of its own):

- `openwiki_begin` — start or resume a durable run (`.run.json`) over a Git
  repository root; returns `status=noop` for clean updates.
- `openwiki_submit_plan` — validate and durably persist the ordered PageJob
  queue; init requires `/openwiki/quickstart.md`, paths are normalized.
- `openwiki_next_page` — first pending job with existing Markdown + Claims.
- `openwiki_submit_page` — complete the current job by proving its complete
  Claim set against the written page (front matter repair then Claims
  resolution and durable verification).
- `openwiki_finish` — deterministic finalization: planned/abandoned
  deletions, Mermaid validation, wiki index sync, link validation, generated
  provenance, Claims finalization + manifest replacement, run metadata, and
  `.run.json` removal.

## Configuration

```yaml
- id: tool-openwiki
  name: '@hy-sde-org/dsh-tool-openwiki'
  config:
    host: harness          # stable host identity recorded in run metadata
    producerActor: harness # provenance actor for engine-owned finalizers
```

## Agent preset

[`examples/agent-preset/`](examples/agent-preset/) is a ready-to-copy DeepSeek
Harness agent preset: the `openwiki:tools` prompt section is registered by
this package, and pairing the row with `@deepseek-ai/dsh-tool-codebase-memory`
gives agents structural discovery on top of the forced lifecycle sequence.

## License

MIT — see the repository [`LICENSE`](../../LICENSE). Tool-level wrappers keep
the upstream openwiki protocol contract and model-facing descriptions
(openwiki 0.4.3, Copyright (c) 2026 langchain-ai, MIT).
