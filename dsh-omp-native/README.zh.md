# dsh-omp-native

[English](README.md) | 中文

从 [oh-my-pi](https://github.com/stencil-hq/omp) Rust 重写版（omp², MIT）中剥离的独立原生边车。它为 DeepSeek Harness 提供两个有界、只读的能力——此前在 omp backlog 中属于"依赖 Rust"的项——现在作为一个小型静态链接二进制交付，harness 通过固定的 JSON CLI 契约调用它：

- **`pdf`** — 通过纯 Rust 的 [hayro](https://crates.io/crates/hayro) 渲染器把页面栅格化为 PNG，强制执行与 omp2 `read` 工具相同的输入/页数/像素/输出边界（输入 20 MiB、2000 页、150 万像素、输出 8 MiB）。
- **`sqlite`** — 以只读方式查询 SQLite 数据库，支持完整的 oh-my-pi 表/列目标语法（`db.sqlite`、`db.sqlite:users`、`db.sqlite:users?where=...&limit=...`、裸 `?q=SELECT ...`），基于 `rusqlite` 并使用 `SQLITE_OPEN_READ_ONLY` + 进度中断及 WAL 支持。

harness 消费方是 fork 中的 `packages/fs/tool-fs/src/read-native.ts`（[hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness)）：当二进制存在时，`read` 工具会把 `.pdf`/`.sqlite` 文件路由给它（先嗅探 magic 字节），否则回退到常规读取。此处**独立发布**，使边车可以脱离 harness 检出独立构建与版本化。

## 布局

```text
dsh-omp-native/
  Cargo.toml            standalone crate (edition 2024, stable channel)
  src/main.rs           JSON contract entry
  src/pdf.rs            ported from omp2 crates/tools/src/read/pdf.rs
  src/sqlite.rs         ported from omp2 crates/tools/src/read/sqlite.rs (+ own tests)
  docs/cli-contract.md  pinned external contract
  fixtures/            sample.sqlite + sample.pdf used by the tool-fs spec
```

## 构建

```sh
cargo build --release          # stable channel is sufficient (no nightly)
cargo test --release           # sqlite module unit tests
```

然后在 harness 运行时导出 `DSH_OMP_NATIVE_PATH=/abs/path/to/dsh-omp-native`，或把二进制放在
`target/release/dsh-omp-native`（fork 中 `read-native.ts` 的默认探测路径）。

## 溯源

- `src/pdf.rs` — omp² `crates/tools/src/read/pdf.rs`（MIT），其中 `omp_core::Str`
  替换为 `&'static str`。
- `src/sqlite.rs` — omp² `crates/tools/src/read/sqlite.rs`（MIT），宽度计算由 `xutf`
  替换为 `unicode-width`，使 crate 可在 stable 上构建（omp² 自身的工作区为其 `xutf`
  固定 nightly）。
- 从 omp² 收割更多能力时应保持同样的模式：有界的只读表面、独立子命令、JSON 契约、
  consumer 侧的 magic 字节门槛。
