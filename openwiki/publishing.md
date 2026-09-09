---
title: Publishing and release
tags:
  - topic
type: "Reference"
openwiki_generated: true
verified:
  - by: openwiki/0.4.3
    at: 2026-09-09T04:22:17.072Z
sources:
  - id: openwiki-source-d4b7a509a6777a2f6dc607c5
    resource: repo://scripts/publish-all.sh
  - id: openwiki-source-8d7b4716bd0ed15d63209a93
    resource: repo://scripts/release-public.sh
generated: { by: "pipeline", at: "2026-09-09T04:22:17.072Z" }
---

# Publishing and release

Each package is validated by scripts/release-public.sh (clean worktree,
@hy-sde-org name, LICENSE, check/test/build, pack) and published with pnpm so
workspace:^ dependencies are rewritten to real published ranges. publish-all.sh
runs the full workspace gates first and then walks every package in
dependency order; --check dry-runs the whole pipeline without publishing.
