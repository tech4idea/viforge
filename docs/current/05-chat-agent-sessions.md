# 创作助手、会话和引用

## 前端入口

创作助手 UI 位于 [apps/web/src/main.tsx](/Users/yukeon/project/viwork/apps/web/src/main.tsx) 的 `session-panel` 区域。

核心状态：

- `chatSessions`
- `chatSessionsProjectId`
- `activeChatSessionId`
- `chatSessionView`：`active` 或 `archived`
- `prompt`
- `referencedFiles`
- `referenceSuggestions`
- `runState`
- `runError`
- `currentRun`

## 后端会话持久化

后端 store 位于 [apps/api/src/chat/chatSessionStore.ts](/Users/yukeon/project/viwork/apps/api/src/chat/chatSessionStore.ts)。

持久化文件：

```text
apps/api/data/chat-sessions.json
```

`ChatSessionStore` 能力：

- `listProjectSessions(projectId, { includeArchived })`
- `createSession(projectId)`
- `archiveSession(sessionId)`
- `restoreSession(sessionId)`
- `updateSession(sessionId, { codexThreadId, title })`
- `appendMessage(sessionId, message)`
- `updateMessage(sessionId, messageId, message)`

会话按 `updatedAt` 倒序排序。归档会话设置 `archivedAt`，恢复时置回 `null`。

## 会话 API

路由位于 [apps/api/src/routes/chatSessions.ts](/Users/yukeon/project/viwork/apps/api/src/routes/chatSessions.ts)。

- `GET /api/projects/:projectId/chat-sessions`
- `GET /api/projects/:projectId/chat-sessions?includeArchived=true`
- `POST /api/projects/:projectId/chat-sessions`
- `PATCH /api/chat-sessions/:sessionId`
- `POST /api/chat-sessions/:sessionId/archive`
- `POST /api/chat-sessions/:sessionId/restore`
- `POST /api/chat-sessions/:sessionId/messages`
- `PUT /api/chat-sessions/:sessionId/messages/:messageId`

前端封装在 [apps/web/src/api.ts](/Users/yukeon/project/viwork/apps/web/src/api.ts)。

## 最近/归档视图

前端从后端加载 `includeArchived=true` 的所有会话，然后本地拆分：

- `projectChatSessions`：未归档
- `archivedChatSessions`：已归档
- `displayedChatSessions`：当前 tab 展示的数据

归档会话可以查看，但输入区禁用。右键菜单：

- 未归档：归档会话
- 已归档：恢复会话

## 发送消息

发送入口：

- `submitPrompt()`

流程：

1. 读取 `prompt` 和 `activeChatSession`。
2. 用 `createChatMessage('user', ...)` 创建用户消息。
3. `appendMessageToSession()` 立即更新本地 UI，并排队调用 `apiClient.appendChatMessage`。
4. 调用 `apiClient.createMockRun` 创建 Codex run。
5. 创建 assistant 空消息。
6. 用 `apiClient.streamRunEvents(run.id, handlers)` 订阅 SSE。
7. `handleRunStreamEvent()` 将 `text.delta` 追加到 assistant 消息，并持久化更新。

消息写入后端使用串行队列：

```ts
const chatMessagePersistQueueRef = useRef<Promise<void>>(Promise.resolve());
```

这样可以避免流式更新并发写同一 JSON 文件时顺序错乱。

## 文件引用

引用逻辑位于 [apps/web/src/chat-references.ts](/Users/yukeon/project/viwork/apps/web/src/chat-references.ts)。

能力：

- `getActiveReferenceQuery(text, caret)`：识别输入框中 `@xxx` 查询。
- `buildReferenceSuggestions(entries, query, existing)`：基于当前项目文件给出候选。
- `insertReference(text, caret, reference)`：把选中的引用插入 prompt。

提交 run 时，`referencedFiles` 会传给后端和 Codex prompt。

## 选中文本引用

编辑区选中文本右键会显示“引用到对话”。实现入口：

- `openSelectedTextContextMenu`
- `quoteSelectedTextToComposer`
- `getSelectedTextFromEvent`

引用格式：

```md
引用 @文件名：
> 选中的第一行
> 选中的第二行
```

同时当前文件会加入 `referencedFiles`。

