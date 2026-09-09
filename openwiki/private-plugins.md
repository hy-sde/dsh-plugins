---
title: Private plugins
tags:
  - topic
type: "Reference"
openwiki_generated: true
verified:
  - by: openwiki/0.4.3
    at: 2026-09-09T04:22:17.072Z
sources:
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-4f8a57333535d5caac378da7
    resource: repo://scripts/excluded-plugins.list
  - id: openwiki-source-d4b7a509a6777a2f6dc607c5
    resource: repo://scripts/publish-all.sh
generated: { by: "pipeline", at: "2026-09-09T04:22:17.072Z" }
---

# Private plugins

scripts/excluded-plugins.list is the single exclusion source. The publish
order refuses (fail-closed) if an excluded plugin is still a workspace member,
and publish-all.sh aborts on that refusal instead of silently publishing
nothing. The excluded plugins themselves moved to the separate
dsh-plugins-private repository with their per-plugin git histories archived.
