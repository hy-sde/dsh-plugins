# dsh-av — read-only Automic Vault (av) service + tools for DeepSeek Harness

Two standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-av` | the plugin: host-plane `ctx.av` read-only Automic Vault CLI service (bundle row + preset example) | yes |
| `@hy-sde-org/dsh-tool-av` | the model-facing `av_scan` / `av_doctor` / `av_catalog` / `av_list` tools + `av:tools` prompt section | yes |

This ports the fork's `@deepseek-ai/dsh-av` + `@deepseek-ai/dsh-tool-av`
(the Automic Vault audit/hardening surface) onto the harness service seam as
a **standalone plugin with zero upstream harness changes**: the service row
ships as a `cordis.patch.yml` bundle, the tool row ships as a ready-to-copy
agent preset, and every `@deepseek-ai` dependency resolves from the npm
registry at the `0.1.2-rc.1` baseline — so it installs on official DeepSeek
Harness releases (`dsh-v0.1.2-rc.1` and later) exactly as it runs in the
hy-sde fork.

## The surface

- **`ctx.av` service** — resolves the `av` executable (config →
  `DSH_AV_PATH` → PATH), probes it once per call with `av --version`, and
  parses the JSON surfaces `av scan --json`, `av doctor [tool] --json`,
  `av detectors --json`, `av hardeners --json`, plus `av list` (secret
  **names only** — a hard limit). It never invokes the value-releasing verbs
  (`av inject` / `av proxy` / `av save` / `av harden`): those stay
  human-in-the-loop in a terminal the user controls.
- **`av_scan`** — audit the Mac for exposed credential configurations and
  hazards: findings carry severity, explanation, remediation, affected
  files/lines, and the detectors that produced them. Filter by `severity` and
  `detector` (names from `av_catalog`), cap with `max_findings`.
- **`av_doctor`** — hardening verification: healthy/issue per installed tool
  with the remediation step and stub/target paths.
- **`av_catalog`** — which detectors and hardeners Automic Vault knows
  (names + docs links + hardened/applicable status), so the agent can target
  `av_scan` and `av_doctor` correctly.
- **`av_list`** — saved secret **names only, never values**.

When the `av` CLI is missing or broken, every tool degrades to a structured
`{ available: false, reason }` value with an installation hint
(`brew install --cask automic-vault/isotopes/automic-vault`) instead of
throwing.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-av @hy-sde-org/dsh-tool-av
```

Then copy the preset from `packages/av/av/examples/agent-preset/` to
`~/.dsh/.agent-presets/<id>/` and select it in the Web UI preset picker:

```bash
mkdir -p ~/.dsh/.agent-presets/my-av
cp packages/av/av/examples/agent-preset/agent.cordis.yml \
   packages/av/av/examples/agent-preset/preset.yml \
   ~/.dsh/.agent-presets/my-av/
```

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-av build

AV_TGZ="$(cd dsh-av/packages/av/av && ppnpm pack --silent --pack-destination /tmp)"
TOOLAV_TGZ="$(cd dsh-av/packages/av/tool-av && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$AV_TGZ" "$TOOLAV_TGZ"
```

### Verify

```bash
dsh web --dump-config        # the av row is present in the base bundle
```

### Uninstall

Remove the `av` row from the base bundle and the `tool-av` row from any
preset that mounts it, then remove the packages:

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-av @hy-sde-org/dsh-tool-av
```

## Project layout

```
packages/av/av/            @hy-sde-org/dsh-av — the ctx.av service
  cordis.patch.yml         host-bundle insert row (stock INSERT form)
  examples/agent-preset/   ready-to-copy user preset (tool row + config)
  src/                     index.ts / service.ts / types.ts
  tests/                   fake-av-CLI service tests
packages/av/tool-av/       @hy-sde-org/dsh-tool-av — the model tools
  src/                     av.ts / index.ts / prompt.ts
  tests/                   end-to-end tool tests over a fake av CLI
```

## Development

```bash
pnpm install
pnpm run check          # tsc --noEmit on both packages
pnpm run build          # tsc -p tsconfig.build.json per package
pnpm run test           # vitest (15 av-service + 11 tool tests over a fake av CLI)
pnpm run release:check  # build + clean-tree + pack guard before publishing
```

## License

MIT — see `LICENSE`. Derived from DeepSeek Harness
(https://github.com/deepseek-ai/deepseek-harness), MIT License,
Copyright (c) 2026 DeepSeek — see `THIRD-PARTY-NOTICES.md`. The Automic
Vault `av` CLI is an external tool, never bundled.
