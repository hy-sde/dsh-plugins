# Third-Party Notices

This project incorporates code derived from the DeepSeek Harness codebase
under the terms of the MIT License. Each derived file carries the attribution
in its header; this notice aggregates the provenance.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived modules**:
  - `@hy-sde-org/dsh-session-url` — the `session://` internal-URL scheme
    handler (`SessionProtocolHandler` transcript / event-JSON / listing /
    search surface, the Cordis plugin `apply` that registers it into
    `ctx.internalUrls`, and its test suite), ported from
    `packages/session-query/session-url`.

## DeepSeek Harness (fork-only internal-URL surface, vendored)

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived modules**:
  - `@hy-sde-org/dsh-session-url` `src/vendor/internal-urls/` — the small
    internal-URL types / parse / router surface vendored verbatim from the
    fork-only `@deepseek-ai/dsh-internal-urls` package
    (`packages/fs/internal-urls/src/{types,parse,router}.ts`) so the
    standalone package has **no unpublished dependency**. Each vendored file
    carries a "vendored from fork @deepseek-ai/dsh-internal-urls, keep in
    sync" header.

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
