# 项目架构图 Markdown 草稿

> 状态：讨论草稿。本文先用 Markdown 线框确认架构分层、组件抽象和调用方向，确认后再同步重绘正式 HTML 架构图。

## 绘制原则

- 面向后续开发者快速理解项目结构和技术架构，优先表达层级、边界和依赖方向。
- 主节点使用功能抽象命名；当前技术实现放在节点小字中，例如“数据库 / PostgreSQL”“向量数据库 / pgvector”。
- 全局分层图不使用连接线，依靠上下位置表达依赖关系：上层基于下层能力构建，Harness 作为侧边统筹能力观察和驱动全局。
- 分模块调用关系图可拆成多张小图，避免单图过密。
- 不在架构图里展开非核心技术选型细节；外部模型网关等实现细节暂不进入主图。

## 1. 全局分层架构图

> 读法：从下往上看能力供给，从上往下看产品使用路径。Harness 层不是普通业务依赖层，而是侧边统筹运行评估、记录和回放。

| 侧边统筹 | 分层 | 抽象组件 | 当前实现提示 |
| --- | --- | --- | --- |
| Harness 层 | 外壳 / 产品形态层 | 浏览器访问、Desktop 端、微信入口 | `apps/web`、`apps/desktop`、WeChat entry |
| AgentSpec / Fixture / EvalRun / Trace | 核心 Agent 层 | System Agent、子 Agent 委派、Specialist Agents | LangGraph runtime、agent registry、skills instructions |
| Phoenix Trace / run event records | 工具层 | 文件读写、记忆读写、连接工具、定时任务、版本管理、Skill 与配置 | workspace tools、memory tools、browser/wechat tools、schedule、Git、SkillStore |
| 运行观测 / 评估回放 / 失败链路固化 | 连接层 | Browser Use、Remote Control、微信远程入口 | Playwriter relay、browser extension、WeChat relay |
|  | 存储层 | 文件系统、数据库、向量数据库 | workspace files / logs / run records、PostgreSQL、pgvector |

### 分层职责

| 分层 | 职责边界 |
| --- | --- |
| 外壳 / 产品形态层 | 呈现产品入口和用户使用形态，不承载核心 agent 逻辑。 |
| 核心 Agent 层 | 负责任务理解、计划、委派、综合输出和最终用户响应。 |
| 工具层 | 把核心 agent 的意图转成受控业务能力，不直接暴露底层系统。 |
| 连接层 | 连接外部可交互环境和远程入口，例如浏览器控制、微信入口。 |
| 存储层 | 保存工作区、结构化状态、长期记忆和向量索引；运行产物、run events 和日志归入文件系统。 |
| Harness 层 | 侧边统筹 agent 规格、fixture、eval run 和 trace，用于评估、回归和问题定位。 |

## 2. 分模块调用关系线框图

### 2.1 外壳、API 与共享配置

```mermaid
flowchart LR
  subgraph Shared["共享合同与产品配置"]
    Contracts["共享合同<br/>packages/shared/src/contracts.ts"]
    ProductProfiles["产品 Profile<br/>sitcom / novel-adaptation / study"]
    Templates["默认模板<br/>workspace templates"]
    Prompts["默认 Agent 指令<br/>product-profiles/*/prompts"]
  end

  subgraph Shell["外壳 / 入口模块"]
    Web["浏览器访问<br/>apps/web workbench"]
    Desktop["Desktop 端<br/>apps/desktop Electron"]
    WeChatEntry["微信入口<br/>remote conversation"]
  end

  subgraph Api["API 应用模块"]
    ApiClient["统一 API Client<br/>apps/web/src/api.ts"]
    HonoApp["Hono App<br/>apps/api/src/app.ts"]
    ProjectApi["项目与工作区 API"]
    ChatApi["会话 API"]
    RunApi["Agent Run + SSE API"]
    ConfigApi["Skill / 设置 / 规则 API"]
    IntegrationApi["微信 / Git / 浏览器 / 图片 / 计划任务 API"]
  end

  Web --> ApiClient --> HonoApp
  Desktop --> Web
  Desktop --> HonoApp
  WeChatEntry --> IntegrationApi

  HonoApp --> ProjectApi
  HonoApp --> ChatApi
  HonoApp --> RunApi
  HonoApp --> ConfigApi
  HonoApp --> IntegrationApi

  Contracts -. shared types .-> ApiClient
  Contracts -. shared types .-> HonoApp
  ProductProfiles -. product behavior .-> Web
  ProductProfiles -. product behavior .-> HonoApp
  Templates -. default workspace .-> ProjectApi
  Prompts -. default instructions .-> ConfigApi
```

### 2.2 核心 Agent、工具、连接与存储

