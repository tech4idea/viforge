# Mastra Agent 运行时

本文记录 Mastra 作为 viwork 创作 agent 引擎的当前实现。当前小说改编剧本版本默认使用 Mastra，不再把 Codex runtime 作为常规文本创作入口。

## 当前版本

已核对 npm 当前版本：

- `mastra`: `1.10.2`
- `@mastra/core`: `1.37.1`
- `@mastra/memory`: `1.20.0`
- `@mastra/libsql`: `1.11.1`

这些包要求 Node `>=22.13.0`，当前项目的 Node 版本满足要求。

## 启动方式

正常启动 API 即使用 Mastra：

```bash
pnpm --filter @viwork/api dev
```

入口位于 [apps/api/src/runs/mastraRunService.ts](../../apps/api/src/runs/mastraRunService.ts)。API 组合入口 [apps/api/src/app.ts](../../apps/api/src/app.ts) 直接装配 `createMastraRunService(workspaceStore, runBus)`。

## 已跑通链路

Mastra run service 实现 `RunService` 接口：

1. `POST /api/runs` 创建 run。
2. 后端发布 `run.start` 和 `thread.started`。
3. 构造小说改编剧本创作 prompt，包含引用文件和引用聊天片段。
4. 创建 Mastra `Agent`，并接入 `Memory` + `LibSQLStore`。
5. 暴露 viwork 业务级 workspace tools，而不是 raw shell：
   - `list_workspace_entries`
   - `read_workspace_file`
   - `write_workspace_file`
   - `read_global_file`
6. 消费 Mastra `fullStream`，映射为现有前端已支持的 `StreamEvent`：
   - `text.delta`
   - `thinking.delta`
   - `tool_use.start`
   - `tool_use.delta`
   - `tool_use.end`
   - `file.changed`
   - `run.end`

测试入口是 [apps/api/src/runs/mastraRunService.test.ts](../../apps/api/src/runs/mastraRunService.test.ts)，验证了 agent stream、workspace tool 写文件、`file.changed` 和 SSE 事件链路。

## Agent 协作与交互机制

当前 Mastra 多 agent 实现采用“主 agent 常驻 + specialist agent 按需委派”的模型，不再做固定的 `分类 -> 串行流水线`。入口仍在 [apps/api/src/runs/mastraRunService.ts](../../apps/api/src/runs/mastraRunService.ts)，具体 agent 创建逻辑在 [apps/api/src/runs/mastraAgents.ts](../../apps/api/src/runs/mastraAgents.ts)。

### 1. 主 Agent 默认工作

每次 run 会创建一个 `viwork-system-agent` 作为主 agent。主 agent 接收完整用户请求、引用文件和引用聊天片段，默认直接处理：

- 普通问候。
- 问答解释。
- 读取和整理资料。
- 轻量润色或局部修改。
- 用户明确指定路径的小范围文件写入。
- 一般创作讨论。

这样避免用户只是打招呼、问一个文件问题、改一句台词时也被拉进固定创作流水线。

主 agent 的 instructions 由两部分组成：

- active product 的 system agent 协议：`Agent 配置/AGENTS.md`。
- 后端追加的调度原则：普通任务直接完成，只有明确需要专业能力时才委派。

### 2. Specialist Agent 注册

每次 run 开始后，后端仍调用 `createAgentRegistry()` 创建 specialist registry：

- `brainstorm-agent`：明确的脑暴方向探索。
- `character-agent`：明确的人物设定、角色关系、行为边界和喜剧缺点设计。
- `continuity-agent`：明确的多集连续性、既有设定、历史剧情和场景规则检查。
- `source-analyst-agent`：明确的原著分析。
- `adaptation-planner-agent`：明确的改编方案、分集规划。
- `screenwriter-agent`：明确的剧本创作。
- `reviewer-agent`：明确的严格审稿。
- `systemAgent()`：创建主 agent 或其它系统用途 agent。

specialist instructions 来自全局工作区：

```text
Agent 配置/skills/<agent-id>/SKILL.md
```

读取后会去掉 YAML frontmatter，只把正文作为 Mastra agent instructions。默认初始化内容来自产品 profile 对应的 prompt 文件：

```text
packages/shared/src/product-profiles/<product>/prompts/*.md
```

### 3. 工具与委派

所有 agent 都使用 viwork workspace tools，而不是 shell 或任意文件系统权限：

- `list_workspace_entries`：列出当前项目文件树。
- `read_workspace_file`：读取当前项目文件。
- `write_workspace_file`：写入当前项目文件，并发布 `file.changed`。
- `read_global_file`：读取全局知识库、模板或 Agent 配置。
- `generate_project_image`：通过 AIGC Hub 生成图片，保存到当前项目工作区 `生成图片/`，并发布 `file.changed`。

`generate_project_image` 读取 API 服务进程环境变量：

```text
VIWORK_AIGC_HUB_BASE_URL
VIWORK_AIGC_HUB_API_KEY
VIWORK_AIGC_HUB_IMAGE_MODEL
```

