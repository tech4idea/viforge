# 当前版本实现总览

本文档集只描述当前代码库的最新实现，面向后续 agent 继续开发迭代使用。不追溯历史版本。

## 项目形态

viwork 是一个面向小说改编剧本创作全流程的本地优先 monorepo，核心由三层组成：

- `apps/web`：React + Vite 前端，提供三栏工作台、文件树、编辑预览、创作助手、Agent 技能和微信接入入口。
- `apps/api`：Hono API 服务，提供文件系统工作区、会话持久化、LangGraph agent 调用、技能管理和微信接入。
- `packages/shared`：前后端共享的 TypeScript 合同类型、产品 profile 和默认模板。

默认运行端口：

- Web：`5173`
- API：`3001`

## Docker Compose 部署

仓库根目录提供了 `Dockerfile` 和 `docker-compose.yml`，当前采用四服务部署：

- `postgres`：LangGraph checkpoint 和 Store 的 PostgreSQL/pgvector 存储，API 通过 Compose 内网地址 `postgres:5432` 访问。
- `qdrant`：预留向量存储服务，API 通过 Compose 内网地址 `qdrant:6333` 访问。
- `api`：运行 `@viwork/api`，容器内端口 `3001`，默认映射到宿主机 `13001`。
- `web`：Nginx 承载 `apps/web` 静态资源，容器内端口 `80`，默认映射到宿主机 `18080`。

Compose 默认使用同源访问：浏览器访问 `web`，前端请求相对路径 `/api/*`，再由 `web` 容器内的 Nginx 反向代理到 `api:3001`。因此正常 Docker Compose 部署不需要设置 `VITE_API_BASE_URL`，也不需要手动指定 `DATABASE_URL` 或 `QDRANT_URL`。

启动前可从仓库根目录的 `.env.example` 复制一份到 `.env`，再按需填写。Docker Compose 会自动读取仓库根目录 `.env`。

最少需要关注：

```bash
VIWORK_PRODUCT=novel-adaptation
VIWORK_WEB_PORT=18080
VIWORK_API_PORT=13001
VIWORK_AIGC_HUB_BASE_URL=
VIWORK_AIGC_HUB_API_KEY=
VIWORK_AIGC_HUB_CHAT_MODEL=
VIWORK_AIGC_HUB_IMAGE_MODEL=
```

其中：

- `VIWORK_PRODUCT` 当前可选 `novel-adaptation` 和 `sitcom`，只作为默认产品 profile 和默认数据目录选择；单个项目和临时会话会把创建时的 `productId` 写入项目 metadata，后续 agent 运行会按项目自动切换到对应产品 profile。
- `VITE_API_BASE_URL` 在 compose 部署中应保持为空；只有前端需要直连外部 API 时才覆盖。
- `DATABASE_URL` 和 `QDRANT_URL` 由 `docker-compose.yml` 注入到 `api` 容器，默认分别指向 `postgres:5432` 和 `qdrant:6333`。
- `VIWORK_AIGC_HUB_*` 是当前 compose 默认注入到 `api` 容器的关键运行时环境变量。
- `VIWORK_LANGGRAPH_STORE_EMBEDDING_DIMS` 控制 LangGraph Store pgvector 索引维度，默认 `1024`，应与 `VIWORK_AIGC_HUB_EMBEDDING_MODEL` 的输出维度一致。
- `VIWORK_API_PORT`、`VIWORK_WEB_PORT`、`VIWORK_POSTGRES_PORT` 和 `VIWORK_QDRANT_PORT` 只控制宿主机端口映射。

启动命令：

```bash
docker compose up -d --build
```

当前 compose 持久化以下运行态数据：

- API 数据目录：宿主机 `./var/api-data` 挂载到容器 `/data`。
- PostgreSQL 数据：命名卷 `postgres-data`。
- Qdrant 数据：命名卷 `qdrant-data`。

API 进程通过环境变量把文件型运行态数据写到 `/data`，因此容器重建不会丢失：

- 工作区：`/data/workspaces`
- 聊天会话：`/data/chat-sessions.json`
- 微信状态：`/data/wechat.json`
- API 日志：`/data/logs/*`

`web` 服务本身不需要持久化 volume，因为它只承载前端静态构建产物；真正需要保留的数据在 `api`、`postgres` 和 `qdrant` 的持久化挂载中。

如果只需要改对外访问端口，可设置宿主机端口变量，例如：

```bash
VIWORK_WEB_PORT=8080 VIWORK_API_PORT=3001 docker compose up -d --build
```

## 数据存储

当前版本使用文件系统和 PostgreSQL 持久化核心运行态，Compose 仍保留 Qdrant 服务作为向量存储预留：

- 工作区根：`~/.viwork/data/<productId>/workspaces`，compose 中覆盖为 `/data/workspaces`。
- 全局区：`<workspacesRoot>/_global`。
- 项目区：`<workspacesRoot>/<projectId>`。
- 会话：`~/.viwork/data/<productId>/chat-sessions.json`，compose 中覆盖为 `/data/chat-sessions.json`。
- Agent skills：`<workspacesRoot>/_global/Agent 配置/skills/*/SKILL.md`。
- 微信接入：`~/.viwork/data/<productId>/wechat.json`，compose 中覆盖为 `/data/wechat.json`。
- LangGraph 短期状态和长期记忆：通过 `DATABASE_URL` 使用 PostgreSQL/pgvector；checkpoint schema 为 `langgraph`，Store schema 为 `langgraph_store`。
- API 日志：`logs/api.log`、`logs/api.error.log` 和 agent 提交链路诊断 `logs/api-runs.jsonl`，compose 中覆盖为 `/data/logs`。

`VIWORK_PRODUCT` 选择默认产品 profile，默认 `novel-adaptation`。新项目和临时会话可以携带 `productId`，API 会把该值保存到 `project.json`，之后 LangGraph agent 运行时按项目 metadata 自动选择 `novel-adaptation`、`sitcom` 或未来新增产品 profile 的 system prompt、specialist skills 和工作区模板。Vite 已允许读取该非 `VITE_` 前缀变量，启动前后端时使用同一个值即可。`WORKSPACES_ROOT`、`LOGS_ROOT` 和 `DATABASE_URL` 可通过环境变量覆盖；实现入口在 [apps/api/src/env.ts](../../apps/api/src/env.ts)。

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
- [11 LangGraph Agent 运行时](./11-langgraph-agent-runtime.md)
- [12 双产品维护与配置化方案](./12-product-variant-config-plan.md)
- [13 前端性能优化：重型编辑器按需加载](./13-editor-lazy-loading-plan.md)

## 主要代码入口

- API 组合入口：[apps/api/src/app.ts](../../apps/api/src/app.ts)
- Web 主界面：[apps/web/src/main.tsx](../../apps/web/src/main.tsx)
- Web API client：[apps/web/src/api.ts](../../apps/web/src/api.ts)
- 共享合同：[packages/shared/src/contracts.ts](../../packages/shared/src/contracts.ts)
- 产品 profile：[packages/shared/src/productProfiles.ts](../../packages/shared/src/productProfiles.ts)
- 默认目录和模板：[packages/shared/src/templates.ts](../../packages/shared/src/templates.ts)
