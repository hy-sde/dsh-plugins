# dsh-logseq — 面向 DeepSeek Harness 的无头 LLM-wiki（Logseq CLI 图服务 + 工具）

两个独立包，可作为**一个插件家族**安装到 DeepSeek Harness CLI：

| 包 | 职责 | 是否需要用户安装 |
|---|---|---|
| `@hy-sde-org/dsh-logseq-graph` | 服务：以已安装的 `logseq` CLI 为支撑的宿主平面 `ctx.wikiGraph`（含 `invariant` 伴随组件） | 是 |
| `@hy-sde-org/dsh-tool-logseq` | 面向模型的 `logseq_*` 工具（list/show/search/query/upsert/remove/graph/server）+ `logseq:tools` 提示卡片 | 是 |

这是 DeepSeek Harness 的 `packages/logseq` 家族——`logseq-graph` 宿主服务与
`logseq` CLI 工具——移植到 hy-sde npm scope 的**独立插件家族，零上游改动**：
所有 `@deepseek-ai` 依赖都从 npm registry 以 `0.1.2-rc.1` 基线解析，因此它
在官方 DeepSeek Harness 发行版（`dsh-v0.1.2-rc.1` 及以后）上的行为与在 fork
中完全一致。服务行作为普通包发布（包内不含 `cordis.patch.yml`——见
[挂载](#mounting)），工具行作为 agent 平面插件发布。

## 摘要

`logseq/` 家族借助 [Logseq](https://github.com/logseq/logseq) CLI 为 agent
提供无头 LLM-wiki：

- [`logseq-graph/`](packages/logseq/logseq-graph/README.zh.md) —— 宿主图服务
  （`ctx.wikiGraph`）：页面/块树、标签、属性、Datalog 查询、upsert/remove，
  以及 `logseq_server` 生命周期，投影为纯 JSON 线型类型。
- [`tool-logseq/`](packages/logseq/tool-logseq/README.zh.md) —— 面向模型的
  `logseq_*` 工具：list/show/search/query/upsert/remove/graph/server，输出
  确定性 JSON，外加一张 `logseq:tools` 提示卡片。

在上游 harness 中，Web GUI 的 wiki 抽屉经宿主 API 代理的 `wiki` 域通过该服务
读写图，浏览器抽屉（`dsh-client-ui-wiki`）是另一个包——两者都不在本仓库。
本独立仓库只发布服务 + 工具面。

## 目录

- [安装](#install)
- [挂载](#mounting)
- [许可证](#license)

-----

<a id="install"></a>
## 安装

```bash
pnpm install --global @deepseek-ai/dsh
```

### 从 npm 直接安装（已发布）

```bash
dsh plugin --profile web add @hy-sde-org/dsh-logseq-graph @hy-sde-org/dsh-tool-logseq
```

### 从本仓库安装（发布前）

```bash
pnpm install            # workspace setup
pnpm -r build
pnpm --filter packages/logseq/logseq-graph pack
pnpm --filter packages/logseq/tool-logseq pack
dsh plugin --profile web add <tarball-or-catalog-url>.tgz
```

`prepack` 会重建 `dist/`，所以 tarball 永远是最新的。然后把服务行与工具行
按[挂载](#mounting)加入你的组合。

<a id="mounting"></a>
## 挂载

与 `dsh-browser` 不同，本家族**不携带 `cordis.patch.yml`，也没有现成的
agent preset**：移植范围只有 `.ts` 表面，上游 harness 在自己的 web-app bundle
patch 里挂这两行。请手工把两行加入组合：

- **服务行（宿主平面）** —— 上游 harness 中 `ctx.wikiGraph` 被宿主 API
  代理 / wiki 抽屉行消费，因此它属于宿主组合，而不是 preset realm：

  ```yaml
  - id: logseq-graph
    name: '@hy-sde-org/dsh-logseq-graph'
    config:
      graph: llm-wiki
  ```

- **工具行（agent 平面）** —— 工具从 agent bundle 解析 `tools` +
  `systemPrompt`；把它加进 agent preset：

  ```yaml
  - id: tool-logseq
    name: '@hy-sde-org/dsh-tool-logseq'
    config: {}
  ```

`@hy-sde-org/dsh-tool-logseq` 把 `@hy-sde-org/dsh-logseq-graph` 声明为 peer
（并在本仓库中以 `workspace:*` 兄弟依赖）以便家族一起发布与解析。

<a id="license"></a>
## 许可证

MIT — 见 `LICENSE`。衍生自 DeepSeek Harness 的 logseq 包
（`@deepseek-ai/dsh-logseq-graph`、`@deepseek-ai/dsh-tool-logseq`，MIT）——
见 `THIRD-PARTY-NOTICES.md`。
