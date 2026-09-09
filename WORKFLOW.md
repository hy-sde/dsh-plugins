# Plugin development workflow in dsh-plugins

Read this first whenever we harvest a capability into the harness. It records the
decision between **standalone-first (option B)** and **fork-first (option A)**,
and the exact pipeline from a cloned candidate repo to a published plugin.

Reference layout:

| Where | What |
|---|---|
| `/Users/hui/Documents/github/deepseek-harness` | the working fork (upstream: `deepseek-ai/deepseek-harness`, already indexed in codebase-memory as `deepseek-harness`) |
| `/Users/hui/Documents/github/dsh-plugins/<plugin>/` | one **monorepo** per plugin: root `package.json` is `private: true`; the publishable package is `packages/<name>/` → npm `@hy-sde-org/dsh-<name>` |
| `scripts/release-public.sh` (per plugin repo) | `--check` / `--publish` release guard |
| `plugin-list.txt` | publish queue / order |
| `scripts/recon/` | **Phase 0 recon harness** (clone → index → analysis notes) |

---

## The decision rule

> **Does the capability have a life outside the harness?**
> - **Yes → standalone-first (B).** Build it as a dsh-plugins package, wire it into
>   the fork via `file:`, verify for real in the harness, then publish and switch
>   the fork to `pkg:version`.
> - **No → fork-only (A, no backport).** It lives in the fork (a built-in tool,
>   client slot/theme, web-app host plugin, or something bound to fork-private
>   types with no stable public API). Don't manufacture a standalone package for it.
> - **Later maybe → fork-first, backport when stable.** Only for capabilities whose
>   shape is still being decided by the fork (e.g. reference implementation lives in
>   `packages/client/*`); fork it out to dsh-plugins once the API settles.

## Option A vs B

| | A: fork-first → backport | B: standalone-first → `file:` → publish |
|---|---|---|
| When | capability is intrinsic to the fork; API not yet stable | capability is generic; has its own consumers/tests |
| Dev loop | fast (types in-tree), but built twice — fork package then extraction | plugin's own `check/test/build` is the fast loop; harness loop is heavier |
| Integration risk | discovered during backport (late) | discovered in Phase 2 (early, in the real harness) |
| Source of truth | fork until backport, then **two copies drift** | single repo (`dsh-plugins/<plugin>/`) from day one |
| Cost of wrong choice | backport is effectively a rewrite against changed interfaces | plugin may over-abstract; extra harness wiring before it's real |

Observed state that confirms B as the default: the fork already consumes
`@hy-sde-org/dsh-code-runtime-kernels` and `@hy-sde-org/dsh-session-intelligence`
via `file:` deps in `apps/cli/package.json`, and the local stand-ins that remain
(`orchestration-policy.ts` in tool-git, the structural `VcsService`) are all
destined to be deleted once their standalone packages are published.

---

## Phase 0 — Recon: clone → inventory

```bash
bash scripts/recon/recon.sh            # one command (see scripts/recon/README.md)
```

- shallow-clones each registry entry into `$HSR_HOME/repos/<name>`
- indexes it into codebase-memory as `harvest-<name>` (full mode)
- scaffolds `$HSR_HOME/analysis/<name>.md` (status/verdict table in `inventory.md`)

Then explore **before** building: per repo, fill the analysis note (capability
inventory, integration surface, license, duplication check, verdict). Fan out one
isolated task per repo — exploration is knowledge work, it doesn't touch the fork.

## Phase 1 — Build standalone-first (option B)

Create the plugin in `/Users/hui/Documents/github/dsh-plugins/<plugin>/` following
the existing convention:

- monorepo shell: root `private: true`, `packages/<name>/` = publishable package
  (`@hy-sde-org/dsh-<name>`), `pnpm-workspace.yaml`, `tsconfig.base.json`
- package shape: `exports` mapping `types → lib/types/index.d.ts`,
  `default → lib/index.js`, plus `"./src/*"`; `peerDependencies` **and**
  `devDependencies` for workspace peers (final publish shape)
- `cordis.patch.yml` (row id/name), `examples/agent-preset/`, `LICENSE`,
  `THIRD-PARTY-NOTICES.md`, `SECURITY.md`, `README.md` (+ `*.zh.md`), CONTRIBUTING
- `scripts/release-public.sh` (check/publish), smoke script
- tests via vitest; import `src` directly in tests, **not** the package alias

Discipline: the plugin may use **only the fork's public type surface**. If it needs
something fork-private, either export it from the fork (small accepted cost) or keep
a duck-typed structural interface inside the plugin (the `VcsService` pattern).

Gate: `pnpm -r check && pnpm -r test && pnpm -r build` green **in the plugin repo
before touching the fork**.

## Phase 2 — Wire into the fork via `file:` and verify

1. Add the dependency:
   - CLI/standard profiles: `apps/cli/package.json`
   - web bundle plugins: `packages/bundle/web-app/package.json` **and** a row in
     `packages/bundle/web-app/cordis.patch.yml` (never only in `base`)
   - client-face (fork `packages/client/*` style): expose `./client` entry
2. For unpublished plugins use `file:` — but a **relative** spec
   (`file:../../../dsh-plugins/<plugin>/packages/<name>`) or keep the absolute spec
   **uncommitted**. Committed `file:/Users/hui/...` absolute paths break the build
   on any other machine/CI (currently present in `apps/cli/package.json` — fix on
   the next publish).
