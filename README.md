# viwork

viwork 是一个面向情景剧创作全流程的本地优先工作台。当前实现已经从早期 Express 示例迁移为 pnpm monorepo，核心能力包括工作区文件系统、文档编辑与预览、知识库与技能配置、创作助手会话、Codex agent 运行时接入，以及远程微信接入入口。

后续开发请优先阅读 [AGENTS.md](./AGENTS.md) 和 [docs/current/README.md](./docs/current/README.md)。`docs/current/` 只描述当前版本实现，是后续 agent 继续迭代的主要上下文。

## 项目定位

viwork 的目标不是通用网盘或通用 Markdown 编辑器，而是服务情景剧创作全流程：

- 用工作区承载项目设定、人物关系、分集结构、正文、素材和知识库。
- 用全局区沉淀跨项目复用的写作知识、模板、技能和 Agent 配置。
- 用创作助手把当前文件、选中文本、引用素材和多轮会话串联起来。
- 用本地文件系统保留可检查、可迁移、可备份的数据形态。

## 功能概览

- 工作区文件系统：统一管理全局区、项目区、知识库、模板库和 Agent 配置目录。
- 情景剧创作目录：项目目录按创作顺序组织，服务剧本构思、设定、分集、正文与素材沉淀。
- 文件管理：支持创建、重命名、删除、移动、上传、目录折叠、拖拽移动和右键菜单操作。
- 编辑与预览：支持 Markdown、表格类文本、JSON、TOML、TXT 等文本文件编辑，并按文件类型提供预览。
- 引用能力：支持选中文本后引用到创作助手会话，辅助围绕当前素材继续创作。
- 创作助手：支持会话持久化、多轮上下文、会话列表、最近活跃排序、归档与恢复。
- Codex agent 接入：后端通过 Codex SDK/CLI 运行对话任务，向前端流式返回思考、工具调用和结果事件。
- 技能广场与 Agent 配置：管理写作技能、Agent 配置目录、`AGENTS.md` 和 skills 相关内容。
- 远程微信接入：保留微信接入配置、状态和后端路由，为跨端素材/消息接入提供基础。

## 技术栈

- 包管理：pnpm workspace
- 前端：React + Vite + TypeScript
- 后端：Hono + TypeScript
- 共享类型：`packages/shared`
- 数据持久化：本地文件系统
- Agent 运行时：Codex SDK/CLI

## 架构概览

```text
Browser
  |
  | HTTP / SSE
  v
apps/web  React workbench
  |
  | shared contracts
  v
packages/shared
  ^
  | HTTP API
  |
apps/api  Hono service
  |
  | filesystem persistence
  v
apps/api/data
  |
  | Codex runtime home
  v
apps/api/data/.codex-home
```

前端不直接读写本地文件，统一通过 API client 访问后端。后端负责路径校验、文件系统读写、会话持久化、Codex 运行时启动和事件流转发。

## 目录结构

```text
apps/
  web/                  React 工作台前端
  api/                  Hono API 服务
  agent-worker/         Agent worker 占位服务
  integration-gateway/  集成网关占位服务
packages/
  shared/               前后端共享合同类型和默认模板
docs/
  current/              当前版本实现文档
AGENTS.md               后续 agent 开发指引
```

## 快速开始

安装依赖：

```bash
pnpm install
```

启动前后端：

```bash
pnpm dev
```

默认端口：

- Web：`http://localhost:5173`
- API：`http://localhost:3001`

也可以分别启动：

```bash
pnpm dev:api
pnpm dev:web
```

## 环境变量

常用配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | API 服务端口 |
| `WORKSPACES_ROOT` | `apps/api/data/workspaces` | 工作区根目录 |

Codex 运行时会使用后端管理的运行目录，相关实现见 [docs/current/06-codex-agent-runtime.md](./docs/current/06-codex-agent-runtime.md)。

## 常用命令

```bash
pnpm --filter @viwork/api typecheck
pnpm --filter @viwork/web typecheck
pnpm --filter @viwork/web build
pnpm --filter @viwork/api test
pnpm --filter @viwork/web test
```

## 本地数据

当前版本默认使用文件系统持久化，主要数据位于：

```text
apps/api/data/
```

