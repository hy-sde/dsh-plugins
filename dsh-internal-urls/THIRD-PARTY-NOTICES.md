# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## oh-my-pi

- **Project**: https://github.com/can1357/oh-my-pi (MIT License)
- **Copyright**: Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük
- **Derived modules**:
  - `@hy-sde-org/dsh-internal-urls` — the internal-URL resolver registry, the
    `conflict://` protocol (detection, surfacing, splicing resolution —
    `conflict-detect.ts`), and the `issue://`/`pr://` GitHub-as-filesystem
    protocols (`internal-urls/issue-pr-protocol.ts`).
  - `@hy-sde-org/dsh-tool-fs-internal-urls` — the read/write routing (windowed
    virtual reads, conflict surfacing and `:conflicts` summaries, routed write
    dispatch) and `@hy-sde-org/dsh-tool-fs-search-internal-urls` — the grep
    routing over virtual resources, both adapted onto the stock harness tool
    surface as agent-scope shadows.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived**: `@hy-sde-org/dsh-tool-fs-internal-urls` and
  `@hy-sde-org/dsh-tool-fs-search-internal-urls` are the DeepSeek Harness
  `dsh-tool-fs` / `dsh-tool-fs-search` packages (MIT) with the internal-URL
  routing additions; the `ctx.internalUrls` service shape follows the harness
  service seam conventions (`Service`, inject, effect-scoped registration).

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
