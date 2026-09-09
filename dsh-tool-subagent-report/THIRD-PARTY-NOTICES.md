# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived modules**:
  - `@hy-sde-org/dsh-tool-subagent-report` — the child-scoped `report` tool
    and its usage guidance, ported from
    `@deepseek-ai/dsh-tool-subagent-report`
    (`packages/subagent/tool-subagent-report/src/index.ts`): the
    `installReportTool` child-scope installer, the `report` tool definition
    (parameters, output schema, render, validation), the structured-arm
    rendering, and the `apply` hook that registers the tool through
    `ctx.subagents.registerContinuableSetup`.

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

The port was authored against the published DeepSeek Harness packages
(`@deepseek-ai/cordis`, `dsh-agent`, `dsh-llm`, `dsh-subagent`,
`dsh-system-prompt`, `dsh-tools`) — MIT License, Copyright (c) 2026 DeepSeek
— whose plugin/service contracts are integrated as peer dependencies, not
copied source. The fork-only subagent report channel
(`registerContinuableSetup`/`reportFrom`) is declared as a local type
contract (`src/report-contract.ts`) and supplied at runtime by a harness or
subagent service built from the fork.

## Runtime dependency surface (not copied)

`@hy-sde-org/dsh-tool-subagent-report` depends at runtime on:

| package | license |
|---|---|
| @deepseek-ai/schemastery | MIT |

and declares peer dependencies on the published DeepSeek Harness packages
(`@deepseek-ai/cordis`, `dsh-agent`, `dsh-llm`, `dsh-subagent`,
`dsh-system-prompt`, `dsh-tools`), all served from the npm registry under
their published licenses.