其中包括工作区、会话、技能、微信配置和 Codex 运行时 HOME。该目录属于本地运行数据，不应提交到 Git。可通过 `WORKSPACES_ROOT` 覆盖工作区根目录。

主要数据文件和目录：

```text
apps/api/data/workspaces/              工作区根目录
apps/api/data/workspaces/_global/      全局区
apps/api/data/workspaces/<projectId>/  情景剧项目区
apps/api/data/chat-sessions.json       创作助手会话
apps/api/data/skills/skills.json       技能广场数据
apps/api/data/wechat.json              微信接入配置
apps/api/data/.codex-home/             Codex 运行时 HOME
```

## 数据迁移

当前版本使用文件系统持久化，迁移应以“版本化文件迁移”为主，而不是数据库迁移。

推荐约定：

- 在 `apps/api/data/migrations.json` 记录已应用迁移。
- 在 `apps/api/src/migrations/` 增加迁移模块。
- 每条迁移保持幂等，重复执行不能覆盖用户数据。
- 修改 JSON 文件前先写备份。
- 文件移动先检查源路径和目标路径，目标存在时不覆盖。
- API 启动时在监听端口前执行迁移，失败则停止启动。

目前已有的局部迁移逻辑在 [apps/api/src/storage/workspaceStore.ts](./apps/api/src/storage/workspaceStore.ts)：全局区旧位置的 `AGENTS.md`、`config.toml`、`skills`、`plugins` 会迁移到 `Agent 配置/` 下。后续应把这类逻辑抽为正式迁移文件，避免迁移逻辑散落在 store 初始化中。

## 开发入口

- API 组合入口：[apps/api/src/app.ts](./apps/api/src/app.ts)
- Web 主界面：[apps/web/src/main.tsx](./apps/web/src/main.tsx)
- Web API client：[apps/web/src/api.ts](./apps/web/src/api.ts)
- 共享合同：[packages/shared/src/contracts.ts](./packages/shared/src/contracts.ts)
- 默认目录和模板：[packages/shared/src/templates.ts](./packages/shared/src/templates.ts)

## 开发约束

- API 合同先改 `packages/shared/src/contracts.ts`，再改前后端实现。
- 前端 API 调用集中在 `apps/web/src/api.ts`。
- 工作区树结构和排序逻辑集中在 `apps/web/src/workspace-tree.ts`。
- 后端文件系统语义集中在 `apps/api/src/storage/workspaceStore.ts`。
- 会话持久化集中在 `apps/api/src/chat/chatSessionStore.ts`。
- Codex 运行时集中在 `apps/api/src/runs/codexRunService.ts`。
- 用户可见功能必须服务情景剧创作，不要退化成通用文档管理工具。

## 实现文档

- [架构与共享合同](./docs/current/01-architecture-and-contracts.md)
- [工作区文件系统](./docs/current/02-workspace-filesystem.md)
- [前端工作台与交互](./docs/current/03-web-workbench-ui.md)
- [文件预览与编辑](./docs/current/04-editor-preview.md)
- [创作助手、会话和引用](./docs/current/05-chat-agent-sessions.md)
- [Codex Agent 运行时](./docs/current/06-codex-agent-runtime.md)
- [技能广场与 Agent 配置](./docs/current/07-skills-and-agent-config.md)
- [远程微信接入](./docs/current/08-wechat-integration.md)
- [测试与开发命令](./docs/current/09-tests-and-dev-commands.md)

## 排障入口

- 页面空白：先看浏览器控制台，再确认 `pnpm dev:web` 和 API 是否都在运行。
- API 起不来：检查 `PORT` 是否被占用，以及 `apps/api/data/` 是否可写。
- 文件树异常：检查 `WORKSPACES_ROOT` 指向的目录和 `project.json`。
- 会话不连续：检查 `apps/api/data/chat-sessions.json` 是否正常写入，以及会话是否带有 `codexThreadId`。
- Codex 报鉴权错误：检查运行时使用的 Codex 配置和环境变量，不要把密钥提交进仓库。

## 提交注意事项

不要提交运行数据、密钥、构建产物或本地工具目录，例如：

- `apps/api/data/`
- `apps/web/dist/`
- `*.tsbuildinfo`
- `node_modules/`
- `.env`
- `.idea/`
- `.claude/`
- `.qwen/`
- `.agents/`
