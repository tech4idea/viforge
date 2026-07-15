# 创作助手、会话和引用

## 前端入口

创作助手 UI 位于 [apps/web/src/main.tsx](../../apps/web/src/main.tsx) 的 `session-panel` 区域。

核心状态：

- `chatSessions`
- `chatScope`：`project` 或 `temporary`
- `chatSessionsProjectId`
- `activeChatSessionId`
- `chatSessionView`：`active` 或 `archived`
- `prompt`
- `referencedFiles`
- `referencedSnippets`
- `referenceSuggestions`
- `runState`
- `runError`
- `currentRun`

## 后端会话持久化

后端 store 位于 [apps/api/src/chat/chatSessionStore.ts](../../apps/api/src/chat/chatSessionStore.ts)。

持久化文件：

```text
apps/api/data/chat-sessions.json
```

`ChatSessionStore` 能力：

- `listProjectSessions(projectId, { includeArchived })`
- `createSession(projectId)`
- `archiveSession(sessionId)`
- `restoreSession(sessionId)`
- `updateSession(sessionId, { title })`，合同中仍保留 `codexThreadId` 作为历史字段，当前 LangGraph 链路不再写入新的 Codex thread。
- `appendMessage(sessionId, message)`
- `updateMessage(sessionId, messageId, message)`

会话状态文件写入采用同进程串行队列，并先写入同目录临时文件再 `rename` 到 `chat-sessions.json`。这样可以避免流式消息高频更新时，一个请求读到另一个请求尚未写完的半截 JSON，也避免并发 append/update 互相覆盖。

会话按 `updatedAt` 倒序排序。归档会话设置 `archivedAt`，恢复时置回 `null`。

## 会话 API

路由位于 [apps/api/src/routes/chatSessions.ts](../../apps/api/src/routes/chatSessions.ts)。

- `GET /api/projects/:projectId/chat-sessions`
- `GET /api/projects/:projectId/chat-sessions?includeArchived=true`
- `POST /api/projects/:projectId/chat-sessions`
- `GET /api/temporary-chat-sessions`
- `GET /api/temporary-chat-sessions?includeArchived=true`
- `POST /api/temporary-chat-sessions`
- `PATCH /api/chat-sessions/:sessionId`
- `POST /api/chat-sessions/:sessionId/archive`
- `POST /api/chat-sessions/:sessionId/restore`
- `POST /api/chat-sessions/:sessionId/messages`
- `PUT /api/chat-sessions/:sessionId/messages/:messageId`

前端封装在 [apps/web/src/api.ts](../../apps/web/src/api.ts)。

## 最近/归档视图

前端从后端加载 `includeArchived=true` 的所有会话，然后本地拆分：

- `projectChatSessions`：未归档
- `archivedChatSessions`：已归档
- `displayedChatSessions`：当前 tab 展示的数据

选择正式项目时，前端读取该项目的会话。前端也会读取 `GET /api/temporary-chat-sessions?includeArchived=true`，恢复所有 `temp-*` 临时工作目录会话；浏览器本地只保存最近的临时会话指针，用于优先选中，不作为唯一历史来源。

前端还会把每个正式项目最近打开的会话 id、最近打开的临时会话 id 和最近/归档视图写入 localStorage：

```text
viforge.activeChatSession.v1
```

页面刷新后，前端会在后端会话列表加载完成后校验该 id 是否仍存在；存在则恢复到上次会话，不存在则回退到当前视图的最新会话。聊天记录区域在恢复会话或收到新消息时自动滚动到最后一条消息。

临时会话工作目录在左侧工作区中常驻展示，位于当前产品项目区域下方且默认折叠。展开后每个临时会话对应一个默认折叠的目录节点；继续展开可预览、编辑、上传、重命名、删除和在同一个临时工作目录内移动文件。这些文件操作复用 `/api/projects/:projectId/files`、`raw`、`move` 等项目文件 API，但 `temp-*` 不进入正式项目列表。

归档会话可以查看，但输入区禁用。右键菜单：

- 未归档：归档会话
- 已归档：恢复会话

## 发送消息

普通创作助手会话的 `kind` 为 `assistant`。常规文本请求由后端通过 LangGraph runtime 执行；如果输入被识别为图片创建请求，前端会在同一个助手会话里调用图片生成 API，并把用户消息、生成状态和图片附件写回当前会话。

发送入口：

- `submitPrompt()`

流程：

