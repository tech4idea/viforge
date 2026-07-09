# 测试与开发命令

## 常用命令

安装依赖：

```bash
pnpm install
```

启动 API：

```bash
pnpm --filter @viforge/api dev
```

启动 Web：

```bash
pnpm --filter @viforge/web dev
```

启动桌面壳开发模式：

```bash
pnpm --filter @viforge/desktop dev
```

桌面开发模式会先构建 Web 静态资源和桌面专用 API bundle，再由 Electron 主进程启动本地 API。默认仍需要准备本机可运行的 PostgreSQL binary；可用 `VIFORGE_POSTGRES_BIN_DIR=/path/to/postgres/bin` 指向外部 PostgreSQL bin 目录调试。

默认端口：

- API：`3001`
- Web：`5173`

## 日志

API 启动入口会把 `console.log/info/debug` 写入 `logs/api.log`，把 `console.warn/error` 同时写入 `logs/api.log` 和 `logs/api.error.log`。日志目录默认是仓库根目录下的 `logs/`，可通过 `LOGS_ROOT=/path/to/logs` 覆盖。

LangGraph run 失败时，后端会先打印包含 `runId`、`projectId`、`sessionId` 和 `threadId` 的原始错误，再向前端返回用户可读的错误文案。定位“连接中断”类问题时优先查看 `logs/api.error.log`。

如果需要看一次聊天提交的完整输入输出链路，查看 `logs/api-runs.jsonl`。这个文件按 JSONL 记录 `POST /api/runs` 请求/响应、后端拼接后的 prompt、线程参数、LangGraph/LangChain stream 事件、发给前端的流式事件以及最终错误状态。它会记录用户提交的 prompt 和工具输入输出，但不会记录环境变量里的 token/key。

## 类型检查

```bash
pnpm --filter @viforge/api typecheck
pnpm --filter @viforge/web typecheck
pnpm --filter @viforge/shared test
```

`packages/shared` 当前没有单独 typecheck 脚本，测试会覆盖合同类型的基础断言。

## 构建

```bash
pnpm --filter @viforge/web build
```

Web 构建会执行 `tsc -b` 和 `vite build`。

桌面壳构建与安装包：

```bash
pnpm --filter @viforge/desktop build
pnpm desktop:pack
pnpm desktop:dist
```

`desktop:dist` 生成 Electron 安装包，Windows 目标是 NSIS one-click exe。打包前需要把官方 PostgreSQL 源码构建出的可重定位 bundle 放到 `apps/desktop/resources/postgres/<platform>-<arch>`，或设置 `VIFORGE_POSTGRES_BUNDLE_SOURCE=/path/to/postgresql-root` 让 `prepare:postgres` 复制。

## 后端测试

推荐按改动范围运行：

```bash
pnpm --filter @viforge/api test -- projects.test.ts
pnpm --filter @viforge/api test -- chatSessions.test.ts
pnpm --filter @viforge/api test -- runs.test.ts
pnpm --filter @viforge/api test -- runEvents.test.ts
pnpm --filter @viforge/api test -- langGraphRunService.test.ts
pnpm --filter @viforge/api test -- runtimeConfig.test.ts desktopAccess.test.ts
pnpm --filter @viforge/api test -- skills.test.ts
pnpm --filter @viforge/api test -- wechat.test.ts
```

注意：当前 `apps/api` 测试命令可能会扫到 `apps/api/data/workspaces/.codex-home` 下的临时插件测试文件。功能测试仍会通过，但输出会很长。需要清理时谨慎处理 `.codex-home`，不要删除用户需要保留的会话运行态。

## 前端测试

```bash
pnpm --filter @viforge/web test -- api.test.ts
pnpm --filter @viforge/web test -- workspace-tree.test.ts
pnpm --filter @viforge/web test -- viewer-components.test.ts
pnpm --filter @viforge/web test -- viewers.test.ts
pnpm --filter @viforge/web test -- chat-references.test.ts
```

## 关键测试覆盖

- API client URL 编码和端点：[apps/web/src/api.test.ts](../../apps/web/src/api.test.ts)
- 文件树折叠过滤：[apps/web/src/workspace-tree.test.ts](../../apps/web/src/workspace-tree.test.ts)
- viewer 类型判断：[apps/web/src/viewers.test.ts](../../apps/web/src/viewers.test.ts)
- Markdown/表格/代码 viewer：[apps/web/src/viewer-components.test.ts](../../apps/web/src/viewer-components.test.ts)
- 引用输入：[apps/web/src/chat-references.test.ts](../../apps/web/src/chat-references.test.ts)
- 工作区 API：[apps/api/src/routes/projects.test.ts](../../apps/api/src/routes/projects.test.ts)
- 会话持久化 API：[apps/api/src/routes/chatSessions.test.ts](../../apps/api/src/routes/chatSessions.test.ts)
- LangGraph run service：[apps/api/src/runs/langGraphRunService.test.ts](../../apps/api/src/runs/langGraphRunService.test.ts)
- SSE run events：[apps/api/src/routes/runEvents.test.ts](../../apps/api/src/routes/runEvents.test.ts)

## 开发注意事项

- 前端所有后端访问都应通过 `apps/web/src/api.ts`。
- 新共享类型应先加到 `packages/shared/src/contracts.ts`。
- 文件系统路径必须走后端安全路径校验，不要在前端拼绝对路径。
- LangGraph run 是异步流式，不要假设 `POST /api/runs` 返回最终结果。
- 会话消息流式更新要保持顺序，当前前端通过 `chatMessagePersistQueueRef` 串行化写入。
