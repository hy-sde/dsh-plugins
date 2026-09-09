# @hy-sde-org/dsh-session-intelligence

面向 DeepSeek Harness 的会话健康情报：**`session_health`** 工具对历史会话实际
走向进行分类（**completed / abandoned / errored / unknown** 并给出置信度），
按罚分模型给出 **A–F** 健康等级（含依据类别与逐项罚分），并报告每个等级背后的
信号——工具失败/重试/编辑抖动、提示质量启发式（过短提示、无结构化起步、
缺少成功标准、重复提示、失控工具循环）、上下文压力（压缩、任务中压缩、
峰值 token 与模型窗口之比）。随包提供基于同一引擎的独立 CLI。

本包是 agentsview（MIT, Kenn Software）`internal/signals` 引擎
（`outcome.go`、`toolhealth.go`、`heuristics.go`、`context.go`、`score.go`）
的 TypeScript 移植；DSH 事件适配器按 agentsview `internal/sync/signal_compute.go`
映射 DeepSeek Harness 事件模型的方式，将会话日志（`user/message`、
`assistant/message`、`tool/call`、`tool/result`、`compaction/*`）映射到引擎
输入。详见 `THIRD-PARTY-NOTICES.md`。

## 功能

- 通过部署的 `sessionQuery` 服务扫描**调用方工作区**的会话——不访问文件系统、
  无需隔离域、自身不做持久化。
- 将单个会话的事件流归约为：结果与置信度、健康分数/等级/依据/罚分、工具健康
  信号、启发式信号、压缩/任务中压缩次数、峰值上下文 token、模型（若有记录）、
  上下文压力比。
- 跳过继承的种子前缀（子代理忽略父会话事件）；不可读会话只计数上报，绝不致命。
- `session` 动作返回单会话完整报告；`recent` 动作返回最近会话的健康表格。
- 同包的 **`session_recent_edits`** 工具列出工作区近期编辑过的文件：跨会话
  的 Edit/Write 工具调用中的文件路径，按文件分组、最近编辑优先（参数路径
  解析移植自 agentsview `ResolveFilePathFromJSON`；分组与排序移植其 `RecentEdits`）。
- **`session_insights`** 工具按频率排行工具调用（从高到低），含每工具会话覆盖
  与错误计数——由已被取代的 `@hy-sde-org/dsh-tool-session-insights` 合并而来。
  `bash` 调用会进一步拆成实际执行的命令（`ls`、`rg`、`grep`、`git` 等），
  每个命令一行，最忙的工具不再掩盖真正执行的命令。

## 工具参数

`session_health`:

| arg | type | notes |
| --- | --- | --- |
| `action` | string (required) | `"session"`(完整报告) 或 `"recent"`(健康表格) |
| `sessionId` | string | `action: "session"` 必填；id 见 `recent` 输出 |
| `limit` | number | `action: "recent"` 扫描的最近会话数上限（默认 20） |
| `since` | string | ISO-8601；仅统计创建时间不早于它的会话 |

`session_recent_edits`:

| arg | type | notes |
| --- | --- | --- |
| `path` | string | 文件路径的大小写不敏感子串过滤 |
| `limit` | number | 返回文件数上限（默认 50） |
| `perFile` | number | 每个文件内联的近期编辑数（默认 3） |
| `since` | string | ISO-8601；仅统计创建时间不早于它的会话 |

`session_insights`（合并自 dsh-tool-session-insights）：

| arg | type | notes |
| --- | --- | --- |
| `action` | string (required) | `"tool-frequency"` |
| `workspace` | string | 绝对路径；必须等于调用方工作区（默认取调用方） |
| `limit` | number | 扫描的最近会话数上限（默认 200） |
| `top` | number | 仅返回调用最多的前 N 个工具 |
| `since` | string | ISO-8601；仅统计创建时间不早于它的会话 |

## 引擎 API（与工具同源同数）

```ts
import { analyzeSession } from '@hy-sde-org/dsh-session-intelligence'
const signals = analyzeSession({ id, createdAt, events })
// signals.outcome, signals.score, signals.toolHealth, signals.heuristics,
// signals.compactionCount, signals.midTaskCompactionCount, signals.pressureMax
```

纯引擎入口（`classifyOutcome`、`computeToolHealth`、`analyzeHeuristics`、
`computeContextPressure`、`countMidTaskCompactions`、`computeHealthScore`、
`normalizeToolCategory`）从 `./engine` 与包根导出，便于嵌入与测试。

## 挂载

```yaml
- id: hy-sde-tool-session-intelligence
  name: '@hy-sde-org/dsh-session-intelligence'
```

部署需挂载 `tools`、`systemPrompt`、`sessionQuery`（基础 bundle 已提供）。
配置项：`maxSessions`（默认 200）、`recentLimit`（默认 20）、`timeoutMs`
（默认 60000）。现成预设见 [`cordis.patch.yml`](./cordis.patch.yml) 与
[`examples/agent-preset/`](./examples/agent-preset/)。

## CLI

```bash
node dist/cli.js --cwd /Users/hui/Documents/workspace --recent --limit 20
node dist/cli.js --cwd /Users/hui/Documents/workspace --session session-<id>
node dist/cli.js /Users/hui/.dsh/sessions/--Users-hui-Documents-workspace--
```

从各会话目录读取 `session.jsonl.zstd`（多帧 zstd，兼容撕裂尾部）或
`session.jsonl`；尊重 `DSH_HOME`（默认 `~/.dsh`）。

## 许可证

MIT——见 [LICENSE](../../LICENSE)。信号引擎与事件映射移植自 agentsview
（MIT, Kenn Software）；`cli.ts` 中的 `projectKey` 路径编码移植自
`@deepseek-ai/dsh-session-persistence-jsonl`（MIT, DeepSeek Harness）；
zstd 制品经 `@hy-sde-org/dsh-zstd-frame` 解码。详见
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md)。