1. 读取 `prompt` 和 `activeChatSession`。
2. 用 `createChatMessage('user', ...)` 创建用户消息。
3. `appendMessageToSession()` 立即更新本地 UI，并排队调用 `apiClient.appendChatMessage`。
4. 如果 `isImageGenerationPrompt()` 命中图片创建意图，调用 `apiClient.createImageGeneration`，生成图片会保存到当前会话的工作目录，聊天气泡直接展示图片附件。
5. 否则调用 `apiClient.createRun` 创建 LangGraph run。
6. 创建 assistant 空消息。
7. 用 `apiClient.streamRunEvents(run.id, handlers)` 订阅 SSE。
8. `handleRunStreamEvent()` 将 `text.delta` 追加到 assistant 消息，并持久化更新。
9. 如果流中包含 `agent.*` trace 事件，`AssistantStreamBody` 会展示 agent timeline、打回详情和最终写入状态。

如果后端返回兼容旧 mock 服务的同步 `RunEvent[]`，前端会先转换为 `streamEvents`，确保 mock/legacy 路径和真实 SSE 路径使用同一套 agent timeline 渲染。

消息写入后端使用串行队列：

```ts
const chatMessagePersistQueueRef = useRef<Promise<void>>(Promise.resolve());
```

这样可以避免流式更新并发写同一 JSON 文件时顺序错乱。

## 图片生成会话

创作助手区域还有独立的 `图片` 模式。图片会话的 `kind` 为 `image`，只按临时会话处理，不绑定正式项目，也不通过 LangGraph agent runtime。普通 `assistant` 会话也可以直接发“生成一张图片/画一张场景图”等请求，命中后复用同一个图片生成后端，并把图片保存到当前项目或临时会话工作目录。

入口：

- 前端模式切换：`chatMode: 'assistant' | 'image'`
- API：`POST /api/image-generations`
- 后端实现：[apps/api/src/routes/imageGenerations.ts](../../apps/api/src/routes/imageGenerations.ts)

图片生成请求包含：

- `sessionId`：图片临时会话 id。未传时后端会创建新的临时项目和图片会话。
- `prompt`
- `model`：可选，默认使用 API 服务端 `VIFORGE_AIGC_HUB_IMAGE_MODEL`，未配置时为 `gpt-image-1`
- `aspectRatio`：`1:1`、`16:9`、`9:16`、`4:3`、`3:4`
- `thinkingLevel`：可选，保留在附件元数据中。当前 AIGC Hub `/v1/images/generations` 兼容请求不会向上游传递该字段。
- `count`：1 到 4
- `referenceImages`：前端上传的参考图，会保存为聊天附件。当前 AIGC Hub 图片生成接口不接收参考图内容，因此后端会在提示词里说明参考图数量。

后端使用 AIGC Hub 网关，不直连上游模型。配置读取 API 服务进程环境变量：

```text
VIFORGE_AIGC_HUB_BASE_URL=http://127.0.0.1:8000/v1
VIFORGE_AIGC_HUB_API_KEY=hub_...
VIFORGE_AIGC_HUB_IMAGE_MODEL=gpt-image-1
```

请求会发送到 `POST ${VIFORGE_AIGC_HUB_BASE_URL}/images/generations`，并使用 `Authorization: Bearer <VIFORGE_AIGC_HUB_API_KEY>`。如果没有配置 base URL 或 API key，接口返回明确错误。不要把图片生成接到 LangGraph agent runtime 上。

图片文件落在图片临时会话工作目录：

```text
参考图片/
生成图片/
```

消息通过现有 `ChatSessionStore` 持久化到 `apps/api/data/chat-sessions.json`。`ChatMessage.attachments` 保存参考图和生成图的 `projectId`、`path`、`mimeType`、`model`、`aspectRatio`、`thinkingLevel` 等信息。聊天气泡中的图片缩略图点击后复用现有 `/api/projects/:projectId/raw/*` 图片预览和临时工作目录文件树。

## 文件引用

引用逻辑位于 [apps/web/src/chat-references.ts](../../apps/web/src/chat-references.ts)。

能力：

- `getActiveReferenceQuery(text, caret)`：识别输入框中 `@xxx` 查询。
- `buildReferenceSuggestions(entries, query, existing)`：基于当前项目文件给出候选。
- `insertReference(text, caret, reference)`：把选中的引用插入 prompt。

提交 run 时，`referencedFiles` 会传给后端，并由 LangGraph run service 拼入本次 agent 输入。

## 聊天片段引用

聊天记录中的文本可以被部分选中后引用到新对话。用户选中某段话或术语后，前端在选区附近弹出“引入到会话”，确认后只保存选中的文本片段，而不是整条聊天消息。

引用结构使用 `referencedSnippets`：

- `messageId`：来源消息。
- `role`：来源是用户还是创作助手。
- `label`：前端展示用标签。
- `text`：用户实际选中的片段。
- `createdAt`：来源消息时间。

提交 run 时，前端把 `referencedSnippets` 和 `referencedFiles` 一起传给后端。后端在 LangGraph agent 输入中追加 `# 已引用聊天片段`，带上来源角色、时间、messageId 和片段文本，确保 agent 能拿到引用上下文。

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
