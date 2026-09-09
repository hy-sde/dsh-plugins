---
description: "面向模型的 Logseq CLI 工具，用于从终端驱动 Logseq 数据库图——列出、展示、搜索、Datalog 查询、upsert、删除以及图/服务生命周期，输出确定性 JSON。"
kind: "package-reference"
---

# @hy-sde-org/dsh-tool-logseq

[English](README.md) | 中文

## 概述

`dsh-tool-logseq` 让 agent 直接从终端驱动 Logseq 数据库图：列出、展示、搜索、Datalog 查询、upsert 与删除块、页、标签、属性、任务与资产，以及图与服务生命周期操作。当需要确定性 JSON 输出、Datalog 查询、结构化任务 upsert 或完全无头运行——而桌面 App MCP 桥接要求 App 打开、且没有删除、Datalog 与任务命令——时，选它而不是 MCP 桥接。工具在每次调用时运行已安装的 `logseq` CLI，因此必须安装 CLI，且每次调用付一次进程启动成本；最省的方式是把写入合并进单个 `logseq_upsert` 调用，并用 `logseq_server start` 启动无头服务。

## 目录

- [工具面](#tool-surface)
- [为什么用 CLI 而不是 MCP](#why-cli-over-mcp)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

直接驱动 [Logseq](https://logseq.com/) 数据库图的模型侧 CLI 工具。该工具面是桌面 App MCP 桥接的本地替代方案：除基础读写外，它补上了 MCP 桥接做不到的能力——Datalog `query`、`remove`、一等公民 `task` 的 upsert，以及图/服务生命周期——全部包在已安装的 `logseq` CLI 之外（`opam exec -- dune build @bundle`，或用预编译二进制）。

<a id="tool-surface"></a>
## 工具面

- `logseq_list [entityType=page] [limit] [offset] [sort] [order] [fields] [includeBuiltIn] [journalOnly] [includeHidden] [withProperties] [withExtends] [taskStatus] [taskPriority] [content]` —— 带实体类型开关地列出页面、标签、属性、任务、节点或资产。
- `logseq_show [page | id | uuid] [level] [pageHierarchy] [linkedReferences]` —— 以文本渲染块/页树。
- `logseq_search [entityType] [content] [limit]` —— 对块/页/属性/标签做全文搜索。
- `logseq_query [query | name] [inputs] [limit]` —— Datascript 查询（一步跳不出结构性问题）。
- `logseq_upsert [entityType] [...]` —— 创建/更新块、页、标签、属性与任务；任务带结构化 `status`/`priority`/`scheduled`/`deadline`，标签/属性走 EDN 映射，绝不嵌入正文。
- `logseq_remove [entityType] [id|uuid|page|name]` —— 永久删除（仅在确定时使用）。
- `logseq_graph [action] [...]` —— validate/info/export(edn|sqlite)/import/backup 生命周期。
- `logseq_server [action]` —— list/start/stop/restart/cleanup db-worker-node 服务；`start` 让桌面 App 不开也能完全无头运行。

<a id="why-cli-over-mcp"></a>
## 为什么用 CLI 而不是 MCP

桌面 MCP 桥接仅在 App 打开时服务同一张图，却要求 App + token 头、没有 Datalog、没有删除、没有任务命令，且每次请求都携带巨大的原始 schema。CLI 包装是确定性 JSON（`--output json` → `{"status":"ok","data":…}`）、可无头、全功能面、紧凑。若想保留零维护的备选，可把 MCP 行禁用挂起。

<a id="configuration"></a>
## 配置

```ts
import { Context } from '@deepseek-ai/cordis'
import toolLogseqPackage from '@hy-sde-org/dsh-tool-logseq'

const ctx = new Context()
ctx.plugin(toolLogseqPackage, {
  cliPath: 'logseq', // CLI executable (default: on PATH)
  graph: 'llm-wiki', // always pass --graph <name>
  timeoutMs: 60000, // per-call process timeout
  maxItems: 50, // cap on rendered list/search items
})
```

设置 `graph` 会让每次调用显式指向目标图。插件激活不变量在 CLI 缺失时快速失败并给出安装提示。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

工具描述 + schema 把 CLI 契约编码进去：模型优先走 CLI 而非 MCP 桥接，每次调用只做一次逻辑变更，用结构化任务状态而不是正文里的 TODO 标记。

#### Token 影响

八个手写 schema 只加入请求前缀一次（合计约 1–2 KB），远小于每次请求都携带的 MCP `upsertNodes` schema；结果以紧凑渲染返回（受 `maxItems` 限制），无论图多大 token 成本都有界。

#### KV 缓存影响

全部 schema 为静态；每次调用的参数不同但不会改变请求前缀。此前缀跨调用保持有效。

### 结果值

#### 模型看到什么

结构化的枚举与查询行以纯数据呈现，`show` 用 CLI 的人类可读树文本。人的错误信封（`Error (...)` 输出）会以带 argv 的 `LogseqCliError` 浮出，绝不会伪装成成功。

#### Token 影响

列表/搜索结果有上限（`maxItems` 默认 50）并做摘要；查询行压成紧凑行；server/graph 表格以小段纯文本透传。

#### KV 缓存影响

结果是一次性快照；没有会改变模型重放前缀的回读。

### 提示节

#### 模型看到什么

一张 `logseq:tools` 卡片：优先 CLI 而非 MCP、每次调用一次逻辑变更、创建前先做存在性检查、删除是永久的、任务用结构化状态、无头场景先 `logseq_server` start。

#### Token 影响

六行短文本只加入请求前缀一次；每轮可忽略。

#### KV 缓存影响

静态节文本——无失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **必须安装 CLI** —— 工具 spawning `logseq`，不内置二进制（CLI 需从 logseq 仓库构建）。激活不变量给出安装提示，`cliPath` 支持非 PATH 二进制。
- **每次调用都起进程** —— 每个工具调用都启动一个新的 CLI 进程（这是 CLI 自身的模型）。高频小改会付出进程启动成本；请把结构化变更合并进单个 `logseq_upsert`。批量的结构化修改请放进单次 `logseq_upsert` 调用。
- **需要图服务** —— 图需要 db-worker-node 服务；工具复用已在运行的服务（含桌面 App 的），或 `logseq_server start` 启动无头实例。服务停止会以 CLI 错误呈现，而非干净的自动重试路径。
- **JSON 形状在运行时读取** —— `list/search/query` 的字段遵循 CLI 的 JSON 契约；未来 CLI 若改变形状，紧凑渲染会优雅降级而不是崩溃。
- **暂无资产上传** —— `logseq_upsert`/`logseq_list` 对资产只做通用 node/asset 列举；二进制资产摄入暂时仍是文件/CLI 的事。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
