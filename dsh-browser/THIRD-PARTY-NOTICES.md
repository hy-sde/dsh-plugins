# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms shown for each. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## oh-my-pi

- **Project**: https://github.com/can1357/oh-my-pi (MIT License)
- **Copyright**: Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük
- **Derived modules**:
  - `@hy-sde-org/dsh-browser` — the browser service: `src/stealth*.ts`
    (omp's stealth launch flags + init scripts), `src/relay/*` (omp's
    browser-relay bridge/protocol multiplexing + kind resolution), and the
    ARIA snapshot driving contract.
  - `@hy-sde-org/dsh-tool-browser` — the model-facing `browser` tool
    (omp `tools/browser.ts` surface reduced to open/close/run/state +
    screenshots over launch / CDP-attach / relay backends).

## Playwright (bundled snapshot sources)

- **Project**: https://github.com/microsoft/playwright (Apache-2.0)
- **Copyright**: Copyright (c) Microsoft Corporation
- **Derived module**: `src/aria-bundle.ts` in `@hy-sde-org/dsh-browser` —
  the generated, vendored build of Playwright's ARIA snapshot sources, used
  verbatim (bundle + evaluator shim) exactly as omp bundles it, so page
  snapshots are DOM-exact and carry `[ref=eN]` ids.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived**: the `ctx.browser` service shape follows the harness service
  seam conventions (`Service`, inject, effect-scoped registration); the
  invariant companion follows `dsh-invariants` installs.

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
