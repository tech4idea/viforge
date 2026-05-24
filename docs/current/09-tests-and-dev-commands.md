# 测试与开发命令

## 常用命令

安装依赖：

```bash
pnpm install
```

启动 API：

```bash
pnpm --filter @viwork/api dev
```

启动 Web：

```bash
pnpm --filter @viwork/web dev
```

默认端口：

- API：`3001`
- Web：`5173`

## 类型检查

```bash
pnpm --filter @viwork/api typecheck
pnpm --filter @viwork/web typecheck
pnpm --filter @viwork/shared test
```

`packages/shared` 当前没有单独 typecheck 脚本，测试会覆盖合同类型的基础断言。

## 构建

```bash
pnpm --filter @viwork/web build
```

Web 构建会执行 `tsc -b` 和 `vite build`。

## 后端测试

推荐按改动范围运行：

```bash
pnpm --filter @viwork/api test -- projects.test.ts
pnpm --filter @viwork/api test -- chatSessions.test.ts
pnpm --filter @viwork/api test -- runs.test.ts
pnpm --filter @viwork/api test -- runEvents.test.ts
pnpm --filter @viwork/api test -- codexRunService.test.ts
pnpm --filter @viwork/api test -- skills.test.ts
pnpm --filter @viwork/api test -- wechat.test.ts
```

注意：当前 `apps/api` 测试命令可能会扫到 `apps/api/data/workspaces/.codex-home` 下的临时插件测试文件。功能测试仍会通过，但输出会很长。需要清理时谨慎处理 `.codex-home`，不要删除用户需要保留的会话运行态。

## 前端测试

```bash
pnpm --filter @viwork/web test -- api.test.ts
pnpm --filter @viwork/web test -- workspace-tree.test.ts
pnpm --filter @viwork/web test -- viewer-components.test.ts
pnpm --filter @viwork/web test -- viewers.test.ts
pnpm --filter @viwork/web test -- chat-references.test.ts
```

## 关键测试覆盖

- API client URL 编码和端点：[apps/web/src/api.test.ts](/Users/yukeon/project/viwork/apps/web/src/api.test.ts)
- 文件树折叠过滤：[apps/web/src/workspace-tree.test.ts](/Users/yukeon/project/viwork/apps/web/src/workspace-tree.test.ts)
- viewer 类型判断：[apps/web/src/viewers.test.ts](/Users/yukeon/project/viwork/apps/web/src/viewers.test.ts)
- Markdown/表格/代码 viewer：[apps/web/src/viewer-components.test.ts](/Users/yukeon/project/viwork/apps/web/src/viewer-components.test.ts)
- 引用输入：[apps/web/src/chat-references.test.ts](/Users/yukeon/project/viwork/apps/web/src/chat-references.test.ts)
- 工作区 API：[apps/api/src/routes/projects.test.ts](/Users/yukeon/project/viwork/apps/api/src/routes/projects.test.ts)
- 会话持久化 API：[apps/api/src/routes/chatSessions.test.ts](/Users/yukeon/project/viwork/apps/api/src/routes/chatSessions.test.ts)
- Codex run service：[apps/api/src/runs/codexRunService.test.ts](/Users/yukeon/project/viwork/apps/api/src/runs/codexRunService.test.ts)
- SSE run events：[apps/api/src/routes/runEvents.test.ts](/Users/yukeon/project/viwork/apps/api/src/routes/runEvents.test.ts)

## 开发注意事项

- 前端所有后端访问都应通过 `apps/web/src/api.ts`。
- 新共享类型应先加到 `packages/shared/src/contracts.ts`。
- 文件系统路径必须走后端安全路径校验，不要在前端拼绝对路径。
- Codex run 是异步流式，不要假设 `POST /api/runs` 返回最终结果。
- 会话消息流式更新要保持顺序，当前前端通过 `chatMessagePersistQueueRef` 串行化写入。

