# 当前版本实现总览

本文档集只描述当前代码库的最新实现，面向后续 agent 继续开发迭代使用。不追溯历史版本。

## 项目形态

viwork 是一个面向小说改编剧本创作全流程的本地优先 monorepo，核心由三层组成：

- `apps/web`：React + Vite 前端，提供三栏工作台、文件树、编辑预览、创作助手、Agent 技能和微信接入入口。
- `apps/api`：Hono API 服务，提供文件系统工作区、会话持久化、Mastra agent 调用、技能管理和微信接入。
- `packages/shared`：前后端共享的 TypeScript 合同类型、产品 profile 和默认模板。

默认运行端口：

- Web：`5173`
- API：`3001`

## Docker Compose 部署

仓库根目录提供了 `Dockerfile` 和 `docker-compose.yml`，当前采用双服务部署：

- `api`：运行 `@viwork/api`，对外暴露 `3001`
- `web`：单独构建 `apps/web` 静态资源并直接暴露，对外默认暴露 `8080`

注意：容器内服务端口仍然分别是 `3001` 和 `80`，为了避开宿主机冲突，compose 默认映射到宿主机 `13001` 和 `18080`。

当前方案不做反向代理。前端构建时直接写入 `VITE_API_BASE_URL`，浏览器本地访问 `web` 后会直接请求 `api` 地址，例如 `http://localhost:13001`。

启动前建议从仓库根目录的 `.env.example` 复制一份到 `.env`，再按需填写。Docker Compose 会自动读取仓库根目录 `.env`。

最少需要关注：

```bash
VIWORK_PRODUCT=novel-adaptation
VITE_API_BASE_URL=http://localhost:13001
VIWORK_API_PORT=13001
VIWORK_WEB_PORT=18080
VIWORK_AIGC_HUB_BASE_URL=
VIWORK_AIGC_HUB_API_KEY=
VIWORK_AIGC_HUB_CHAT_MODEL=
VIWORK_AIGC_HUB_IMAGE_MODEL=
```

其中：

- `VITE_API_BASE_URL` 是前端构建时变量，决定浏览器请求哪个 API 地址。
- `VIWORK_PRODUCT` 当前可选 `novel-adaptation` 和 `sitcom`。
- `VIWORK_AIGC_HUB_*` 是当前 compose 默认注入到 `api` 容器的关键运行时环境变量。
- `VIWORK_API_PORT` 和 `VIWORK_WEB_PORT` 只控制宿主机端口映射。

启动命令：

```bash
docker compose up -d --build
```

当前 compose 只对 `api` 挂持久化 volume：

- 宿主机目录：`./var/api-data`
- 容器目录：`/data`

API 进程通过环境变量把所有运行态数据写到该目录，因此容器重建不会丢失：

- 工作区：`/data/workspaces`
- 聊天会话：`/data/chat-sessions.json`
- 微信状态：`/data/wechat.json`
- Mastra memory：`/data/mastra-memory.db`
- API 日志：`/data/logs/*`

`web` 服务本身不需要持久化 volume，因为它只承载前端静态构建产物；真正需要保留的数据都在 `api` 服务挂载的 `/data` 下。

工作区文件持久化已经纳入 compose：`./var/api-data:/data`。而 API 代码本身会继续把：

- `WORKSPACES_ROOT` 写到 `/data/workspaces`
- `chat-sessions.json` 写到 `/data/chat-sessions.json`
- `wechat.json` 写到 `/data/wechat.json`
- `mastra-memory.db` 写到 `/data/mastra-memory.db`

所以只要宿主机上的 `./var/api-data` 不删，项目文件、会话、微信状态和记忆库都会保留。

如果需要改端口，可设置 `VIWORK_API_PORT` 和 `VIWORK_WEB_PORT`，例如：

```bash
VIWORK_API_PORT=13001 VIWORK_WEB_PORT=18080 docker compose up -d --build
```

## 数据存储

当前版本没有数据库，使用文件系统持久化：

- 工作区根：`~/.viwork/data/<productId>/workspaces`
- 全局区：`~/.viwork/data/<productId>/workspaces/_global`
- 项目区：`~/.viwork/data/<productId>/workspaces/<projectId>`
- 会话：`~/.viwork/data/<productId>/chat-sessions.json`
- Agent skills：`~/.viwork/data/<productId>/workspaces/_global/Agent 配置/skills/*/SKILL.md`
- 微信接入：`~/.viwork/data/<productId>/wechat.json`
- Mastra 记忆库：`~/.viwork/data/<productId>/mastra-memory.db`
- API 日志：`logs/api.log`、`logs/api.error.log` 和 Mastra 提交链路诊断 `logs/api-runs.jsonl`，可通过 `LOGS_ROOT` 覆盖

`VIWORK_PRODUCT` 同时选择后端和前端产品 profile，默认 `novel-adaptation`。Vite 已允许读取该非 `VITE_` 前缀变量，启动前后端时使用同一个值即可。`WORKSPACES_ROOT` 可通过环境变量覆盖；未配置时会自动带上 product id，实现入口在 [apps/api/src/env.ts](../../apps/api/src/env.ts)。

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
- [12 双产品维护与配置化方案](./12-product-variant-config-plan.md)
- [13 前端性能优化：重型编辑器按需加载](./13-editor-lazy-loading-plan.md)

## 主要代码入口

- API 组合入口：[apps/api/src/app.ts](../../apps/api/src/app.ts)
- Web 主界面：[apps/web/src/main.tsx](../../apps/web/src/main.tsx)
- Web API client：[apps/web/src/api.ts](../../apps/web/src/api.ts)
- 共享合同：[packages/shared/src/contracts.ts](../../packages/shared/src/contracts.ts)
- 产品 profile：[packages/shared/src/productProfiles.ts](../../packages/shared/src/productProfiles.ts)
- 默认目录和模板：[packages/shared/src/templates.ts](../../packages/shared/src/templates.ts)
