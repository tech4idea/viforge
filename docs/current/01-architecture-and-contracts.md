# 架构与共享合同

## 模块边界

当前版本采用 pnpm workspace：

- `apps/web` 只通过 `apps/web/src/api.ts` 访问后端，不直接读写本地文件。
- `apps/api` 封装文件系统、Codex SDK、SSE、技能和微信状态。
- `packages/shared` 提供前后端共享类型与默认工作区模板。

API 服务由 [apps/api/src/app.ts](/Users/yukeon/project/viwork/apps/api/src/app.ts) 装配：

```ts
app.route('/api', createProjectsRoutes(workspaceStore));
app.route('/api', createChatSessionRoutes(createChatSessionStore(...)));
app.route('/api', createRunsRoutes(createCodexRunService(workspaceStore, runBus), runBus));
app.route('/api', createRunEventsRoutes(runBus));
app.route('/api', createSkillsRoutes(createSkillStore(...)));
app.route('/api', createWechatRoutes(createWechatStore(...)));
```

## 共享类型

共享合同位于 [packages/shared/src/contracts.ts](/Users/yukeon/project/viwork/packages/shared/src/contracts.ts)。

核心类型：

- `Project`：情景剧项目元信息。
- `WorkspaceEntry` / `WorkspaceFile`：文件树条目和文本文件内容。
- `ReferencedFile`：创作助手引用文件。
- `AgentRun`：一次 Codex agent 运行。
- `ChatSession` / `ChatMessage`：后端持久化会话和消息。
- `RunEvent`：兼容一次性 run 返回的事件格式。
- `StreamEvent`：当前 SSE 流式事件格式，包含文本、思考、工具调用、文件变更和结束事件。
- `TheaterSkill`：技能广场条目。
- `WechatStatus` / `WechatSetupSession`：微信接入状态。

后续增加前后端共享数据结构时，应优先加到 `packages/shared/src/contracts.ts`，再在 `apps/web/src/api.ts` 和 API 路由中使用同一类型。

## 默认模板

默认目录和文件模板位于 [packages/shared/src/templates.ts](/Users/yukeon/project/viwork/packages/shared/src/templates.ts)。

全局区默认结构：

- `Agent 配置`
- `Agent 配置/skills`
- `知识库`
- `知识库/编剧知识`
- `知识库/写作知识`
- `知识库/素材库`
- `模板库`

项目区默认结构按创作顺序编号：

- `01 基本设定`
- `02 故事`
- `03 剧本`
- `04 分镜脚本`
- `05 视频`
- `06 产物`

创建项目时由 `createDefaultWorkspaceFiles(topic)` 生成项目文档，由 `createDefaultGlobalWorkspaceFiles()` 生成全局文件。

## API Client

前端 API client 位于 [apps/web/src/api.ts](/Users/yukeon/project/viwork/apps/web/src/api.ts)。它负责：

- 对路径分段做 URL encode，避免中文和斜杠错误。
- 把非 2xx JSON 错误转换成 `Error`。
- 封装工作区、会话、run、技能、微信接口。
- 创建 `EventSource` 订阅 `/api/runs/:runId/events`。

新增 API 时应同步更新：

- 后端 route
- `packages/shared` 类型
- `apps/web/src/api.ts`
- `apps/web/src/api.test.ts`
