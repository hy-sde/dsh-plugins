# dsh-tool-codebase-memory —— 面向 DeepSeek Harness 的 codebase-memory CLI 工具

独立包，可安装为 **一个插件**（十四个工具）用于 DeepSeek Harness CLI：

| 包 | 工具 | 由用户安装？ |
|---|---|---|
| `@hy-sde-org/dsh-tool-codebase-memory` | `codebase_list_projects`、`codebase_index_repository`、`codebase_index_status`、`codebase_search_graph`、`codebase_query_graph`、`codebase_trace_path`、`codebase_get_code_snippet`、`codebase_get_graph_schema`、`codebase_get_architecture`、`codebase_search_code`、`codebase_detect_changes`、`codebase_manage_adr`、`codebase_ingest_traces`、`codebase_delete_project` | 是 |

这是 DeepSeek Harness `packages/codebase-memory/tool-codebase-memory` 包——包在 `codebase-memory-mcp` CLI 之上的模型侧 `codebase_*` 工具——移植到 hy-sde npm scope，成为 **对上游零改动的独立插件**：所有 `@deepseek-ai` 依赖都从 npm registry 按 `0.1.2-rc.1` 基线解析，因此它在官方 DeepSeek Harness 发布版（`dsh-v0.1.2-rc.1` 及以后）上的运行方式与 fork 中完全一致。CLI 不随包附带：安装 [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)（或把 `cliPath` 指向非 PATH 的二进制）后，插件即对接 stdio MCP 客户端所前端的同一本地 daemon。

## 概述

本包把本地 codebase-memory daemon 暴露为模型侧 `codebase_*` 工具，从终端发起一次性查询。每次调用派发一次 `codebase-memory-mcp cli --json <tool>`（带临时 `--args-file`）并解析原始 MCP 结果信封——索引、项目变更锁与索引 supervisor 与 MCP server 的 daemon 完全共享，会话内没有常驻 server。完整的工具面、配置与 CLI-vs-MCP 取舍见包 [README](packages/tool-codebase-memory/README.md)。

## 目录

- [安装](#install)
- [挂载](#mounting)
- [许可](#license)

-----

## 安装

```bash
pnpm install --global @deepseek-ai/dsh
```

### 直接来自 npm（已发布）

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-codebase-memory
```

`dsh plugin add` 会根据已安装的 `dsh.bundle.patch` 导出对 profile 的 bundle 列表做协调，因此安装后 `hy-sde-cbm-tool-codebase-memory` 行立即在命名 profile 中生效。

也可以从自己的工具链直接依赖它：

```bash
npm install @hy-sde-org/dsh-tool-codebase-memory   # 或 pnpm add / yarn add
```

### 从本仓库（发布前 / 开发）

```bash
git clone git@github.com:hy-sde/dsh-tool-codebase-memory.git
cd dsh-tool-codebase-memory
pnpm install
pnpm run build

CBM_TGZ="$(cd packages/tool-codebase-memory && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$CBM_TGZ"
```

`prepack` 会重建 `dist/`，因此 tarball 总是最新的。

### 验证

```bash
dsh web --dump-config   # 查找 hy-sde-cbm-tool-codebase-memory 行
```

### 卸载

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-tool-codebase-memory
```

> **官方已内置？** 如果未来 DeepSeek Harness 发布自带 codebase-memory 工具，请跳过安装——再叠加本 bundle 会产生重复 loader 行并在启动时失败。

## 挂载

插件的 `cordis.patch.yml` 挂载 **一个普通 agent 平面行**，与官方 harness 库存 base bundle 中自己的 `tool-codebase-memory` 行完全一致。它消费部署的宿主服务——`tools` 与 `systemPrompt`（库存 base 经 agent bundle 提供两者）——因此不需要自己的服务或文件系统 realm：

- `hy-sde-cbm-tool-codebase-memory` —— `@hy-sde-org/dsh-tool-codebase-memory`，注册十四个 `codebase_*` 工具及 `codebase:tools` 提示段。

按部署覆盖配置（按 id 打补丁）：

```yaml
- id: hy-sde-cbm-tool-codebase-memory
  config:
    cliPath: /opt/codebase-memory-mcp/bin/codebase-memory-mcp
    project: my-monorepo
    timeoutMs: 60000
    indexTimeoutMs: 600000
    maxChars: 200000
```

行 id 带 `hy-sde-` 前缀以避免与任何同名内置行冲突（重复 loader id 会导致启动失败）；若部署已有自己的 `tool-codebase-memory` 行，请禁用本行或删除 insert 而保留内置行。

## 许可

MIT —— 见 `LICENSE`。衍生自 DeepSeek Harness `tool-codebase-memory` 包（`@deepseek-ai/dsh-tool-codebase-memory`，MIT）—— 见 `THIRD-PARTY-NOTICES.md`。
