# viwork

viwork 是一个面向情景剧创作全流程的本地优先工作台。当前实现已经从早期 Express 示例迁移为 pnpm monorepo，核心能力包括工作区文件系统、文档编辑与预览、知识库与技能配置、创作助手会话、Codex agent 运行时接入，以及远程微信接入入口。

后续开发请优先阅读 [AGENTS.md](./AGENTS.md) 和 [docs/current/README.md](./docs/current/README.md)。`docs/current/` 只描述当前版本实现，是后续 agent 继续迭代的主要上下文。

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

## 开发入口

- API 组合入口：[apps/api/src/app.ts](./apps/api/src/app.ts)
- Web 主界面：[apps/web/src/main.tsx](./apps/web/src/main.tsx)
- Web API client：[apps/web/src/api.ts](./apps/web/src/api.ts)
- 共享合同：[packages/shared/src/contracts.ts](./packages/shared/src/contracts.ts)
- 默认目录和模板：[packages/shared/src/templates.ts](./packages/shared/src/templates.ts)

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
