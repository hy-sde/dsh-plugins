# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-memory` persists agent-curated text under
  `<harness home>/memories/<project>/` and applies injection-neutralization
  (control chars, `<`/backticks, `~~~` fences) plus secret-redaction
  (AWS/OpenAI/DeepSeek/full-URL/GitHub-token patterns) on every write and on
  the read of bank/lesson content where the backend re-normalizes. All
  local-file I/O goes through the default Node `fs` module only — no network
  listener is opened, and no remote memory service is contacted.
- A secret that landed in the bank in raw form during a past run would stay
  readable until edited, because redaction is applied at write time and cannot
  retroactively erase what is already on disk; treat memory banks as
  credentials-adjacent and rely on the harness's own credential redaction to
  keep `DEEPSEEK_API_KEY`-style values out of tool calls.
- `@hy-sde-org/dsh-tool-memory` ships no tools that write outside the memory
  store; the five tools call only the host `ctx.memory` service.
