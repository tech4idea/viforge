# LangGraph Agent 运行时

本文记录 LangGraph 作为 viforge 创作 agent 引擎的当前实现。当前 API 默认通过 LangGraph/LangChain 执行常规文本创作 run，不再依赖 Mastra runtime。

## 当前依赖

API 侧核心依赖：

- `@langchain/langgraph`
- `@langchain/core`
- `@langchain/openai`
- `@opentelemetry/api`
- `@opentelemetry/exporter-trace-otlp-http`
- `pg`

模型调用仍走 AIGC Hub 的 OpenAI-compatible `/v1/chat/completions` 接口。默认配置优先级：

- `VIFORGE_AIGC_HUB_CHAT_MODEL` / `AIGC_HUB_CHAT_MODEL`
- `VIFORGE_LANGGRAPH_MODEL`
- 默认 `ds/deepseek-v4-pro`

网关地址和密钥优先读取：

- `VIFORGE_AIGC_HUB_BASE_URL` / `AIGC_HUB_BASE_URL`
- `VIFORGE_LANGGRAPH_BASE_URL`
- `OPENAI_BASE_URL`
- `VIFORGE_AIGC_HUB_API_KEY` / `AIGC_HUB_API_KEY`
- `VIFORGE_LANGGRAPH_API_KEY`
- `OPENAI_API_KEY` / `CODEX_API_KEY`

## 启动方式

正常启动 API 即使用 LangGraph：

```bash
pnpm --filter @viforge/api dev
```

入口位于 [apps/api/src/runs/langGraphRunService.ts](../../apps/api/src/runs/langGraphRunService.ts)。API 组合入口 [apps/api/src/app.ts](../../apps/api/src/app.ts) 装配 `createLangGraphRunService(workspaceStore, runBus)`。

## 已跑通链路

LangGraph run service 实现统一的 `RunService` 接口：

1. `POST /api/runs` 创建 run。
2. 后端发布 `run.start` 和 `thread.started`。
3. 构造创作 prompt，包含用户输入、引用文件和引用聊天片段。
4. 创建 LangGraph ReAct agent，并通过 LangChain `ChatOpenAI` 调用 AIGC Hub。
5. 暴露 viforge 业务级 workspace tools，而不是 raw shell：
   - `list_workspace_entries`
   - `read_workspace_file`
   - `write_workspace_file`
   - `delete_workspace_file`
   - `move_workspace_entry`
   - `run_bash`
   - `sync_to_remote`
   - `read_global_file`
   - `read_project_memory`
   - `update_project_memory`
   - `recall_project_memory`
   - `remember_project_memory`
   - `retrieve_knowledge_cards`
   - `generate_project_image`
   - `edit_project_image`
   - 微信入口下额外提供 `send_wechat_file`
6. 消费 LangGraph/LangChain stream events，并映射为前端已支持的 `StreamEvent`：
   - `text.delta`
   - `tool_use.start`
   - `tool_use.delta`
   - `tool_use.end`

## Playwriter Browser Tools

LangGraph runtime 现在通过 Playwriter 暴露浏览器能力，目标是连接用户已登录、已授权的真实浏览器标签页，而不是启动一个全新的无状态浏览器。API 通过 Playwriter CLI 执行浏览器动作，CLI 路径默认 `playwriter`，可用 `VIFORGE_PLAYWRITER_BIN` 覆盖。API 默认连接 `VIFORGE_PLAYWRITER_HOST`，未设置时使用 `http://127.0.0.1:19988`；如 Playwriter relay 配置了 token，可设置 `VIFORGE_PLAYWRITER_TOKEN`。默认 session id 可用 `VIFORGE_PLAYWRITER_SESSION_ID` 覆盖，未设置时会自动创建并复用 session。桌面版会由 Electron 主进程自动启动本机 relay，用户只需要安装浏览器扩展并授权标签页；普通 Web/API 部署仍需要手动启动 `playwriter serve`。

Agent 可用工具：

- `browser_status`：检查 Playwriter host 和启用状态。
- `browser_use_install`：当 Playwriter CLI、relay 或浏览器授权缺失时，返回安装和连接指引。
- `browser_navigate`：在授权标签页打开 URL。
- `browser_snapshot`：读取 Playwriter 的页面可访问性快照，获取文字、链接、控件和 aria-ref。
- `browser_evaluate`：执行简短 Playwright JavaScript，作用域包含 `page`、`context`、`state`、`require`。

