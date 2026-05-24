# Codex Agent 运行时

## 入口

Codex agent 后端实现位于 [apps/api/src/runs/codexRunService.ts](/Users/yukeon/project/viwork/apps/api/src/runs/codexRunService.ts)。

API 路由：

- [apps/api/src/routes/runs.ts](/Users/yukeon/project/viwork/apps/api/src/routes/runs.ts)
- [apps/api/src/routes/runEvents.ts](/Users/yukeon/project/viwork/apps/api/src/routes/runEvents.ts)

事件总线：

- [apps/api/src/runs/runBus.ts](/Users/yukeon/project/viwork/apps/api/src/runs/runBus.ts)

## 创建 Run

前端调用：

```ts
apiClient.createMockRun({
  projectId,
  sessionId,
  codexThreadId,
  prompt,
  referencedFiles,
});
```

后端 `POST /api/runs` 校验参数后调用 `RunService.createRun()`。

`AgentRun` 立即返回，真正执行通过 `void executeCodexRun(...)` 后台异步进行。前端随后订阅：

```ts
GET /api/runs/:runId/events
```

## Codex SDK 接入

当前使用 `@openai/codex-sdk`：

```ts
const runtimeCodex = codex ?? new Codex({
  codexPathOverride: process.env.CODEX_PATH ?? '/opt/homebrew/Cellar/node/23.11.0/bin/codex',
  env: buildCodexEnv(codexHome),
});
```

线程选择：

- 有 `codexThreadId`：`resumeThread(codexThreadId, threadOptions)`
- 无 `codexThreadId`：`startThread(threadOptions)`

Codex thread id 通过 `thread.started` 流事件回传前端，并写入 `ChatSession.codexThreadId`。这保证多轮对话连续。

## Codex HOME

`prepareCodexHome(store, sessionKey)` 为每个会话或 run 创建稳定 HOME：

```text
apps/api/data/.codex-home/<sessionId 或 runId>
```

来源目录：

```text
apps/api/data/workspaces/_global/Agent 配置
```

复制内容：

- `AGENTS.md`
- `config.toml`
- `skills`
- `plugins`

注意：运行时不是直接使用全局 Agent 配置目录，而是复制到 `.codex-home/<sessionKey>`，避免 Codex 修改用户维护的全局配置。

## Codex 运行参数

`threadOptions`：

- `workingDirectory`：当前项目目录。
- `additionalDirectories`：全局 `知识库` 和 `模板库`。
- `skipGitRepoCheck: true`
- `sandboxMode: 'workspace-write'`
- `approvalPolicy: 'never'`
- `networkAccessEnabled: false`
- `modelReasoningEffort: 'medium'`

`buildCodexEnv(codexHome)` 设置：

- `CODEX_HOME`
- `CODEX_API_KEY`

`CODEX_API_KEY` 优先级：

1. `CODEX_API_KEY`
2. `OPENAI_API_KEY`
3. `ANTHROPIC_AUTH_TOKEN`
4. 空字符串

## Prompt 构建

`buildCodexPrompt(store, input)` 会组合：

- 用户 prompt。
- 引用文件列表。
- 引用文件内容。
- 当前项目创作目标。

引用文件由前端传入 `referencedFiles`，后端按项目目录读取内容。

## 流式事件

Codex SDK 的 `ThreadEvent` 被映射为共享 `StreamEvent`：

- `run.start`
- `thread.started`
- `text.delta`
- `thinking.delta`
- `thinking.end`
- `tool_use.start`
- `tool_use.delta`
- `tool_use.end`
- `file.changed`
- `run.end`

事件由 `RunBus.publish(event)` 缓存并广播。

`RunBus` 特性：

- 每个 run 最多缓存 2048 个事件。
- 新 subscriber 会先收到已缓存事件。
- `run.end` 后 60 秒清理 buffer。

## SSE

SSE 路由 `GET /api/runs/:runId/events`：

- content-type：`text/event-stream`
- 初始发送 `retry: 2000`
- 15 秒 heartbeat
- `run.end` 后自动关闭

前端 `apiClient.streamRunEvents` 使用 `EventSource` 订阅，并在 `run.end` 后关闭。

