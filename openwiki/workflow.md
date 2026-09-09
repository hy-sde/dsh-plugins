---
title: Plugin workflow
tags:
  - topic
type: "Reference"
openwiki_generated: true
verified:
  - by: openwiki/0.4.3
    at: 2026-09-09T04:22:17.072Z
sources:
  - id: openwiki-source-f12581fbd198131b71059205
    resource: repo://WORKFLOW.md
generated: { by: "pipeline", at: "2026-09-09T04:22:17.072Z" }
---

# Plugin workflow

The decision rule is: does the capability have a life outside the harness?
Yes → standalone-first: build it here, wire it into the fork via file:, verify,
publish, then switch the fork to pkg:version. No → fork-only. Private or
client-bound capabilities are the A case taken further: they never enter this
repo or the publish flow and live in dsh-plugins-private instead.
