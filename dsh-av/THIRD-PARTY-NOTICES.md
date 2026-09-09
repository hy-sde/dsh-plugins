# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived modules**:
  - `@hy-sde-org/dsh-av` — the `ctx.av` read-only Automic Vault CLI
    service: executable resolution/probe, bounded subprocess runner with
    timeout + SIGTERM→SIGKILL grace, and JSON surface parsing for
    scan/doctor/detectors/hardeners/list. Ported from the fork-only
    `@deepseek-ai/dsh-av` package.
  - `@hy-sde-org/dsh-tool-av` — the model-facing `av_scan` / `av_doctor` /
    `av_catalog` / `av_list` tools plus the `av:tools` system-prompt
    section. Ported from the fork-only `@deepseek-ai/dsh-tool-av` package.

## Automic Vault CLI (not bundled)

- **Project**: https://www.automicvault.com/ — the external `av` CLI
- **Role**: invoked at runtime, never distributed. This repository does not
  ship, vendor, or reproduce the CLI; type shapes only mirror the documented
  JSON output contract.

License text (identical for the listed project):

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
