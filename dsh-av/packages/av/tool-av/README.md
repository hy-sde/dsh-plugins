# @hy-sde-org/dsh-tool-av

Model-facing Automic Vault tools over the host `ctx.av` service, plus an
`av:tools` system-prompt section. The surface is deliberately read-only:
audit the Mac for exposed credentials, verify hardening, inspect the
detector/hardener catalog, and list saved secret names — **never release a
Secret Value into model context**. Ported standalone from the fork-only
`@deepseek-ai/dsh-tool-av` — no upstream harness changes required.

## Tool surface

- `av_scan [severity] [detector] [max_findings]` — full audit; findings carry
  severity, explanation, remediation, affected files/lines, and the detectors
  that produced them. `severity` filters (`high`/`medium`/`low`), `detector`
  narrows to one tool (names from `av_catalog` scope=detectors).
- `av_doctor [tool]` — hardening verification: healthy/issue per hardener
  with remediation and stub/target paths.
- `av_catalog [scope] [max_entries]` — which detectors and hardeners Automic
  Vault knows (names + docs links + hardened/applicable status), so the agent
  can target `av_scan` and `av_doctor` correctly.
- `av_list` — saved secret **names only, never values**.

When the `av` CLI is missing or broken, every tool degrades to a structured
`{ available: false, reason }` value with an installation hint
(`brew install --cask automic-vault/isotopes/automic-vault`) instead of
throwing.

## Security rules

1. No tool output ever contains a Secret Value. `av_list` returns names only;
   scan/doctor/catalog return paths, configs, and advice.
2. Hardening is reported and proposed (`av harden <tool>` as a terminal
   command the user runs); never auto-approved or executed by the agent.
3. Findings and catalog entries are capped (`maxFindings` default 30,
   `maxCatalogEntries` default 60) and summarized.

## Configuration

| config | default | meaning |
|---|---|---|
| `maxFindings` | `30` | cap on `av_scan` findings rendered + returned |
| `maxCatalogEntries` | `60` | cap on catalog entries per scope |
| `enabled` | `true` | set `false` to disable the `av:tools` prompt section |

## Install

Agent-plane: mounts as a preset row and resolves the host `av` service
(no realm/isolate needed). Copy the ready-made preset from
`examples/agent-preset/` into `~/.dsh/.agent-presets/<id>/`.

```bash
pnpm --filter @hy-sde-org/dsh-tool-av test    # end-to-end tool tests over a fake av CLI
pnpm --filter @hy-sde-org/dsh-tool-av build   # tsc -> dist
```
