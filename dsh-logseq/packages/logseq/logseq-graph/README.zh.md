---
description: "主机平面的 ctx.wikiGraph 图服务：把 Logseq CLI 的 db-worker-node 图操作暴露为结构化 JSON 调用，供 wiki 抽屉与面向模型的工具使用。"
kind: "package-reference"
---

# @hy-sde-org/dsh-logseq-graph

[English](README.md) | 中文

## 概述

`ctx.wikiGraph` 把 Logseq CLI 的 `db-worker-node` 图操作暴露为结构化 JSON 调用，与任何 agent 工具无关：页面与块树、标签、属性、Datalog 查询、upsert/remove，以及 `logseq_server` 生命周期。在上游 harness 中，Web GUI 的 wiki 抽屉经该服务完成读写；面向模型的 `logseq_*` 工具（见 `@hy-sde-org/dsh-tool-logseq`）直接调用同一个 CLI。组合需要一个宿主服务背后的 wiki 图存储、且每次调用一个逻辑变更时选用本包。成本是每个方法一次全新的 CLI 进程；图写入需要运行中的 db-worker-node 服务器；invariant 伴随组件在 CLI 二进制不可达时于启动期快速失败。

## 目录

- [Service surface](#service-surface)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

主机平面的图服务：把本地安装的 [Logseq](https://github.com/logseq/logseq) CLI（`db-worker-node`）的图操作暴露为结构化 JSON 调用，与任何 agent 工具无关：页面/块树、标签、属性、Datalog 查询、upsert/remove，以及 `logseq_server` 生命周期。在上游 harness 中，Web GUI 内嵌的 wiki 抽屉通过 apiproxy 的 `wiki` 域用该服务完成读写；本独立仓库只发布该服务（抽屉与对应的宿主 API 代理行不包含在内）。面向模型的 `logseq_*` CLI 工具（见 `@hy-sde-org/dsh-tool-logseq`）直接使用同一个 CLI。

<a id="service-surface"></a>
## Service surface

一个 Cordis 服务 `ctx.wikiGraph`（`LogseqGraphService`），方法：

- `listPages({ includeBuiltIn, limit, offset })` → 扁平页行
- `getPage({ page | id | uuid })` → 嵌套块树 + 链接引用
- `listTags`、`listProperties`
- `search({ type, content, limit })`、`query({ query, inputs, limit })`（Datalog）
- `upsert(args)`、`remove(args)` —— 每次调用一个逻辑变更，逐标志转发
- `server(action, { name })` —— `list` / `start` / `stop` / `restart` / `cleanup`

每个方法都会以 `--output json` 启动一次 `logseq` CLI（配置了 `--graph <name>` 时），校验信封并把原始行投影为线型视图类型（`WikiTagRef`、`WikiBlockNode`、`WikiPageRoot` 等）。`@hy-sde-org/dsh-logseq-graph/invariant` 伴随组件在 CLI 二进制不可达时于启动期快速失败。

<a id="model-experience"></a>
## Model Experience

None, as 宿主服务自身不注册任何工具 schema、提示词章节或结果；它服务的 wiki 内容只通过 `@hy-sde-org/dsh-tool-logseq` 与人类的 wiki 抽屉到达模型。

#### KV Cache effect

本包不产生任何会塑造提示词的数据。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- - **必须安装 CLI** —— 服务启动的是 `logseq`，没有内置二进制（从 logseq 仓库构建：`opam exec -- dune build @bundle`）。invariant 伴随组件会给出安装提示，`cliPath` 支持非 PATH 二进制。
- - **每次调用都启动进程** —— 每个方法都会启动一个新的 CLI 进程。交互式抽屉使用与一次性 agent 编辑没问题；高频集成应通过 `upsert` 批处理。
- - **需要图服务器** —— 图写入需要 db-worker-node 服务器；服务复用运行中的实例（含桌面应用），或用`logseq_server start` 启动无头实例。针对已停止服务器的请求会表现为 CLI 错误。
- - **JSON 形态在运行时读取** —— `list/search/query` 字段遵循 CLI 的 JSON 契约并被防御式投影；未来 CLI 形态变化会使行降级而非崩溃。
- - **`user.property/*` 值为 db-id 引用** —— 属性值表现为独立的值块；通过服务编辑属性值写入的是值块，而不是行内的 `key:: value`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
