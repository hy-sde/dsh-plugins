# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## oh-my-pi

- **Project**: https://github.com/can1357/oh-my-pi (MIT License)
- **Copyright**: Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük
- **Derived modules**:
  - `@hy-sde-org/dsh-tool-ast` — the `ast_grep` (structural code search) and
    `ast_edit` (structural rewrite) tools: the ast-grep driven engine
    (binary resolution, argv building, `--json=stream` parsing, error
    vocabulary), the match/rewrite presentation, and the preview-first
    apply flow of the original coding agent's tool surface.

License text (identical for all listed projects):

```
MIT License

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

## DeepSeek Harness (port substrate)

The port was authored against the DeepSeek Harness (`deepseek-harness`) —
MIT License, Copyright (c) 2026 DeepSeek — whose plugin/service contracts
(agent presets, `ctx.tools`, `ctx.fs`, `ctx.subprocess`, `ctx.systemPrompt`)
are integrated as peer dependencies, not copied source.

## Runtime dependency surface (not copied)

`@hy-sde-org/dsh-tool-ast` depends at runtime on:

| package | license |
|---|---|
| @ast-grep/cli | MIT (native engine; platform binaries under their respective licenses) |
| @deepseek-ai/schemastery | MIT |

and declares peer dependencies on the published DeepSeek Harness packages
(`@deepseek-ai/cordis`, `dsh-tools`, `dsh-fs`, `dsh-fs-local`,
`dsh-llm`, `dsh-sandbox`, `dsh-sandbox-policy`, `dsh-subprocess`,
`dsh-system-prompt`, `dsh-timeout`, `dsh-invariants`), all served from the
npm registry under their published licenses.
