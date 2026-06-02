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

## 记忆与上下文

当前 spike 使用 `@mastra/memory`：

- `lastMessages: 12` 保留短期对话。
- `workingMemory` 以 project/resource 维度保存用户偏好、项目长期设定、角色关系和伏笔。
- `semanticRecall` 暂时关闭，因为需要先确定 embeddings provider 和成本。
- `LibSQLStore` 默认写入 `~/.viwork/data/mastra-memory.db`。

上下文控制使用 `TokenLimiterProcessor({ limit: 100_000, strategy: 'truncate' })`。这是截断，不是 LLM 摘要；后续正式迁移需要在 reviewer 每轮结束后增加“创作状态摘要”步骤，用结构化摘要替代无限堆历史消息。

## 模型配置

默认模型配置：

- `VIWORK_MASTRA_MODEL`，默认 `ds/deepseek-v4-pro`
- `VIWORK_MASTRA_BASE_URL`，默认 `https://api.yukeon.top/v1`
- `VIWORK_MASTRA_API_KEY`，其次使用 `OPENAI_API_KEY` / `CODEX_API_KEY`

Mastra 支持 OpenAI-compatible config，当前不需要 LiteLLM gateway。

## 下一步

这次 spike 只跑通“单 agent + memory + workspace tools + streaming events”链路。正式替换前还需要：

- 用 Mastra workflow 表达 `source-analyst-agent -> adaptation-planner-agent -> screenwriter-agent -> reviewer-agent -> rewrite` 的返工闭环。
- 把 `Agent 配置/skills/*/SKILL.md` 翻译成 Mastra agent instructions 或显式子 agent。
- 为 reviewer 轮次增加结构化摘要，避免只依赖 `TokenLimiterProcessor` 截断上下文。
- 增加真实模型联调测试，并确认 deepseek 对 Mastra tool calling 的兼容性。
