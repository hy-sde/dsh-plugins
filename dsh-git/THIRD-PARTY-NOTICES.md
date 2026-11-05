# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## oh-my-pi

- **Project**: https://github.com/can1357/oh-my-pi (MIT License)
- **Copyright**: Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük
- **Derived modules**:
  - `@hy-sde-org/dsh-memory` — the durable project-scoped `local` memory
    backend: `bank.jsonl` working entries, `learned.md` lessons,
    `memory_summary.md` consolidation, injection neutralization, IDF/stem
    lexical search, and the retain/recall/reflect/memory_edit/learn data
    model.
  - `@hy-sde-org/dsh-tool-memory` — the model-facing memory tools and the
    first-turn project-memory prompt injection.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived**: the `ctx.memory` service shape follows the harness service
  seam conventions (`Service`, inject, effect-scoped registration).

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

## @hy-sde-org/effect

The git service's subprocess runner (`run()`) uses [`@hy-sde-org/effect`](https://www.npmjs.com/package/@hy-sde-org/effect) —
a trimmed source fork of [`effect`](https://github.com/Effect-TS/effect) `packages/effect`
at tag `effect@4.0.5` (commit `7f524e25cfb49a71ac39b0f44278d08d40dda5de`). The fork carries
only the combinator core (`Effect`, `Cause`, `Data`, `Deferred`, `Exit`, `Scheduler` and their
closed dependency set — 62 of 519 upstream source files) and has zero runtime dependencies.
MIT License, Copyright (c) 2023 Effectful Technologies Inc.
