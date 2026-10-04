# Plugin README template

Every plugin README in this repo follows one structure — current and future.
Canonical reference: [dsh-web-search-public/README.md](../dsh-web-search-public/README.md);
near-conformers: [dsh-tool-edit](../dsh-tool-edit/README.md), [dsh-internal-urls](../dsh-internal-urls/README.md).
WORKFLOW.md's package checklist says which files a package ships; this doc is
the README content standard.

Two sanctioned variants:

- **Harness plugin** (default) — ships a `cordis.patch.yml` bundle row,
  installed with `dsh plugin add`.
- **npm library** — ships no bundle row; the `dsh` CLI routes are explicitly
  n/a. References: [dsh-llm-slots](../dsh-llm-slots/README.md),
  [dsh-zstd-frame](../dsh-zstd-frame/README.md),
  [dsh-fs-archive](../dsh-fs-archive/README.md).

## Harness plugin skeleton

Copy-pasteable; the HTML comments give each slot's purpose — delete them as
you fill the slots in. Plugin-specific sections (the model:
dsh-web-search-public's `## How the fan-out works`) go after `## What the bundle does`.

````markdown
<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/<package>`](https://www.npmjs.com/package/@hy-sde-org/<package>)
<!-- MIRROR-NOTE:END -->

# <name> — <one-line purpose> for DeepSeek Harness

<!-- Intro: what it is, in 1–3 sentences. -->

| Identity | Value |
| --- | --- |
| Package | `@hy-sde-org/<package>` |
| Plugin id | `<plugin-id>` |
| <Seam> id | `<seam-id>` |
<!-- One row per seam: provider id, tool id, service id, … -->

> **Based on [<upstream>](<upstream-url>)** — what was ported, how it is
> adapted to the DeepSeek Harness seam, and the upstream license; see
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why
<!-- The problem this solves; why it exists in this shape. -->

## Prerequisites
<!-- Node/pnpm/DeepSeek Harness versions, then the install-them commands. -->

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/<package>
```

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
PACKAGE_TARBALL="$(pnpm pack | tail -n 1)"
dsh plugin --profile web add "$PWD/$PACKAGE_TARBALL"
cd ..
```

### Verify the composed configuration

```bash
dsh web --dump-config
```

### Run

```bash
dsh web
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/<package>
```

## What the bundle does
<!-- The rows cordis.patch.yml inserts or patches — and what it deliberately does not touch. -->

## Configuration
<!-- Option table (Option | Default | Purpose) plus a yaml example of the plugin row's config:. -->

## Errors
<!-- The seam error codes this plugin surfaces (Code | Meaning). -->

## Privacy and security notes
<!-- Credentials handled, data sent off-host, fetch/SSRF posture. -->

## Compatibility
<!-- Node.js, DeepSeek Harness peer range, the seam contract implemented. -->

## Development
<!-- check / test / build / release-public.sh commands. -->

## License and attribution
<!-- Package license; upstream license + copyright holders; link LICENSE and THIRD-PARTY-NOTICES.md. -->
````

## Variant: npm library

For a package with no `cordis.patch.yml`/plugin row — a library consumed
from code. Keep MIRROR-NOTE, title, intro, based-on blockquote, and
Development, then replace the Quick start block with:

- **`## Install`** — `pnpm add @hy-sde-org/<package>` (or `npm install`)
  plus a one-line Node/peers note, and the dsh routes marked n/a: "this
  package ships no bundle row; there is nothing for `dsh plugin add` to mount."
- **`## Use`** — a fenced `ts` block with the real import and a minimal call.
- From-source build lives under `## Development` (`git clone` →
  `pnpm install` → `pnpm -r build`); no Route A/B, no Verify/Run/Uninstall.

## MUST-STATE for ported plugins

Every README porting third-party code states, in the based-on blockquote or
`## License and attribution`:

1. the **upstream project and its license**, with copyright holders;
2. whether it is a **faithful port** or **adapted** — and if adapted, what changed;
3. **why** the adaptation exists — the harness seam contract, the
   `@hy-sde-org` npm scope, a zero-upstream-changes constraint, a runtime
   move (Bun → Node), or similar.

Don't stop at linking the repo — name the mechanism. Model:
dsh-web-search-public/README.md — "a faithful port of oh-my-pi's parallel
`searchPublicWeb` aggregate …, adapted to the DeepSeek Harness `ctx.web` seam."

## Compliance checklist

Grep gates — all must pass:

- [ ] **What:** intro bolds the package (`**\`@hy-sde-org/…\`**`); the identity table has `Package` and `Plugin id` rows.
- [ ] **Why:** `^## Why` heading present.
- [ ] **Prereqs:** `## Prerequisites` present, naming a Node version and a DeepSeek Harness version.
- [ ] **Quick start:** `## Quick start` with `### Route A`, `### Route B`, `### Verify`, `### Run`, `### Uninstall` (harness plugin) — or `## Install` + `## Use` with the dsh routes marked n/a (npm library).
- [ ] **Attribution + license:** `Based on`/"ported from" blockquote present; `## License and attribution` links `](LICENSE)` and `](THIRD-PARTY-NOTICES.md)`.
- [ ] **Ported tradeoffs:** upstream + license, `faithful`/`adapted`, and the why — all present.
- [ ] Hygiene: install commands spell `pnpm pack`, never `ppnpm pack`; the verify command is exactly `dsh web --dump-config`.
