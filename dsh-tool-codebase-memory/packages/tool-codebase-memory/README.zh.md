---
description: "面向模型的 codebase-memory 工具：经 CLI 对本地 codebase-memory daemon 发起一次性查询，与 stdio MCP 客户端共享同一 daemon。"
kind: "package-reference"
---

# @hy-sde-org/dsh-tool-codebase-memory

[English](README.md) | 中文

## 概述

`dsh-tool-codebase-memory` 把本地 codebase-memory daemon 暴露为模型侧的 `codebase_*` 工具，从终端发起一次性查询。每次调用派发一次 `codebase-memory-mcp cli --json <tool>` 并解析原始 MCP 结果信封，与 MCP server 前端的是同一个 daemon，因此索引、项目变更锁与索引 supervisor 完全共享——热 daemon 调用约 0.2 秒。与 stdio MCP 客户端行相比，选择它可获得每次调用一个进程、schema 精简、可按 preset 配置，而不是每个会话常驻一个长寿命 server；可把 MCP 行禁用挂起作为零维护备选。主要边界是精选 schema 是 CLI 输入 schema 的手工维护镜像，codebase-memory 发布新增工具时本包需要更新。

## 目录

- [工具面](#tool-surface)
- [为什么用 CLI 而不是 MCP](#why-cli-over-mcp)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

基于 [codebase-memory](https://github.com/DeusData/codebase-memory-mcp) 的模型侧工具：从终端对本地 codebase-memory daemon 发起一次性查询。该工具面是 stdio MCP 客户端行（`@deepseek-ai/dsh-mcp-client` 配 `command: codebase-memory-mcp`）的本地替代方案——不在每个会话里常驻一个 MCP server，而是每次调用派发一次 `codebase-memory-mcp cli --json <tool>` 并解析原始 MCP 结果信封——**与 MCP server 前端的是同一个 daemon**，因此索引、项目变更锁与索引 supervisor 完全共享。本机实测热 daemon 调用约 0.2 秒（冷启动约 1.3 秒；`codebase-memory-mcp daemon start` 可保持常暖）。

<a id="tool-surface"></a>
## 工具面

- `codebase_list_projects` —— 列出全部已索引项目（名称、根路径、git 状态）；是其他地方 `project` 词汇的来源。
- `codebase_index_repository [repoPath] [mode=full|moderate|fast|cross-repo-intelligence] [targetProjects] [name] [persistence]` —— 索引一次、反复查询。
- `codebase_index_status [project]` —— 节点/边数量、新鲜度、跳过与部分解析的文件、上次运行的日志文件。
- `codebase_search_graph [query|namePattern|semanticQuery|label|filePattern|limit|offset|...]` —— 主要查找器：定义、实现、关系；用 `limit`/`offset` 翻页直到 `has_more` 为假。
- `codebase_query_graph [query] [maxRows]` —— 对图执行原始 Cypher（多跳、聚合、跨服务），含复杂度/循环热点属性。
- `codebase_trace_path [functionName] [direction] [depth] [mode=calls|data_flow|cross_service] [...]` —— 调用者/被调者、值流、跨服务跳转。
- `codebase_get_code_snippet [qualifiedName] [includeNeighbors]` —— 单个符号的源码，无需翻文件。
- `codebase_get_graph_schema [project]` —— 节点标签 + 边类型（Cypher 词汇表）。
- `codebase_get_architecture [path] [aspects]` —— 包/服务/依赖 + 对调用/导入图做 Leiden 社区检测得到的 de-facto 模块。
- `codebase_search_code [pattern] [mode=compact|full|files] [filePattern|pathFilter|limit]` —— grep 增强、去重进包含函数并按结构重要性排序。
- `codebase_detect_changes [baseBranch|since|depth|scope]` —— 把 git diff 映射到图上：一次改动会波及什么。
- `codebase_manage_adr [mode=get|update|sections] [content] [sections]` —— 读写架构决策记录（ADR）。
- `codebase_ingest_traces [traces]` —— 把 `{caller, callee, count}` 运行时 trace 折入图。
- `codebase_delete_project [project]` —— 破坏性操作；仅用于清理被取代的索引。

<a id="why-cli-over-mcp"></a>
## 为什么用 CLI 而不是 MCP

MCP 客户端行（`@deepseek-ai/dsh-mcp-client` 配 `command: codebase-memory-mcp`）能工作，但会在**每个**会话里常驻一个 stdio server，且把所有工具原样暴露为 `mcp__codebase__*` 前缀。CLI 包装每次调用派发一次、随即退出——无需回收、不会崩、会话内无常驻进程——且工具名干净（`codebase_*`）、schema 精简、可按 preset 配置。功能上完全一致：`cli` 模式经由同一个 daemon 执行（`main_local_cli_daemon_execute` → `cbm_daemon_application_client_tool`），这正是当初 logseq 转向 CLI-first 得以成立的原因。若想保留零维护的备选，可把 MCP 行禁用挂起。

<a id="configuration"></a>
## 配置

```ts
import { Context } from '@deepseek-ai/cordis'
import toolCodebaseMemoryPackage from '@hy-sde-org/dsh-tool-codebase-memory'

const ctx = new Context()
ctx.plugin(toolCodebaseMemoryPackage, {
  cliPath: 'codebase-memory-mcp', // CLI executable (default: on PATH)
  project: 'deepseek-harness', // default project for tools that can omit it
  timeoutMs: 60000, // per-call process timeout (index calls use indexTimeoutMs)
  indexTimeoutMs: 600000, // timeout for codebase_index_repository
  maxChars: 200000, // cap on rendered JSON payload before explicit truncation
})
```

设置 `project` 会让每次调用显式指向目标图，同时仍允许按调用覆盖。插件激活不变量在 CLI 缺失时快速失败并给出安装提示。可随时用 `codebase-memory-mcp cli list_projects` 验证。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

十四个手写 `codebase_*` schema（见[工具面](#tool-surface)）把图契约编码进去：模型优先用图答案（`codebase_search_graph` / `codebase_trace_path` / `codebase_get_code_snippet`）而非反复 grep/read，用 `limit`/`offset` 翻页，并在依赖答案前先索引新仓库。

#### Token 影响

十四个静态 schema 只加入请求前缀一次（合计约 3–5 KB），远小于把十五个 MCP schema 连同整段说明流进每个会话；结果以 JSON 载荷返回并受 `maxChars`（默认 200000）限制，失控的 Cypher 不会撑爆上下文。

#### KV 缓存影响

全部 schema 为静态；每次调用的参数不同但不会改变请求前缀。此前缀跨调用保持有效。

### 结果值

#### 模型看到什么

从 MCP 结果信封解析出的结构化 JSON 载荷（信封正文本身就是 JSON——包装器会二次解析），模型看到与 MCP 工具相同的对象，例如 `search_graph` 的 `{total, results, has_more}` 树行。工具错误（信封内 `isError: true`，`--json` 下进程退出码为 0）以带 argv/退出码的 `CodebaseMemoryCliError` 浮出——绝不会伪装成成功。

#### Token 影响

载荷原样透传，仅在超过 `maxChars` 上限时截断并带显式标记；CLI 自身的 `limit`/`offset` 分页是主要成本控制。

#### KV 缓存影响

结果为每次调用的快照，无读取回写改变模型的重复运行前缀。

### 提示段

#### 模型看到什么

一张 `codebase:tools` 卡片：先索引再提问、图答案优先于反复 grep、用 `limit`/`offset` 翻页、曲线工具表达不了的用 Cypher、`codebase_delete_project` 具破坏性。

#### Token 影响

六行短文本只加入请求前缀一次；每轮成本可忽略。

#### KV 缓存影响

静态段落文本——无失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- 精选 schema 是 CLI 输入 schema 的手工维护镜像；codebase-memory 发布新增工具时本包需要更新（harness 的 MCP 行会自动跟随——这也是保留其作为禁用备选的好理由）。
- `check_index_coverage` 虽在二进制的工具表中声明，但无法通过 `cli` 派发（"unknown tool"），因此有意不包装它。
- 无主机面服务或 GUI 面：二进制自带 `localhost:9749` 图谱可视化；类 logseq wiki 面板的画中抽屉属未来工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