```mermaid
flowchart LR
  subgraph Core["核心 Agent 模块"]
    RunService["LangGraphRunService<br/>agent run 编排"]
    SystemAgent["System Agent<br/>常驻主 agent"]
    AgentRegistry["Agent Registry<br/>加载 specialist instructions"]
    SpecialistAgents["Specialist Agents<br/>按需委派"]
    RunBus["RunBus<br/>SSE stream events"]
  end

  subgraph Tooling["工具模块"]
    WorkspaceTools["文件读写工具<br/>读写移动文件 / 知识检索"]
    MemoryTools["记忆读写工具<br/>working memory / long-term memory"]
    ConnectorTools["连接工具<br/>browser use / wechat file"]
    SkillTools["Skill 与配置工具<br/>skills / behavior rules / runtime config"]
    OpsTools["运维与项目工具<br/>Git / schedule / sync / run_bash"]
  end

  subgraph Connector["连接模块"]
    BrowserUse["Browser Use<br/>Playwriter relay + extension"]
    RemoteControl["Remote Control<br/>WeChat relay / remote session"]
  end

  subgraph Storage["存储模块"]
    FileSystem["文件系统<br/>workspace / global / skills / json state / logs / run events / generated assets"]
    Database["数据库<br/>PostgreSQL"]
    VectorDatabase["向量数据库<br/>pgvector"]
  end

  RunService --> SystemAgent
  RunService --> AgentRegistry
  RunService --> RunBus
  AgentRegistry --> SpecialistAgents
  SystemAgent --> SpecialistAgents

  SystemAgent --> WorkspaceTools
  SystemAgent --> MemoryTools
  SystemAgent --> ConnectorTools
  SystemAgent --> SkillTools
  SystemAgent --> OpsTools
  SpecialistAgents --> WorkspaceTools
  SpecialistAgents --> MemoryTools

  WorkspaceTools --> FileSystem
  MemoryTools --> Database
  MemoryTools --> VectorDatabase
  SkillTools --> FileSystem
  OpsTools --> FileSystem
  ConnectorTools --> BrowserUse
  ConnectorTools --> RemoteControl

  RunService --> Database
  RunBus --> FileSystem
  Database --> VectorDatabase
```

### 2.3 Harness 与观测评估

```mermaid
flowchart LR
  subgraph Harness["Harness 层"]
    HarnessStore["HarnessStore<br/>spec / fixture / eval run"]
    AgentSpec["AgentSpec<br/>候选 agent 规格"]
    Fixture["Fixture<br/>输入 / 文件 / 记忆 / 知识卡快照"]
    EvalRun["EvalRun<br/>候选与 active spec 对比"]
    Trace["Trace<br/>工具调用 / 记忆 / 知识检索 / 失败链路"]
    Phoenix["Phoenix<br/>OTLP trace viewer"]
  end

  subgraph Runtime["运行时被观测对象"]
    RunService["LangGraphRunService"]
    RunBus["RunBus / Stream Events"]
    WorkspaceTools["文件读写工具"]
    MemoryTools["记忆读写工具"]
  end

  subgraph Storage["Harness 数据来源"]
    FileSystem["文件系统快照"]
    Database["数据库状态"]
    VectorDatabase["向量记忆索引"]
    Logs["运行日志 / events"]
  end

  HarnessStore --> AgentSpec
  HarnessStore --> Fixture
  HarnessStore --> EvalRun
  HarnessStore --> Trace
  Trace --> Phoenix

  HarnessStore -. drives .-> RunService
  RunBus -. records .-> Trace
  WorkspaceTools -. snapshots .-> Fixture
  MemoryTools -. snapshots .-> Fixture

  Fixture --> FileSystem
  Fixture --> Database
  Fixture --> VectorDatabase
  Trace --> Logs
```

## 3. 当前抽象到实现的映射

| 抽象层级 | 抽象组件 | 当前实现 |
| --- | --- | --- |
| 外壳 / 产品形态层 | 浏览器访问 | `apps/web` React + Vite 工作台 |
| 外壳 / 产品形态层 | Desktop 端 | `apps/desktop` Electron，本地 API 与静态 Web 托管 |
| 外壳 / 产品形态层 | 微信入口 | WeChat routes / relay 状态 |
| 核心 Agent 层 | System Agent / 子 Agent 委派 | `apps/api/src/runs/langGraphRunService.ts`、`langGraphAgents.ts` |
| 工具层 | 文件读写工具 | workspace tools + `WorkspaceStore` |
| 工具层 | 记忆读写工具 | LangGraph Store namespaces + memory tools |
| 工具层 | Skill 与配置工具 | `SkillStore`、runtime config、behavior rules |
| 工具层 | 运维与项目工具 | Git、schedule、sync、run_bash 等工具能力 |
| 连接层 | Browser Use | Playwriter relay / browser extension |
| 连接层 | Remote Control | WeChat relay / remote session |
| 存储层 | 文件系统 | workspaces、skills、chat sessions、wechat state、logs、run events、generated assets |
| 存储层 | 数据库 | PostgreSQL，LangGraph checkpoint / Store |
| 存储层 | 向量数据库 | pgvector |
| Harness 层 | AgentSpec / Fixture / EvalRun / Trace | `apps/api` harness routes/store、run event 记录、Phoenix trace viewer |

## 4. 已处理的讨论意见

1. 全局分层架构图不再使用连接线，改为位置和表格表达依赖关系。
2. “产品 API 边界”从全局分层图移出，仅在分模块调用关系图中体现。
3. AIGC Hub 不再进入主图。
4. Phoenix 已移动到 Harness / 观测侧边栏。
5. Ops Tools 不再细拆，避免图过细。
6. 向量数据库只保留 pgvector，不再标注 Qdrant 预留。
7. 分模块调用关系图拆成三张：入口/API、核心/工具/存储、Harness/观测评估。
8. “运行产物与日志”并入文件系统，不再作为独立存储节点。

## 5. 正式图落版约定

1. 全局分层图采用左侧 Harness 侧栏 + 右侧五层堆叠的经典分层布局。
2. 分模块调用关系图保持拆分呈现，分别表达入口/API、核心/工具/存储、Harness/观测评估。
3. “运行产物与日志”并入文件系统，不再单独绘制存储节点。

