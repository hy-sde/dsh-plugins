# Third-Party Notices

This project incorporates code derived from the DeepSeek Harness codebase
under the terms of the MIT License. Each derived file carries the attribution
in its header; this notice aggregates the provenance.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived modules**:
  - `@hy-sde-org/dsh-llm-slots` — the host-wide model-slot admission control
    (`ModelSlotGate` FIFO gate, `ModelSlotsService` exposing
    `ctx.modelSlots`, and `apply()` hooking the `llm/stream` waterfall),
    including the package-owned `./invariant` companion pattern
    (`ctx.invariants` registration into a Cordis host).

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