用户在 Web 或微信里明确要求“生成图片 / 画一张角色图 / 出一张场景图 / 生成剧照或分镜图”时，主 agent 可以直接调用该工具。用户只是要视觉描述或绘图提示词时，主 agent 应直接输出文本，不调用图片工具。

主 agent 额外拥有一个工具：

```text
delegate_to_specialist_agent
```

该工具只在明确需要专业事项时使用。参数包括：

```json
{
  "agentId": "brainstorm-agent | character-agent | continuity-agent | source-analyst-agent | adaptation-planner-agent | screenwriter-agent | reviewer-agent",
  "task": "交给 specialist 的具体子任务",
  "context": "主 agent 已读取或判断出的上下文"
}
```

主 agent 决定是否委派；后端不再预先硬分类，也不强制跑完整流水线。

### 4. 上下文传递

主 agent 收到 `buildMastraPrompt()` 生成的完整请求，包含：

- 产品 profile 的 Mastra 请求标题。
- 用户输入。
- `@` 引用的项目文件内容。
- 引用的聊天片段。

当主 agent 调用 `delegate_to_specialist_agent` 时，后端把 `task` 和 `context` 组成 specialist prompt。specialist 的流式输出会实时回到同一条前端事件流，同时工具结果会返回给主 agent。主 agent 继续综合 specialist 结果，决定下一步是回复、继续读写文件，还是再委派另一个 specialist。

交互模型可以概括为：

```text
用户请求
  -> 主 agent 直接处理
  -> 如确有需要，调用 delegate_to_specialist_agent
  -> specialist 完成专业子任务并返回结果
  -> 主 agent 综合、写文件或回复用户
```

### 5. 记忆隔离

每个 agent 都接入 `@mastra/memory` + `LibSQLStore`，默认写入：

```text
~/.viwork/data/<productId>/mastra-memory.db
```

主 agent 使用当前会话 thread：

```text
<threadId>
```

specialist agent 使用独立 thread：

```text
<threadId>-<agentId>
```

这样主 agent 能保持自然连续对话，specialist 的短期消息历史也不会完全混在一起。`resource` 统一使用 `projectId`，让 working memory 仍然按项目维度组织。

### 6. 前端事件

后端把 specialist 阶段包装成统一 SSE 事件：

- specialist 开始：`agent.step.start`
- agent 文本：`text.delta`
- 推理过程：`thinking.delta`
- 工具调用：`tool_use.start` / `tool_use.delta` / `tool_use.end`
- 文件变化：`file.changed`
- specialist 结束：`agent.step.end`
- run 结束：`run.end`

主 agent 自己的输出仍然是普通 `text.delta` 和 tool events。前端不需要知道 Mastra 内部对象，只消费统一的 `StreamEvent`。

### 7. 当前边界

当前实现已经去掉固定串行编排，但还没有做“reviewer 结构化打回后自动返工”的闭环。后续如果需要闭环，也应作为主 agent 可选择调用的能力，而不是所有请求默认进入流水线。

后续可以继续增强：

- 为 `delegate_to_specialist_agent` 增加更严格的输出 schema。
- 让 reviewer 返回结构化 `passed / rejected / targetAgentId / reasons`。
- 主 agent 根据 reviewer 结果自主决定是否再委派返工。
- 每次复杂委派后生成结构化创作状态摘要，减少上下文无限增长。

## 记忆与上下文

当前 spike 使用 `@mastra/memory`：

- `lastMessages: 12` 保留短期对话。
- `workingMemory` 以 project/resource 维度保存用户偏好、项目长期设定、角色关系和伏笔。
- `semanticRecall` 暂时关闭，因为需要先确定 embeddings provider 和成本。
- `LibSQLStore` 默认写入 `~/.viwork/data/<productId>/mastra-memory.db`。

上下文控制使用 `TokenLimiterProcessor({ limit: 100_000, strategy: 'truncate' })`。这是截断，不是 LLM 摘要；后续正式迁移需要在 reviewer 每轮结束后增加“创作状态摘要”步骤，用结构化摘要替代无限堆历史消息。

## 模型配置

默认模型配置：

- `VIWORK_MASTRA_MODEL`，默认 `ds/deepseek-v4-pro`
- `VIWORK_MASTRA_BASE_URL`，默认 `https://api.yukeon.top/v1`
- `VIWORK_MASTRA_API_KEY`，其次使用 `OPENAI_API_KEY` / `CODEX_API_KEY`

Mastra 支持 OpenAI-compatible config，当前不需要 LiteLLM gateway。

## 下一步

当前主线已经从固定流水线切换为“主 agent + 按需委派”。后续重点是让委派更可控，而不是恢复硬编码流程：

- 为 `delegate_to_specialist_agent` 增加更细的测试覆盖，验证普通问候不会触发 specialist，明确审稿/创作请求才会触发。
- 为 reviewer 增加结构化输出 schema，让主 agent 可以根据 `passed / rejected / targetAgentId / reasons` 自主决定是否继续委派返工。
- 为复杂委派结果增加结构化摘要，避免只依赖 `TokenLimiterProcessor` 截断上下文。
- 增加真实模型联调测试，并确认当前网关模型对 Mastra tool calling 的兼容性。
