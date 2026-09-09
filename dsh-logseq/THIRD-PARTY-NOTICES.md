# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms shown for each. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived modules**:
  - `@hy-sde-org/dsh-logseq-graph` — ported from
    `@deepseek-ai/dsh-logseq-graph` (host-plane `ctx.wikiGraph` service over
    the Logseq CLI, with its `invariant` companion and CLI projection
    helpers).
  - `@hy-sde-org/dsh-tool-logseq` — ported from
    `@deepseek-ai/dsh-tool-logseq` (model-facing `logseq_*` CLI tools, prompt
    section, and `invariant`/`cli-check` companions).

No other third-party code is vendored or bundled in this repository. Runtime
dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-invariants`,
`@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tools`) are consumed from
the npm registry under their own licenses.

License text (identical for all MIT-listed projects):

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
