# 架构与共享合同

## 模块边界

当前版本采用 pnpm workspace：

- `apps/web` 只通过 `apps/web/src/api.ts` 访问后端，不直接读写本地文件。
- `apps/api` 封装文件系统、Codex SDK、SSE、技能和微信状态。
- `packages/shared` 提供前后端共享类型、产品 profile 与默认工作区模板。

API 服务由 [apps/api/src/app.ts](../../apps/api/src/app.ts) 装配：

```ts
app.route('/api', createProjectsRoutes(workspaceStore));
app.route('/api', createChatSessionRoutes(createChatSessionStore(...)));
app.route('/api', createRunsRoutes(createLangGraphRunService(workspaceStore, runBus), runBus));
app.route('/api', createRunEventsRoutes(runBus));
app.route('/api', createSkillsRoutes(createSkillStore(...)));
app.route('/api', createWechatRoutes(createWechatStore(...)));
```

## 共享类型

共享合同位于 [packages/shared/src/contracts.ts](../../packages/shared/src/contracts.ts)。

核心类型：

- `Project`：当前产品项目元信息。
- `WorkspaceEntry` / `WorkspaceFile`：文件树条目和文本文件内容。
- `ReferencedFile`：创作助手引用文件。
- `AgentRun`：一次 LangGraph agent 运行。
- `ChatSession` / `ChatMessage`：后端持久化会话和消息。
- `RunEvent`：兼容一次性 run 返回的事件格式。
- `StreamEvent`：当前 SSE 流式事件格式，包含文本、思考、工具调用、文件变更和结束事件。
- `TheaterSkill`：全局 `Agent 配置/skills` 下的 agent skill 条目。
- `WechatStatus` / `WechatSetupSession`：微信接入状态。

产品 profile 装配入口位于 [packages/shared/src/productProfiles.ts](../../packages/shared/src/productProfiles.ts)，当前支持 `novel-adaptation` 和 `sitcom` 两个 id。基础元数据拆到 `packages/shared/src/product-profiles/<product>/profile.json`，默认 system agent 和 agent skill prompt 放在同目录的 `prompts/*.md`。profile 统一描述产品名、页面标题、默认项目文案、工作区分组、默认目录/文件、默认 agent skill、agent label、agent prompt 标题和正式产物路径。API 通过 `GET /api/product-profile` 暴露当前 active profile。

后续增加前后端共享数据结构时，应优先加到 `packages/shared/src/contracts.ts`，再在 `apps/web/src/api.ts` 和 API 路由中使用同一类型。

## 默认模板

默认目录和文件模板位于 [packages/shared/src/templates.ts](../../packages/shared/src/templates.ts)，active 产品通过 [packages/shared/src/productProfiles.ts](../../packages/shared/src/productProfiles.ts) 选择这些模板。

当前 `novel-adaptation` 全局区默认结构：

- `Agent 配置`
- `Agent 配置/skills`
- `知识库`
- `知识库/改编知识`
- `知识库/剧作知识`
- `知识库/审查规范`
- `模板库`

当前 `novel-adaptation` 项目区默认结构按创作顺序编号：

- `01 原著资料`
- `02 改编方案`
- `03 剧本`

创建项目时由 `createDefaultWorkspaceFilesForProfile(profile, topic)` 生成项目文档。初始化全局区时，API 先从 profile 生成默认文件列表，再由 [apps/api/src/productProfileDefaults.ts](../../apps/api/src/productProfileDefaults.ts) 读取 `product-profiles/<product>/prompts/*.md` 覆盖 `Agent 配置/AGENTS.md` 和 `Agent 配置/skills/*/SKILL.md`。`createWorkspaceStore(root, { productProfile })` 支持测试或部署显式注入 profile；未注入时读取 `VIWORK_PRODUCT` 解析出的 active profile。

## API Client

前端 API client 位于 [apps/web/src/api.ts](../../apps/web/src/api.ts)。它负责：

- 对路径分段做 URL encode，避免中文和斜杠错误。
- 把非 2xx JSON 错误转换成 `Error`。
- 封装工作区、会话、run、技能、微信接口。
- 封装 `GET /api/product-profile`，供前端或调试工具读取后端当前产品配置。
- 创建 `EventSource` 订阅 `/api/runs/:runId/events`。

新增 API 时应同步更新：

- 后端 route
- `packages/shared` 类型
- `apps/web/src/api.ts`
- `apps/web/src/api.test.ts`