3. Verify **the real way**:
   - `boot()` + `loadOverlayPatches` fixture test (pattern:
     `apps/cli/tests/memory-mcp-configs.spec.ts` + `apps/cli/tests/fixtures/`)
   - `apps/cli/tests/standard-preset-boot.spec.ts` for base+web-app profile boots
   - after bundle-patch changes: `verify-cordis-config` (covers `**/*cordis*.yml`)
   - the fork's `review --target staged` gate applies to pushed changes
4. Iteration rule: the Cordis Loader imports the plugin's **built** `lib/index.js`.
   Every plugin-side change needs `pnpm run build:lib:host` (+ `tsdown` for
   client-face) before the fork sees it — a source edit alone changes nothing.
5. Smoke-dir gotcha: `npm install file:...` **symlinks** the package, so bare
   specifier imports (optional peers) resolve from the plugin repo, not the smoke
   dir → use `npm install --install-links` in consuming smoke dirs.

## Phase 3 — Publish, switch to `pkg:version`, clean up

1. **Publish order** (dependencies first): host/service packages before tools and
   before anything consuming them (e.g. `dsh-vcs` before `dsh-git`'s VCS use;
   `dsh-orchestration-policy` before tool-git; logistics tracked in `plugin-list.txt`).
2. Per repo: `bash scripts/release-public.sh --check` then `--publish`
   (clean tree required).
3. In the fork: replace `file:` with `^<version>`, reinstall, rebuild, **re-run the
   same boot smoke against the published artifact** — catches packaging bugs
   (`files`/`exports` gaps, missing LICENSE, peer resolution from the registry).
4. Clean up: delete only TRUE stand-ins (structural interfaces like the old
   `orchestration-policy.ts`) once their real package is wired. Remove an in-fork
   `@deepseek-ai/dsh-*` copy **only** when the standalone is genuinely ahead AND
   every default row/dependent is re-pointed to `@hy-sde-org` (see
   "Do not mass-swap" below — most in-fork copies are originals, not duplicates).
   Update docs (`docs/tool-catalog.md`, `docs/config-catalog.md`, subsystem docs)
   and `THIRD_PARTY_NOTICES.md`.

---

## Do not mass-swap (audit 2026-09-08)

`plugin-list.txt` is a publication tracker, not a migration directive. Verified state:

- 19/20 listed plugins are on npm (`0.1.2-rc.x`); only `dsh-logseq` (+
  `session-intelligence`, `api-wiki-controller`) are unpublished.
- The in-fork `@deepseek-ai/dsh-*` packages are the fork's **default composition**
  (depended on by `dsh-base`, the `dsh` CLI, web-app bundle, graph-host,
  memory-extraction, tool-fs, session-persistence…) and use upstream
  `@deepseek-ai` naming → keeping them keeps upstream merges clean.
- Most published `@hy-sde-org` packages are **bit-identical rebrands** of the
  in-fork code (diff-verify: only `@module` JSDoc strings differ — e.g. vcs,
  orchestration-policy). Swapping them in is fork-wide churn with zero behavior
  change and pins the default stack to rc releases.
- **Substitution rule:** switch an in-fork use to `@hy-sde-org@^version` only when
  the standalone is genuinely ahead (e.g. code-runtime-kernels — 7/7 src files
  differ; already mounted in `cordis-plus`) or when you deliberately stop
  maintaining the fork-side copy. Default: standalone plugins are mounted via
  presets (`~/.dsh/.agent-presets/*`), the fork keeps its in-fork packages.

---

## Traps (all hit before)

- Fork-first for a generic capability ⇒ build twice, backport is a rewrite.
- Standalone never published ⇒ fork rots on committed `file:` absolute paths and
  cannot build elsewhere.
- Forgetting `build:lib:host` after a plugin edit ⇒ harness runs stale code.
- `cordis.patch.yml` row in the wrong bundle ⇒ the plugin never activates; keep it
  in a profile that actually loads it (web-app bundle = `web-app/cordis.patch.yml`).
- Duplicate row ids / missing deps in a fixture ⇒ duplicated launcher entry errors;
  every name in fixture+example rows must resolve in `apps/cli/package.json`.
- `npm install file:` symlink vs `--install-links` for optional peers.
- Publish-order violations ⇒ consumers can't install (`ERR_MODULE_NOT_FOUND`-style
  peer gaps) or resolve a stale version.

## Checklist per new plugin

- [ ] Recon note: verdict `standalone-plugin` + rationale (duplication check done)
- [ ] `dsh-plugins/<plugin>/` monorepo follows the convention (exports, LICENSE,
      THIRD-PARTY-NOTICES, cordis.patch.yml, examples, release script)
- [ ] Plugin-repo gates green (check/test/build)
- [ ] Fork dep via relative/uncommitted `file:`; row in the right `cordis.patch.yml`
- [ ] Gold boot smoke passes (fixture `boot()` or `standard-preset-boot.spec.ts`)
- [ ] Published; fork dep switched to `^version`; smoke re-run on published artifact
- [ ] TRUE stand-in deleted (structural interface) once its real package is wired;
      in-fork `@deepseek-ai/dsh-*` copy removed only if standalone is ahead + all
      dependents re-pointed (see "Do not mass-swap"); docs + THIRD_PARTY_NOTICES updated
