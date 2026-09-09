# @hy-sde-org/dsh-vcs

[English](README.md) | 中文

## 概述

`dsh-vcs` 暴露 `ctx.vcs`——一个 host 平面服务，封装用户安装的 `pi-vcs` CLI，为 harness 提供窄的只读 VCS 数据面：修订、暂存与工作树差异（含 `--name-only`/`--numstat` 模式）、状态计数、分支名、仓库发现与 HEAD 变化 watch，每个文本数据面都与对应 `git diff` 输出逐字节兼容。当调用方需要 gitoxide 原生切片而不改变默认 TS/git-CLI 路径时选择它：该服务纯属增量，`pi-vcs` 不可达时降级到 git 服务。其代价是按功能探测与逐调用 shell-out——每个动词生成 `pi-vcs` 并采集受限输出，且二进制补丁只渲染标记。

以 **独立包** 形式发布为 `@hy-sde-org/dsh-vcs`，任何 DeepSeek Harness 安装都可以挂载 host `ctx.vcs` 服务，而无需依赖最初承载 `@deepseek-ai/dsh-vcs` 的 fork。

## 目录

- [增量式且按功能探测](#additive-and-feature-detected)
- [`pi-vcs` CLI](#the-pi-vcs-cli)
- [安装与挂载](#install--mount)
- [执行的命令](#executed-commands)
- [安全边界](#security-boundary)
- [配置](#configuration)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

DeepSeek Harness 的原生 vcs 管道：`ctx.vcs`，一个 host 平面服务，封装 `pi-vcs` CLI —— oh-my-pi vcs 数据面的窄原生切片 —— 通过 `ctx.subprocess` 通道执行，以 `ctx.av` 为模板。

服务解析 `pi-vcs` 可执行文件（配置 → `DSH_VCS_PATH` → PATH），用 `pi-vcs --version` 探测，并暴露窄切片：git 修订差异与暂存差异由 **gitoxide 进程内渲染**（git 兼容的统一补丁文本，与 git 服务渲染逐字节兼容）、仓库发现、以及 HEAD 变化 watch 伴生进程。

<a id="additive-and-feature-detected"></a>
## 增量式且按功能探测

`ctx.vcs` 在该 harness 约定下**纯属增量**：git 服务（`ctx.git`，TS/git-CLI）保持默认路径且不被改动。这些数据面仅在 `pi-vcs` 二进制可达且探测正常时解析；否则 `probe()` 报告 `available: false`，调用方降级到 git 服务。无 jj 后端、无变更动词 —— 这些保留在 git 服务上。

<a id="the-pi-vcs-cli"></a>
## `pi-vcs` CLI

该 CLI **像 `av` 一样由用户安装** —— 本包不附带该二进制。从 [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness) 的 `native/pi-vcs-cli/` 构建（一个基于 gitoxide 的 Rust crate）：

```sh
cargo build --release --manifest-path native/pi-vcs-cli/Cargo.toml
```

将 `native/pi-vcs-cli/target/release/pi-vcs-cli` 以 `pi-vcs` 安装到 PATH。

它是 oh-my-pi `crates/pi-vcs` git 后端的一个忠实、MIT 署名的移植，限定于窄切片。其差异渲染器输出 git 兼容的统一文本（针对文本、二进制、重命名/复制与暂存数据面，均验证为与 `git diff` 逐字节一致）。

<a id="install--mount"></a>
## 安装与挂载

```bash
pnpm add @hy-sde-org/dsh-vcs
# 或：npm install @hy-sde-org/dsh-vcs
```

然后作为 Cordis 插件挂载。该包附带 `cordis.patch.yml`（标准 INSERT 补丁形式，在官方 harness 版本上安全），向 profile 的基础组合添加 `vcs` 行，使 `ctx.vcs` 在 host 平面全局可用：

```bash
dsh plugin --profile web add @hy-sde-org/dsh-vcs
```

Node `>=22.19.0`；peer 为 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-subprocess`（`ctx.subprocess` 通道须由宿主挂载，例如通过 `@deepseek-ai/dsh-subprocess-local`）。服务不注册任何面向模型的工具，因此无需 agent 预设。

<a id="executed-commands"></a>
## 执行的命令

| 方法 | CLI 调用 | 用途 |
|---|---|---|
| `probe` | `pi-vcs --version` | 可达性 + 版本，绝不抛出 |
| `repoInfo` | `pi-vcs repo-info <dir>` | 仓库发现（JSON）；`NotARepository` 返回 `null` |
| `revDiff` | `pi-vcs rev-diff <dir> <base> [<head>]` | 修订之间的 git 兼容统一补丁（省略 `<head>` 时为 `base`→工作树） |
| `stagedDiff` | `pi-vcs staged-diff <dir>` | git 兼容的统一暂存补丁 |
| `worktreeDiff` | `pi-vcs worktree-diff <dir>` | git 兼容的统一工作树补丁（索引对工作树） |
| `diff` | `rev-diff`/`staged-diff`/`worktree-diff` + `--name-only`/`--numstat` | 任意范围、任意输出模式的统一表面 |
| `changedFiles` | `--name-only` | 变更路径、重命名目标、git C-引号 |
| `numstat` | `--numstat` | 供 `parseNumstat` 使用的原始 added/removed/path 行 |
| `status` | `pi-vcs status <dir>` | 与 `ctx.git.status` 相同的暂存/未暂存/未跟踪计数 |
| `branch` | `pi-vcs repo-info <dir>` | 当前分支（分离 HEAD 时为 undefined） |
| `watch` | `pi-vcs watch <dir> [--interval-ms N]` | 长驻 JSON-行 HEAD 变化伴生进程 |

所有命令都通过 `ctx.subprocess` 执行，带受限的 stdout/stderr 采集、墙钟超时和 SIGTERM→SIGKILL 宽限。非零退出以数据形式返回在 run 上，并带结构化 `code`（VcsError 分类：`NotARepository`、`RefNotFound`、`ObjectNotFound`、`Backend`、`Unsupported` 等），从 CLI 的 JSON stderr 解析；只有启动失败、信号杀死或超时才抛出 `VcsCommandError`。`watch` 返回一个终止进程树的释放器。

<a id="security-boundary"></a>
## 安全边界

- **只读切片** —— `ctx.vcs` 从不变更仓库：无提交、无暂存、无引用写入。所有动词只渲染既有状态。
- 无命令经过 shell 解释；argv 原样通过 subprocess 通道传递。
- 发现是纯文件系统遍历（无子进程）；gix 打开时拒绝环境中的 `GIT_*` 位置覆盖，将每个操作绑定到已发现的仓库。

<a id="configuration"></a>
## 配置

```ts
import { Context } from '@deepseek-ai/cordis'
import vcsPackage from '@hy-sde-org/dsh-vcs'

const ctx = new Context()
ctx.plugin(vcsPackage, {
  vcsPath: '/usr/local/bin/pi-vcs',
  timeoutMs: 120000,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  graceMs: 5000,
  watchIntervalMs: 1000,
})
```

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **二进制补丁仅渲染标记** —— 省去 `GIT binary patch` 正文机制（delta/base85）；二进制变更输出 `Binary files … differ`，与 harness 差异解析器的预期一致。
- **冲突合并状态** —— 合并进行中时 `git diff` 切换为组合形式（`diff --cc`）；原生渲染器与 omp 一致，跳过冲突条目，因此冲突树的审查最好针对暂存/范围数据面。状态仍与 git 完全一致地报告 `UU`。
- **无 jj 后端** —— harness fork 仅 git（`isPureJj=false`）；编译进 omp 原生 addon 的 jj-lib 不是可调用的二进制，且刻意不在范围内。
- **逐调用 shell-out** —— 批量动词没有常驻原生进程；每次调用生成 `pi-vcs` 并采集受限输出。`watch` 是唯一的长驻伴生进程。

本包不注册任何运行时不变式；其行为由包测试套件（伪 `pi-vcs` shim）保证。
