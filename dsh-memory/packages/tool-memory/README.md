# @hy-sde-org/dsh-tool-memory

**The model-facing memory surface** for DeepSeek Harness — the six tools
`retain`, `recall`, `reflect`, `memory_edit`, `learn`, and `mine_sessions`
over the host `ctx.memory` service, plus a `memory:project` system-prompt
section that **reloads the session's project memory at the start of every
session**. Ported from the [@oh-my-pi](https://github.com/oh-my-pi) coding-agent
memory surface; storage lives in
`@hy-sde-org/dsh-memory`.

This package is **agent-plane**: it mounts as a preset row and resolves the
host `memory` service, registering no service of its own. It installs as a
standalone plugin for stock DeepSeek Harness (`dsh-v0.1.2-rc.1` and later) —
see `@hy-sde-org/dsh-memory` for the install recipe and the preset example.

## The six tools

- `retain` — store one or more durable facts (user preferences, project
  decisions, architectural choices) for future sessions. Batch related facts;
  entries are self-contained, normalized, and deduplicated.
- `recall` — relevance-ranked search over bank + lessons + summary. Returns
  ids that round-trip through `memory_edit`. Use proactively before questions
  about past decisions or preferences. When a host `sessionQuery` service is
  mounted, past-session hits merge in as a `session` source tier.
- `reflect` — synthesize an answer across many stored memories (blends,
  unlike `recall`). Grounding is memory-only; verify repository facts.
- `memory_edit` — `update` (replace content/importance), `forget` (hard
  delete), `invalidate` (soft supersede, optional `replacement_id`). Lesson
  and summary entries are read-only facts.
- `learn` — capture one durable lesson (what/when/why) into `learned.md`;
  write-path neutralization strips prompt-injection markers and secrets.
- `mine_sessions` — harvest reusable lessons from your own past sessions
  (digests from compaction summaries, failures from turn/end error reasons,
  all-completed todos), stored as `learn` entries with session provenance and
  deduped. Needs a host `sessionQuery` service; without one it reports
  unavailable rather than erroring — this standalone ships the bridge
  (`session-history.ts`, `ctx.get('sessionQuery')` duck-typed) but no session
  backend.

## Prompt injection

`apply()` registers `systemPrompt.section({ name: 'memory:project', order: 150 })`
whose text is evaluated at each assembly and returns the calling session's
project memory — `memory_summary.md` + `learned.md`, combined and head-tail
truncated to `injectionMaxChars` (default 16000 chars) — or `''` for a
project with no memory yet. The session identity comes from
`context.agent.session.header.cwd`, so each project sees its own bank and a
fresh process picks it up on the very first turn.

## Config (the `tool-memory` row)

| Key | Default | Meaning |
|---|---|---|
| `root` | `<harness home>/memories` | Must match the `ctx.memory` row's root. |
| `injectionMaxChars` | `16000` | Combined char budget for the injected summary + lessons. |
| `enabled` | `true` | Set `false` to disable prompt injection while keeping the tools. |

## Tests

```sh
pnpm -r --filter @hy-sde-org/dsh-tool-memory test
```
