# 当前版本实现总览

本文档集只描述当前代码库的最新实现，面向后续 agent 继续开发迭代使用。不追溯历史版本。

## 项目形态

viwork 是一个面向小说改编剧本创作全流程的本地优先 monorepo，核心由三层组成：

- `apps/web`：React + Vite 前端，提供三栏工作台、文件树、编辑预览、创作助手、Agent 技能和微信接入入口。
- `apps/api`：Hono API 服务，提供文件系统工作区、会话持久化、Mastra agent 调用、技能管理和微信接入。
- `packages/shared`：前后端共享的 TypeScript 合同类型和默认模板。

默认运行端口：

- Web：`5173`
- API：`3001`

## 数据存储

当前版本没有数据库，使用文件系统持久化：

- 工作区根：`apps/api/data/workspaces`
- 全局区：`apps/api/data/workspaces/_global`
- 项目区：`apps/api/data/workspaces/<projectId>`
- 会话：`apps/api/data/chat-sessions.json`
- Agent skills：`apps/api/data/workspaces/_global/Agent 配置/skills/*/SKILL.md`
- 微信接入：`apps/api/data/wechat.json`
- Mastra 记忆库：`apps/api/data/mastra-memory.db`
- API 日志：`logs/api.log`、`logs/api.error.log` 和 Mastra 提交链路诊断 `logs/api-runs.jsonl`，可通过 `LOGS_ROOT` 覆盖

`WORKSPACES_ROOT` 可通过环境变量覆盖。未配置时，路径固定解析到 `apps/api/data/workspaces`，不随启动命令的当前目录变化。实现入口在 [apps/api/src/env.ts](../../apps/api/src/env.ts)。

## 功能文档

- [01 架构与共享合同](./01-architecture-and-contracts.md)
- [02 工作区文件系统](./02-workspace-filesystem.md)
- [03 前端工作台与交互](./03-web-workbench-ui.md)
- [04 文件预览与编辑](./04-editor-preview.md)
- [05 创作助手、会话和引用](./05-chat-agent-sessions.md)
- [06 Codex Agent 运行时（历史实现）](./06-codex-agent-runtime.md)
- [07 Agent Skills 与 Agent 配置](./07-skills-and-agent-config.md)
- [08 远程微信接入](./08-wechat-integration.md)
- [09 测试与开发命令](./09-tests-and-dev-commands.md)
- [10 Agent 创作流程设计讨论](./10-agent-workflow-design-discussion.md)
- [11 Mastra Agent 运行时](./11-mastra-agent-runtime.md)

## 主要代码入口

- API 组合入口：[apps/api/src/app.ts](../../apps/api/src/app.ts)
- Web 主界面：[apps/web/src/main.tsx](../../apps/web/src/main.tsx)
- Web API client：[apps/web/src/api.ts](../../apps/web/src/api.ts)
- 共享合同：[packages/shared/src/contracts.ts](../../packages/shared/src/contracts.ts)
- 默认目录和模板：[packages/shared/src/templates.ts](../../packages/shared/src/templates.ts)
