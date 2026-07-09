# Codex Agent 运行时

## 入口

Codex agent 后端实现位于 [apps/api/src/runs/codexRunService.ts](../../apps/api/src/runs/codexRunService.ts)。

API 路由：

- [apps/api/src/routes/runs.ts](../../apps/api/src/routes/runs.ts)
- [apps/api/src/routes/runEvents.ts](../../apps/api/src/routes/runEvents.ts)

事件总线：

- [apps/api/src/runs/runBus.ts](../../apps/api/src/runs/runBus.ts)

## 创建 Run

前端调用：

```ts
apiClient.createRun({
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

提交入口和 Codex 执行链路会额外写入 `logs/api-runs.jsonl`，每行是一个 JSON 事件，包含：

- `request.received` / `response.created`：`POST /api/runs` 的请求体和返回值。
- `prompt.built`：后端最终拼出的 Codex prompt。
- `codex.home.prepared`：本次会话复制出的 Codex HOME 路径、根文件和 skill frontmatter 状态，不记录 `auth.json` 内容。
- `thread.options` / `thread.runStreamed.input`：发给 Codex SDK 的线程参数和 prompt。
- `codex.event` / `stream.publish`：Codex SDK 原始事件摘要和广播给前端的 SSE 事件。
- `execute.error`：失败时的原始错误、stack 和当前已累积的 assistant/tool 输出状态。

## Codex SDK 接入

当前使用 `@openai/codex-sdk`：

```ts
const runtimeCodex = codex ?? new Codex({
  codexPathOverride: await resolveCodexPathOverride(codexPathOverride),
  env: buildCodexEnv(codexHome),
});
```

`resolveCodexPathOverride()` 优先使用显式传入值或 `CODEX_PATH`，否则从当前 `PATH` 查找 `codex` 可执行文件。找不到时会抛出清晰的运行错误，而不是依赖机器相关的写死路径。

线程选择：

- 有 `codexThreadId`：`resumeThread(codexThreadId, threadOptions)`
- 无 `codexThreadId`：`startThread(threadOptions)`

Codex thread id 通过 `thread.started` 流事件回传前端，并写入 `ChatSession.codexThreadId`。这保证多轮对话连续。

## Codex HOME

`prepareCodexHome(store, sessionKey)` 为每个会话或 run 创建稳定 HOME：

```text
~/.viforge/data/<productId>/workspaces/.codex-home/<sessionId 或 runId>
```

来源目录：

```text
~/.viforge/data/<productId>/workspaces/_global/Agent 配置
```

复制内容：

- `AGENTS.md`
- `auth.json`
- `installation_id`
- `skills`
- `plugins`

`config.toml` 不会原样复制。后端会先生成一份"清理过的"副本：

- 保留顶层 `model`、`model_provider`、`model_reasoning_effort`、`disable_response_storage`、`approval_policy`、`sandbox_mode`，以及 `[model_providers.*]` 和 `[viforge]` 这些与 viforge 创作直接相关的 section。
- 丢弃宿主机器上 `~/.codex/config.toml` 里其它项目的 `[projects."..."] trust_level`、TUI 设置等无关条目，避免开发者的个人 Codex 配置污染 viforge 会话。
- 在文件末尾追加 `[skills.bundled] enabled = false`，关闭 Codex 自带的 system skills（`imagegen`、`openai-docs`、`plugin-creator`、`skill-creator`、`skill-installer`），并按需为宿主机上 `~/.codex/skills` 和 `~/.agents/skills` 里的每个目录生成 `[[skills.config]] name = "..." enabled = false` 规则，关掉泄漏进来的 user-level skills（例如开发本机的 `find-skills`、`gemini-api-dev`）。
- 最终结果只让 `_global/Agent 配置/skills` 下的 viforge 自身 skills 出现在 Codex 的 prompt 里。

注意：运行时不是直接使用全局 Agent 配置目录，而是复制到 `.codex-home/<sessionKey>`，避免 Codex 修改用户维护的全局配置。

## Codex 运行参数

`threadOptions`：

- `workingDirectory`：当前项目目录。
- `additionalDirectories`：全局 `知识库` 和 `模板库`。
- `skipGitRepoCheck: true`
- `sandboxMode: 'danger-full-access'`
- `approvalPolicy: 'never'`
- `networkAccessEnabled: true`
- `modelReasoningEffort: 'medium'`

当前产品采用后端预授权模式：不在运行时等待审批弹窗，而是直接给 Codex CLI 本机文件访问和网络访问权限。这样可以避免后端异步会话因为 `approval policy is Never; reject command` 卡住或失败。

`buildCodexEnv(codexHome)` 设置：

- `CODEX_HOME`
- `CODEX_API_KEY`
- `XDG_CACHE_HOME`
- `UV_CACHE_DIR`
- `PIP_CACHE_DIR`
- `NPM_CONFIG_CACHE` / `npm_config_cache`

这些 cache 目录都指向 `CODEX_HOME/.cache` 下，避免 `uv`、`pip`、`npm` 等工具尝试写入 `/home/<user>/.cache` 造成跨会话污染或权限问题。

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
- `_global/Agent 配置/AGENTS.md` 的完整正文（作为 `## viforge 多 agent 工作协议` block 直接拼进 prompt）。
- 当前项目创作目标和 system agent 工作协议。
- 全局 `[viforge].max_revision_rounds`，并要求 agent trace 的 `maxIterations` 与该值一致。

引用文件由前端传入 `referencedFiles`，后端按项目目录读取内容。

## 项目隔离与系统提示词

Codex CLI 在 `--cd` 指定的目录里会向上递归查找 `AGENTS.md`，并把它注入 system prompt。如果不隔离，宿主机上其它项目（比如 `/home/wbo/project/<repo>/AGENTS.md`）的编码规范就会污染 viforge 的 system agent，表现为"指令是 Codex 自带但描述的是编码场景"。后端通过两件事避免这件事：

- `WORKSPACES_ROOT` 默认落到 `~/.viforge/data/<productId>/workspaces`（参见 [02 工作区文件系统](./02-workspace-filesystem.md)），让 Codex 的运行时 CWD、`<CODEX_HOME>/AGENTS.md` 都不在 viforge 源码树里，上溯查不到 viforge 项目根的 `AGENTS.md`。
- `buildCodexPrompt` 直接把 viforge 自己的多 agent 协议拼进 prompt，不依赖 Codex 加载 `$CODEX_HOME/AGENTS.md`，所以即便 Codex 未来再次变化，也不会让别的 AGENTS.md 偷偷混进 system prompt。

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
- `agent.step.start`
- `agent.step.end`
- `agent.review.reject`
- `agent.workflow.end`
- `run.end`

`agent.*` 事件来自 system agent 输出的固定 JSON block。后端在 `agent_message` 文本中解析这些 JSON block，转换为结构化 `StreamEvent`，前端用它展示 agent timeline、返工轮次、打回原因和最终写入状态。脑暴是普通对话，不要求输出 `agent.*` trace，也不进入 reviewer 或返工机制；system agent 不应只输出路由说明，而应在同一条 Codex stream 中直接给出 brainstorm-agent 的实质内容。V1 先采用 JSON block 解析，后续如果需要更强流程保证，再升级为后端 orchestrator。

面向产品聊天的 Codex prompt 明确禁止调用 `update_plan` 或维护内部 TODO/计划。前端不会展示 Codex CLI 内部计划工具，所有用户需要看到的进度都必须通过普通回复文本或 `agent.*` trace JSON 输出。

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
