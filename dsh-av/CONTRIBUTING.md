# Contributing

Thanks for helping with `dsh-av`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-av` beyond its
  declared peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-subprocess`) and
  no new `@deepseek-ai` dependencies for `@hy-sde-org/dsh-tool-av` beyond
  its declared peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-system-prompt`,
  `@deepseek-ai/dsh-tools`, `@hy-sde-org/dsh-av`). Runtime Node builtins are
  fine (the host runs Node).
- **The surface stays read-only.** The service must never gain a verb that
  releases a stored Secret Value into model context or argv (`av inject` /
  `av proxy` / `av save` / `av harden` stay human-in-the-loop), and the
  tools must never auto-approve or run hardening.
- **Keep the subprocess boundary hard.** New verbs go through the existing
  bounded runner (argv arrays, cwd, caps, timeout, grace) — never a shell
  string, never an unbounded stdout.
- Preserve the module JSDoc contract names (`@module @hy-sde-org/dsh-av/...`,
  `@module @hy-sde-org/dsh-tool-av/...`).

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of both packages
pnpm -r test       # av service + tool-av tests
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish av then tool-av
```
