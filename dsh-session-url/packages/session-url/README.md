# @hy-sde-org/dsh-session-url

`session://` — an internal-URL scheme handler for DeepSeek Harness that makes
the harness's own session history navigable as **files** through internal-URL
aware `read` / `grep` tools: directory listings, rendered transcripts, exact
per-event JSON, and FTS-backed cross-session search.

Published standalone as `@hy-sde-org/dsh-session-url`; it mirrors
`@deepseek-ai/dsh-session-url` in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness)
(packages/session-query/session-url) so any stock DeepSeek Harness install can
mount it without adopting the fork. It depends only on **published** packages
(`@deepseek-ai/dsh-session-query`, `@deepseek-ai/dsh-session`) — the fork-only
`@deepseek-ai/dsh-internal-urls` surface it consumes (types + parse + router)
is **vendored** into `src/vendor/internal-urls/` with a keep-in-sync marker.

The handler registers into the shared internal-URL registry (`ctx.internalUrls`)
and reads the same live-preferred logical corpus the session-query tools read
(`ctx.sessionQuery`). It adds no tool code: internal-URL-aware `read`/`grep`
already route any registered scheme through `ctx.internalUrls`.

## URL surface

| URL | Result |
| --- | --- |
| `session://*` (or `session://list`) | Directory listing of known sessions (newest first). |
| `session://<id>` | Rendered transcript — per event `seq \| type \| time` plus indented semantic text. |
| `session://<id>/event` | Directory index of that session's event seqs. |
| `session://<id>/event/<seq>` | One exact event as JSON. |
| `session://search?q=<terms>` (or `session://search/<terms>`) | FTS-backed cross-session hits (degraded when content search is disabled). |

Example:

```
read session://0a1b2c3d4e
grep tsconfig session://0a1b2c3d4e
read session://0a1b2c3d4e/event/42
list session://*
```

## Behavioral notes

- **Immutable:** every resource is read-only history — agents never edit a log through a file-shaped URL.
- **Bounded:** transcripts cap at 600 events for display (`read`) and 12 000 for search consumers (`grep` via `pathOnly`); listings cap at 200 sessions; one event's JSON caps at 128 KiB (oversized events degrade to a text notice). Every cap is a module export.
- **Search degradation:** deployments that disable content search (`openAt: 'never'`) make `session://search` return an explanatory note; exact reads (`session://<id>`, `/event`) never depend on the index.
- **Safety:** session ids are unvalidated branded strings used only as the URL host; they are never treated as filesystem segments, and the handler performs no filesystem access.

## Mounting

A host-plane row next to the registry it extends, *after* the internal-URL
registry service (standalone: `@hy-sde-org/dsh-internal-urls`, the sibling
repo in this plugins workspace):

```bash
pnpm add @hy-sde-org/dsh-session-url   # (or npm install)
dsh plugin add @hy-sde-org/dsh-session-url   # applies the shipped cordis.patch.yml (inserts the row)
```

```yaml
- id: session-url
  name: '@hy-sde-org/dsh-session-url'
```

Requires `ctx.internalUrls` and `ctx.sessionQuery`. Both are declared as hard
injects, so the row stays dormant ("waiting for …") until both services are
mounted, and the plugin fails loud at apply if either is truly absent.

## Package layout

- `src/handler.ts` — `SessionProtocolHandler` (the scheme's resolve/complete).
- `src/index.ts` — plugin `apply` registering the handler into the registry.
- `src/vendor/internal-urls/` — types/parse/router vendored from fork `@deepseek-ai/dsh-internal-urls` (keep in sync; no unpublished dependency).
- `cordis.patch.yml` — `insert`-only bundle patch: `dsh plugin add` wires the host-plane row.
- `tests/handler.spec.ts` — handler + router-integration tests.

## Known Limitations and Deferred Work

- `session://search` needs a content-search-enabled session-query engine (FTS). A deployment that disables content search (`openAt: 'never'`) receives an explanatory degrade instead of cross-session hits — exact reads (`session://<id>`, `/event`) never depend on the index.
- Transcripts render the semantic event projection (`extractSessionEventText`); raw per-event payloads are readable only through `/event/<seq>` JSON, one event at a time.
- Session titles are best-effort: they appear when the title service captured one, and are absent otherwise.
- The handler requires `ctx.internalUrls` and `ctx.sessionQuery` to be mounted; it fails loud at apply rather than partially serving.

## License

MIT. Derived from the DeepSeek Harness codebase; see
`THIRD-PARTY-NOTICES.md` for provenance.
