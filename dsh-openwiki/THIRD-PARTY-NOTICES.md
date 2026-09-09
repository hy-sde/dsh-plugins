# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## openwiki (langchain-ai)

- **Project**: https://github.com/langchain-ai/openwiki (MIT License)
- **Copyright**: Copyright (c) 2026 langchain-ai (see upstream LICENSE)
- **Derived modules**:
  - `@hy-sde-org/dsh-openwiki` — the deterministic openwiki engine core:
    resumable repository-page-job lifecycle with durable
    `.run.json`/`.page-manifest.json`/`.last-update.json`, the Grounded
    Claims store/session/runtime with repository evidence resolution and
    `.claims/` sidecars, OKF v0.2 front matter validation/repair + index
    synchronization + generated provenance, Mermaid + wiki-link validation,
    and the wiki finalizer — adapted to a fork-native `WikiFs` filesystem
    seam that replaces openwiki's DeepAgents coupling.
  - `@hy-sde-org/dsh-tool-openwiki` — the five lifecycle tools
    (`openwiki_begin`/`openwiki_submit_plan`/`openwiki_next_page`/
    `openwiki_submit_page`/`openwiki_finish`) and the `openwiki:tools`
    prompt section; the tool-level wrappers are fork-native but keep the
    upstream protocol contract and model-facing descriptions.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived**: the Cordis plugin shape and the `ctx.tools`/`ctx.systemPrompt`
  service-seam conventions the tool package follows.

License text (identical for all listed projects):

```
MIT License

Copyright (c) 2026 hy-sde

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
