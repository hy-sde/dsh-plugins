# dsh-memory — durable project memory for DeepSeek Harness

Three standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-memory` | the plugin: host-plane `ctx.memory` service + shipped `local` backend (bundle row + preset example) | yes |
| `@hy-sde-org/dsh-tool-memory` | the model-facing tools (`retain` / `recall` / `reflect` / `memory_edit` / `learn`) + first-turn prompt injection | yes |
| `@hy-sde-org/dsh-memory-extraction` | automatic memory extraction at compaction checkpoints (host row; additive to the explicit memory surface) | optional |

This is the oh-my-pi agent-memory surface, ported onto the harness
`ctx.memory` service contract as a **standalone
plugin with zero upstream harness changes**: the service row ships as a
`cordis.patch.yml` bundle, the tool row ships as a ready-to-copy agent
preset, and every `@deepseek-ai` dependency resolves from the npm registry at
the `0.1.2-rc.1` baseline — so it installs on official DeepSeek Harness
releases (`dsh-v0.1.2-rc.1` and later) exactly as it runs in the hy-sde fork.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-memory @hy-sde-org/dsh-tool-memory
```

Then copy the preset from `packages/memory/examples/agent-preset/` to
`~/.dsh/.agent-presets/<id>/` and select it in the Web UI preset picker:

```bash
mkdir -p ~/.dsh/.agent-presets/my-memory
cp packages/memory/examples/agent-preset/agent.cordis.yml \
   packages/memory/examples/agent-preset/preset.yml \
   ~/.dsh/.agent-presets/my-memory/
```

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-memory.git
cd dsh-memory
pnpm install
pnpm run build

MEMORY_TGZ="$(cd packages/memory && pnpm pack --silent --pack-destination /tmp)"
TOOLMEMORY_TGZ="$(cd packages/tool-memory && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$MEMORY_TGZ" "$TOOLMEMORY_TGZ"
```

### Verify

```bash
dsh web --dump-config        # the memory row is present in the base bundle
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-memory
dsh plugin --profile web remove @hy-sde-org/dsh-tool-memory
# remove the preset directory you copied from examples/agent-preset/ as well
```

## What the bundle does

`@hy-sde-org/dsh-memory`'s `cordis.patch.yml` inserts exactly one row into
the profile composition on install:

- `memory` → `@hy-sde-org/dsh-memory` — the host-plane `ctx.memory` service
  (durable project-scoped store crossing sessions).

It touches **no existing row**, so `dsh plugin add` never breaks boot on a
stock release. The agent-plane `tool-memory` row is not inserted anywhere; it
lives in the copied preset (`examples/agent-preset/`) beside your other
preset rows, resolving the host service across the plane boundary.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of both packages
pnpm -r test       # 42 tests (29 memory + 13 tool)
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish memory then tool-memory
```

## Layout

```
packages/memory/       @hy-sde-org/dsh-memory — the service bundle
  cordis.patch.yml        the installable bundle (host row)
  examples/agent-preset/  the ready-to-copy preset (tool row)
packages/tool-memory/  @hy-sde-org/dsh-tool-memory — the tools + prompt section
```