安全边界：登录、提交、购买、删除、发布、授权、付款或修改远端数据前，agent 必须先向用户说明动作并等待确认。Playwriter 未连接时，agent 应明确提示用户安装/启用 Playwriter 扩展并授权标签页；非桌面部署还需要启动 `playwriter serve`。agent 不能假装已访问网页。

普通 Web/API 本地启用步骤如下；agent 也可以在用户需要网页访问但环境未就绪时调用 `browser_use_install` 返回同类指引：

```bash
npm i -g playwriter
playwriter serve --host 127.0.0.1
```

浏览器侧需要安装 remorses/playwriter 的 Chrome 扩展，并在要授权给 agent 的标签页点击扩展图标。需要独立 session 时可先执行 `playwriter session new`，再把返回的 id 设置为 `VIFORGE_PLAYWRITER_SESSION_ID`。
默认不需要手动创建 session；ViForge 会在首次浏览器工具调用时自动创建并复用 Playwriter session。
   - `file.changed`
   - `image.generated`
   - `wechat.file_sent`
   - `run.end`

测试入口是 [apps/api/src/runs/langGraphRunService.test.ts](../../apps/api/src/runs/langGraphRunService.test.ts)，覆盖文本流、工具事件、文件变更、按需委派和图片生成工具。

## Agent 协作与交互机制

当前 LangGraph 多 agent 实现保持“主 agent 常驻 + specialist agent 按需委派”的产品行为。入口在 [apps/api/src/runs/langGraphRunService.ts](../../apps/api/src/runs/langGraphRunService.ts)，agent 创建和工具适配在 [apps/api/src/runs/langGraphAgents.ts](../../apps/api/src/runs/langGraphAgents.ts)。

### 1. 主 Agent 默认工作

每次 run 会创建一个 `viforge-system-agent` 作为主 agent。主 agent 接收完整用户请求、引用文件和引用聊天片段，默认直接处理普通问候、问答解释、资料整理、轻量润色、局部文件写入和一般创作讨论。

主 agent 的 instructions 由两部分组成：

- active product 的 system agent 协议：`Agent 配置/AGENTS.md`。
- 后端追加的调度原则：普通任务直接完成，只有明确需要专业能力时才委派。

### 2. Specialist Agent 注册

每次 run 开始后，后端调用 `createAgentRegistry()` 创建 specialist registry：

- `brainstorm-agent`
- `character-agent`
- `continuity-agent`
- `story-agent`
- `source-analyst-agent`
- `adaptation-planner-agent`
- `screenwriter-agent`
- `reviewer-agent`
- `systemAgent()`

specialist instructions 来自全局工作区：

```text
Agent 配置/skills/<agent-id>/SKILL.md
```

读取后会去掉 YAML frontmatter，只把正文作为 LangGraph agent instructions。默认初始化内容来自产品 profile 对应的 prompt 文件：

```text
packages/shared/src/product-profiles/<product>/prompts/*.md
```

### 3. 工具与委派

主 agent 额外拥有工具：

```text
delegate_to_specialist_agent
```

参数包括：

```json
{
  "agentId": "brainstorm-agent | character-agent | continuity-agent | story-agent | source-analyst-agent | adaptation-planner-agent | screenwriter-agent | reviewer-agent",
  "task": "交给 specialist 的具体子任务",
  "context": "主 agent 已读取或判断出的上下文"
}
```

主 agent 决定是否委派；后端不做固定分类，也不强制所有请求进入完整流水线。specialist 结果作为工具结果返回给主 agent，主 agent 再综合、写文件或回复用户。

### 4. 记忆

LangGraph agent 当前按官方推荐拆成两类记忆：

- 短期对话状态：使用 checkpointer 保存 graph state，`thread_id` 使用当前 `sessionId` 或 runId，specialist 使用 `<threadId>-<agentId>` 隔离短期上下文。
- 长期跨线程记忆：使用 LangGraph `BaseStore`，按命名空间存储项目级 working memory 和语义记忆。

如果设置了 `DATABASE_URL`，API 会初始化：

- `PostgresSaver`，schema 为 `langgraph`，用于 LangGraph checkpoint 表。
- `PostgresStore`，schema 为 `langgraph_store`，用于 LangGraph Store 表。

