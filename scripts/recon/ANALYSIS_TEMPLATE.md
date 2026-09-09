# Recon: {{REPO_NAME}}

<!-- recon-meta
# status: pending | in-progress | done | skip
status: pending
# verdict: standalone-plugin | fork-only | extend-existing | skip
verdict: TBD
date: {{DATE}}
url: {{REPO_URL}}
index: {{INDEX_NAME}}    # codebase-memory project (harvest-<name>)
-->

## 0. Orientation (fill first, ~5 min)
- What this project is, its stack, scale (files/loc, language split, test framework).
- Why it was shortlisted — which capability looked relevant to the harness.

## 1. Capability inventory
| # | Capability | Where (module/file) | What it gives us | Reuse shape (copy / port / adapt) |
|---|---|---|---|---|
|  |  |  |  |  |

## 2. Integration surface (which harness seam — check all that apply, name exact hooks)
- [ ] **new tool** (model-facing) — closest existing analogue (dsh-plugins `dsh-tool-*` / fork `packages/*/tool-*`)
- [ ] **host service / plugin with `ctx.*` slots** — which fork services it needs (`@deepseek-ai/dsh-*`)
- [ ] **event listener** — event names + payload shapes it expects
- [ ] **client slot / UI** — which fork client slot; follows `@hy-sde-org/dsh-client-ui-*` pattern?
- [ ] **web-app bundle row** — `packages/bundle/web-app/cordis.patch.yml` + dependency there
- [ ] **storage backend** — new `storage-sqlite` row via `dshHomePath`?
- [ ] **LLM / model route** (llm slots), **CLI command**, **other**: ___
- Fork types it touches: which are PUBLIC exports vs fork-private (would need exporting or a duck-typed structural interface)?

## 3. Dependency & license reality
- License of copied code + key deps; any AGPL/GPL/patent/attribution clauses (→ THIRD-PARTY-NOTICES planning).
- Runtime weight: native modules? heavy ML? python runtime? browser? external service/credential we lack?

## 4. Duplication check (before building anything)
- Existing dsh-plugins repo with overlapping purpose — cite it + what it LACKS (gap analysis).
- Fork-side feature already present? (check `docs/tool-catalog.md`, `docs/config-catalog.md`, `packages/*`)
- Verdict: port / extend-existing / skip.

## 5. Adaptation sketch (if building)
- Steps: extract module → rebrand to `@hy-sde-org/dsh-*` → public type surface → cordis row + example → tests.
- Publish deps/order requirements (see `dsh-plugins/WORKFLOW.md` Phase 3).
- Effort: S / M / L (+ rough estimate); risk notes (native, upstream churn, maintenance).

## 6. Decision
- **verdict:** (update the meta line too) + one-line rationale.
- follow-up tasks & owner.

## Notes (freeform — findings, snippets, dead ends)