运行态必须配置 PostgreSQL：桌面单机模式由 API 启动内置 PostgreSQL binary 并写入 `DATABASE_URL`，服务模式应通过外部 PostgreSQL 或 Docker Compose 注入 `DATABASE_URL`。`MemorySaver` + `InMemoryStore` 只作为自动化测试后备，需显式设置 `VIFORGE_LANGGRAPH_ALLOW_IN_MEMORY=1`，不作为产品运行模式暴露。

项目长期记忆由 viforge 自己的工具层实现：

- `read_project_memory` / `update_project_memory`：读写 `['viforge', 'projects', projectId, 'working-memory']` 命名空间下的结构化 Markdown 记忆。
- `remember_project_memory` / `recall_project_memory`：读写 `['viforge', 'projects', projectId, 'memories']` 命名空间下的精选长期记忆，并通过 LangGraph Store 的 `search()` 检索。

这些工具会额外发布 Harness 可消费的运行事件：

- `memory.read`：记录读取 workspace 记忆和字节数。
- `memory.write`：记录写入的记忆类型、authority 和内容摘要来源。
- `memory.recall`：记录 recall query 和结构化 `MemoryRecord` matches。

这些事件用于后续从失败 run 生成 EvalFixture，避免回归案例只保存拼接后的 prompt 文本而丢失记忆来源。

### 4.1 知识库检索

`retrieve_knowledge_cards` 从全局工作区的 `知识库/index.yaml` 读取机制卡索引；如果索引不存在，会退化为扫描 `知识库/**/*.md`。检索结果只作为创作启发，工具说明中明确禁止复制具体台词、完整桥段、人物身份或受版权保护表达。

知识库检索会发布 `knowledge.retrieve` 事件，记录 query 和返回的 `KnowledgeBaseEntry` 列表。EvalFixture 可以把这些结果保存为 `knowledgeFixture`，使 candidate 和 active spec 比较时使用同一组知识输入。

语义检索配置：

- 有 AIGC Hub API key 时，`PostgresStore` 启用 vector index，embedding 模型使用 `VIFORGE_AIGC_HUB_EMBEDDING_MODEL`，维度默认 `1024`，可用 `VIFORGE_LANGGRAPH_STORE_EMBEDDING_DIMS` 覆盖。
- 未配置 embedding key 时，`PostgresStore` 仍持久化长期记忆，`search()` 退化为 PostgreSQL 文本搜索。

前端聊天会话 JSON 只负责 UI 历史展示，不再手动拼接进 prompt；多轮上下文由 LangGraph checkpointer 依据 `thread_id` 自动恢复。

### 5. Phoenix 观测接入

API 支持通过 OpenTelemetry OTLP/HTTP 向 Phoenix 上报 LangGraph 和 LangChain traces/spans。配置：

```bash
PHOENIX_COLLECTOR_ENDPOINT=http://192.168.43.167:6006
PHOENIX_PROJECT_NAME=viforge
PHOENIX_SERVICE_NAME=viforge-api
```

开启后，API 启动时初始化 `NodeTracerProvider`，将 spans 发送到 `${PHOENIX_COLLECTOR_ENDPOINT}/v1/traces`。上报内容包括：

- run 级 span：`langgraph.<agent-id>.stream` / `langgraph.<agent-id>.generate`，包含 `runId`、`traceId`、`projectId`、`sessionId`、`productId`、`threadId` 和输入输出预览。
- LangChain callback spans：chain、chat model/LLM、tool 的 start/end/error，保留父子关系，带 `langchain.run_id`、agent id、项目和产品 metadata。
- error span status 和 exception 记录，便于在 Phoenix 中按 failed span 定位。

### 6. 前端事件

后端仍只向前端暴露统一 `StreamEvent`。前端不需要知道 LangGraph 内部事件结构，只消费已有 SSE 事件。

specialist 阶段会额外发布：

- `agent.step.start`
- `agent.step.end`

## 当前边界

当前迁移保持功能等价：主 agent 按需委派、workspace tools、图片工具、微信桥接和 SSE 事件都沿用原产品行为。

仍可继续增强：

- 为 `delegate_to_specialist_agent` 增加更严格的输出 schema。
- 让 reviewer 返回结构化 `passed / rejected / targetAgentId / reasons`。
- 主 agent 根据 reviewer 结果自主决定是否再委派返工。
- 为复杂委派结果增加结构化摘要，避免上下文无限增长。
