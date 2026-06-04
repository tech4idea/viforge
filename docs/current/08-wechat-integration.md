# 远程微信接入

## 目标

微信接入要把个人微信对话变成 viwork 情景剧创作工作台的远程入口。用户可以在微信里完成四类操作：

- 切换到指定项目目录。
- 切换到草稿区，也就是临时会话工作目录。
- 发送改编、创作、润色、续写等指令，并由后端启动当前 Mastra 创作 run。
- 收发图片和文件，把微信素材保存进工作区，也能把工作区产物回传到微信。

当前代码里的微信实现仍是本地模拟接口，不是真实微信开放平台 OAuth，也不是企业微信。后续真实接入建议参考 cc-connect 的个人微信通道，使用腾讯 ilink 机器人 HTTP 网关：`getUpdates` 长轮询接收消息，`sendMessage` 下发回复。

## 参考方案：cc-connect Weixin / ilink

参考文档：[cc-connect docs/weixin.md](https://github.com/chenhg5/cc-connect/blob/main/docs/weixin.md)

关键结论：

- 这是个人微信 + ilink 通道，不是企业微信 WeChat Work。
- 环境不要求公网 IP，接收消息通过 ilink 云端网关的长轮询。
- 登录方式优先扫码；扫码后得到 `token`、`base_url`、`account_id` 等配置。
- 生产环境必须配置 `allow_from`，限制可操作机器人的微信用户 ID，形如 `xxx@im.wechat`。
- ilink 下发消息可能携带 `context_token`；首次连接后要先启动轮询，再由允许的微信账号给机器人发一条消息完成关联。
- 图片、文件、视频、语音文件可从微信 CDN 下载，通常需要按 AES-128-ECB 解密；出站图片和文件通过平台的 sender 能力发送。
- 需要处理网关重试、幂等游标、会话过期、扫码超时和 token 失效。

## 当前实现

Store：[apps/api/src/wechat/wechatStore.ts](../../apps/api/src/wechat/wechatStore.ts)

Route：[apps/api/src/routes/wechat.ts](../../apps/api/src/routes/wechat.ts)

持久化文件：

```text
~/.viwork/data/<productId>/wechat.json
```

当前状态结构：

- `connection`
- `setupSession`
- `inboundMessageIds`

当前 API：

- `GET /api/wechat/status`
- `POST /api/wechat/setup-sessions`
- `POST /api/wechat/setup-sessions/:sessionId/complete`
- `POST /api/wechat/inbound`

`createSetupSession()` 目前只生成本地模拟连接码：

```text
viwork-wechat://pair/<sessionId>
```

`acceptInbound()` 当前只做三件事：

- 校验已连接。
- 校验 `externalUserId` 与连接用户一致。
- 用 `externalMessageId` 做幂等。

通过后写入第一个正式项目的文件：

```text
remote-wechat/<ISO 时间>.md
```

如果当前没有项目，会创建一个“远程微信灵感箱”项目。

## 差距

当前实现只能作为模拟 webhook，无法满足真实远程创作入口：

- 没有 ilink token、`base_url`、`cdn_base_url`、`account_id`、`allow_from`、`context_token`、轮询游标等配置。
- 没有长轮询 worker，无法主动从微信拉取消息。
- 只保存纯文本笔记，没有命令解析和会话状态。
- 没有调用 `RunService.createRun()`，微信指令不会触发 Mastra 创作。
- 没有保存图片/文件到 workspace asset，也没有出站文件能力。
- 没有项目/草稿区选择状态，无法在微信里切换工作目录。
- 没有把微信消息写入 `ChatSessionStore`，Web 端无法看到同一条远程会话历史。

## 目标架构

建议把微信接入拆成四层，其中最重要的是 `AssistantChatBridge` 兼容层。微信不直接调用 agent，也不维护第二套创作状态；它只把外部消息转换成现有创作助手已经理解的会话操作。

1. `WechatStore`：只负责配置、连接状态、用户绑定、路由状态、幂等游标和消息记录。
2. `WechatIlinkClient`：只负责 ilink HTTP 协议，包括扫码、轮询、发消息、下载/解密媒体、上传或发送附件。
3. `WechatRouterAgent` / `WechatCommandService`：负责理解微信消息，既支持显式命令，也支持自然语言路由，例如“切到爱情公寓项目”“接着昨天那个草稿聊”“把第 2 集剧本发我”。它只输出结构化路由动作，不直接创作。
4. `AssistantChatBridge`：复用 Web 创作助手的后端流程，负责创建/选择 `ChatSession`、append 用户消息、调用 `RunService.createRun()`、订阅 `RunBus`、更新 assistant 消息和 stream events。

这样后续维护 agent、会话、Mastra run、stream 事件、文件变更、聊天历史时，只需要维护 `AssistantChatBridge` 和现有创作助手链路。微信、未来 QQ、飞书或其它外部入口都只实现自己的 platform adapter 和 command parser。

API 装配层仍在 [apps/api/src/app.ts](../../apps/api/src/app.ts)，但 `createWechatRoutes` 需要注入更多依赖：

```ts
createWechatRoutes({
  wechatStore,
  workspaceStore,
  chatSessionStore,
  assistantChatBridge,
  runService,
  runBus,
  ilinkClient,
})
```

同时增加后台 worker：

```text
WechatPoller -> WechatIlinkClient.getUpdates -> WechatCommandService.handleInbound
                                                     -> WechatRouterAgent.route
                                                     -> AssistantChatBridge.submitUserMessage
```

本地模拟 `POST /api/wechat/inbound` 可以保留，用于测试和调试，但它应走同一个 `WechatCommandService`，避免模拟入口和真实入口行为漂移。

### AssistantChatBridge 兼容层

`AssistantChatBridge` 的目标是把“创作助手聊天”从 Web UI 事件处理里抽成后端可复用服务。Web 端和微信端的差异应该只停留在输入输出适配层：

```ts
export type AssistantChatTarget =
  | { scope: 'project'; projectId: string; sessionId?: string }
  | { scope: 'temporary'; projectId: string; sessionId?: string };

export type AssistantChatSubmitInput = {
  source: RunSource;
  target: AssistantChatTarget;
  prompt: string;
  attachments?: ChatMessageAttachment[];
  referencedFiles?: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  onEvent?: (event: StreamEvent) => Promise<void> | void;
};

export type AssistantChatBridge = {
  submitUserMessage(input: AssistantChatSubmitInput): Promise<{
    session: ChatSession;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    run: AgentRun;
  }>;
};
```

`AssistantChatBridge.submitUserMessage()` 内部流程应与 [docs/current/05-chat-agent-sessions.md](./05-chat-agent-sessions.md) 里 Web 创作助手一致：创建用户消息、持久化到 `ChatSessionStore`、创建 run、创建 assistant 空消息、消费 `RunBus` 的 stream events、持续更新 assistant 消息。Web 端后续也可以逐步改为调用这个后端入口，避免前端和微信各自拼一遍 run 流程。

### 微信路由 Agent

固定指令适合兜底，但不应该是主要交互方式。微信端需要一个轻量 `WechatRouterAgent`，专门把自然语言消息转成结构化动作。它不接 workspace 写文件工具，也不启动创作 agent，只能读取项目列表、会话列表、当前微信用户 route state 和少量文件树摘要。

建议输出结构：

```ts
export type WechatRouteDecision =
  | { action: 'select_project'; projectId: string; confidence: number; reply?: string }
  | { action: 'select_session'; projectId: string; sessionId: string; confidence: number; reply?: string }
  | { action: 'select_draft'; projectId: string; sessionId: string; confidence: number; reply?: string }
  | { action: 'create_draft'; confidence: number; reply?: string }
  | { action: 'list_projects'; reply?: string }
  | { action: 'list_sessions'; projectId?: string; reply?: string }
  | { action: 'send_file'; projectId: string; path: string; reply?: string }
  | { action: 'chat'; projectId: string; sessionId: string; prompt: string; confidence: number }
  | { action: 'ask_clarification'; question: string; candidates?: Array<{ id: string; label: string }> };
```

路由 agent 的输入上下文应控制在很小范围：

- 当前微信用户、当前 route state。
- 正式项目列表：`projectId`、名称、更新时间。
- 当前项目或所有项目的最近会话列表：`sessionId`、标题、更新时间、最近一条消息摘要。
- 草稿区会话列表，也就是 `temp-*` project 上的 `ChatSession`。
- 当前 target 的顶层文件路径摘要，用于判断 `/发送` 或“把剧本发我”。

路由规则：

- 高置信度切换动作直接执行，并回复“已切到 ...”。
- 多个项目或会话名称相近时，返回 `ask_clarification`，让用户用自然语言或序号确认。
- 普通创作请求必须落到一个具体 `ChatSession`。如果当前 route state 已有会话，就续用；如果只有 project 没有 session，就创建或选择该项目最近的 assistant 会话；如果没有 target，则先让路由 agent 选择或追问。
- “新建草稿”“临时聊一下”“先别进正式项目”这类意图创建临时会话，并把 route state 切到该草稿。
- “继续上次”“回到刚才那个会话”“切到第 2 集修改那次”应选择已有 `ChatSession`，而不是新建。
- 显式斜杠命令仍保留为确定性快捷入口；命令解析优先于路由 agent。

`WechatRouterAgent` 可以先用规则 + 小模型 JSON schema 输出实现，后续替换模型或增强提示词不影响创作助手链路。关键约束是：它只决定“消息应该进入哪个已有或新建会话”，真正内容生成始终调用 `AssistantChatBridge`。

### 微信会话在前端显示和续聊

微信会话不应单独存在一套历史。所有微信创作消息都写入现有 `ChatSessionStore`，因此前端可以自然显示并继续对话。

建议在 `ChatSession` 上增加轻量来源元数据，而不是新增一类会话：

```ts
export type ChatSessionOrigin = {
  source: 'web' | 'wechat';
  externalUserId?: string;
  displayName?: string;
};

export type ChatSession = {
  // existing fields
  origin?: ChatSessionOrigin;
};
```

前端行为：

- 项目会话列表中显示微信创建或参与过的会话，可用一个小标识展示来源。
- 选择该会话后，Web 端继续发送消息仍走同一个 `AssistantChatBridge` 或现有 `createRun` 链路，`sessionId` 不变。
- 微信端切换到前端已有会话时，只更新 `WechatRouteState.target = { scope: 'project', projectId, sessionId }`，后续微信消息 append 到同一个 session。
- Web 端归档会话后，微信路由 agent 不默认选中归档会话；用户明确要求“切到归档的某某会话”时可以恢复或提示先在前端恢复。
- 草稿区同理，微信创建的草稿是 `temp-*` project + `ChatSession`，前端临时会话工作目录可以看到并继续聊。

## 数据模型

共享合同应先更新 [packages/shared/src/contracts.ts](../../packages/shared/src/contracts.ts)。建议新增或扩展：

```ts
export type WechatConnection = {
  displayName: string;
  externalUserId: string;
  connectedAt: string;
  channel: 'ilink';
  accountId: string;
  baseUrl: string;
  cdnBaseUrl?: string;
  allowFrom: string[];
};

export type WechatWorkspaceTarget =
  | { scope: 'project'; projectId: string }
  | { scope: 'draft'; projectId: string; sessionId: string };

export type WechatRouteState = {
  externalUserId: string;
  target: WechatWorkspaceTarget | null;
  updatedAt: string;
};

export type WechatInboundAttachment = {
  id: string;
  kind: 'image' | 'file' | 'video' | 'audio';
  name: string;
  mimeType: string;
  size?: number;
  contentBase64?: string;
  downloadUrl?: string;
  aesKey?: string;
};
```

`wechat.json` 建议保存：

- `connection`：不保存明文 token，或者只保存环境变量引用；如果必须本地保存，文档和 `.gitignore` 必须明确禁止提交。
- `setupSession`：扫码状态、二维码 URL、过期时间。
- `routeStates`：每个允许用户当前所在项目或草稿区。
- `inboundMessageIds`：幂等集合，后续可压缩为最近 N 条或按时间清理。
- `pollCursor`：`getUpdates` 游标。
- `contextTokens`：按用户/会话缓存 ilink `context_token`。

## 微信命令设计

微信端指令需要短、容错、适合自然语言。建议第一版使用显式命令 + 默认自然语言执行：

```text
/项目
/项目 <项目名或序号>
/草稿
/草稿 新建
/草稿 <序号>
/在哪
/文件
/发送 <路径>
/帮助
```

行为：

- `/项目`：列出正式项目，返回序号、名称、更新时间。
- `/项目 2` 或 `/项目 爱情公寓重写`：把该微信用户的 route state 切到项目工作区。
- `/草稿`：列出临时会话工作目录。
- `/草稿 新建`：调用 `workspaceStore.createTemporaryProject()` 和 `chatSessionStore.createSession()`，切到新草稿区。
- `/在哪`：返回当前目标是项目还是草稿区，以及 projectId/sessionId。
- `/文件`：列出当前目标的顶层文件。
- `/发送 03 剧本/第1集/剧本.md`：读取当前目标文件并通过微信文件消息发回。
- 其它文本：作为创作指令，在当前目标启动 Mastra run。

没有选择目标时，默认策略建议是：

- 如果只有一个正式项目，自动切到该项目。
- 如果有多个正式项目，要求用户先发 `/项目` 选择。
- 如果没有正式项目，创建草稿区，而不是创建正式项目，避免远程误建项目。

## 创作指令执行流程

微信文本进入 `WechatCommandService` 后：

1. 校验 `externalUserId` 在 `allow_from` 中。
2. 用 `externalMessageId` 做幂等。
3. 解析命令；如果是切换/查询/发送文件，直接执行并回复。
4. 如果是普通创作指令，解析当前 `WechatWorkspaceTarget`。
5. 为当前 target 找到或创建微信专用 `ChatSession`，标题可用 `微信远程创作`。
6. 把用户消息 append 到 `ChatSessionStore`。
7. 调用 `runService.createRun({ source: 'wechat', projectId, sessionId, prompt })`。
8. 订阅 `runBus` 中对应 `runId` 的 `text.delta`、`file.changed`、`run.end`。
9. 对微信端做节流回复：开始时发“已收到，正在处理”；过程中按 2 到 5 秒或 800 字合并发送；结束时发送摘要和变更文件列表。
10. 把 assistant 回复和 stream events 更新回同一个 `ChatSessionStore`，让 Web 端能看到远程会话。

微信端不适合高频展示 tool delta。默认只回传正文、最终状态和文件变更；调试模式再开启工具事件。

## 图片和文件入站

入站附件处理策略：

- 图片保存到当前 target 的 `微信素材/图片/<日期>/<文件名>`。
- 普通文件保存到 `微信素材/文件/<日期>/<文件名>`。
- 语音有转写文本时作为文本消息；无转写时保存为 `微信素材/语音/<日期>/<文件名>`，后续再接 STT。
- 视频保存到 `微信素材/视频/<日期>/<文件名>`。

保存使用现有 workspace asset 能力：

- 项目区：`workspaceStore.createWorkspaceAsset(projectId, path, bytes, mimeType)`
- 草稿区：草稿本质是 `temp-*` project，同样使用项目 asset API。

带附件的自然语言创作指令需要把素材路径追加到 prompt，例如：

```text
用户从微信上传了 2 个素材，已保存：
- 微信素材/图片/2026-06-03/stage-reference.jpg
- 微信素材/文件/2026-06-03/人物设定.docx

用户指令：根据这张舞台图，改写第 3 集开场。
```

如果附件是可读文本文件，后续可以尝试提取文本并作为 `referencedSnippets`；第一版不要对 docx/pdf 做复杂解析，先保存并把路径告知 agent。

## 图片和文件出站

出站能力分两类：

- 用户显式 `/发送 <路径>`：读取 workspace bytes，通过 ilink 文件或图片消息发回。
- agent 运行结束后自动提示变更文件：先发文件路径和摘要，不默认发送大文件，避免微信刷屏。用户再用 `/发送` 拉取。

图片 MIME 类型以 `image/` 开头时走图片发送；其它走文件发送。需要处理微信单文件大小限制，超限时回退为文本提示。

## ilink 客户端能力

`WechatIlinkClient` 建议接口：

```ts
export type WechatIlinkClient = {
  createQrCode(input: { botType?: number; routeTag?: string }): Promise<{ qrUrl: string; token?: string; accountId?: string }>;
  checkLogin(sessionId: string): Promise<{ connected: boolean; token?: string; externalUserId?: string; displayName?: string }>;
  getUpdates(input: { cursor?: string; timeoutMs: number }): Promise<{ cursor: string; updates: WechatIlinkUpdate[] }>;
  sendText(input: { to: string; text: string; contextToken?: string }): Promise<void>;
  sendImage(input: { to: string; bytes: Buffer; name: string; mimeType: string; contextToken?: string }): Promise<void>;
  sendFile(input: { to: string; bytes: Buffer; name: string; mimeType: string; contextToken?: string }): Promise<void>;
  downloadMedia(input: WechatIlinkMediaRef): Promise<{ bytes: Buffer; mimeType: string; name: string }>;
};
```

具体 ilink HTTP 字段以后端实测为准。cc-connect 文档说明的稳定协议形态是 `getUpdates` 长轮询 + `sendMessage` 下发，图片/文件需要通过 CDN 下载并解密。

## 安全要求

- `allow_from` 不能为空；本地调试可允许 `*`，生产不允许。
- token、AES key、context token 不写日志。
- `wechat.json` 属于运行时数据，不提交。
- 所有 workspace 路径继续走 `WorkspaceStore` 安全校验，不接受绝对路径和 `..`。
- 出站 `/发送` 只能发送当前 target 下的文件。
- 每个微信用户维护独立 route state，避免多人切换互相影响。
- 增加每用户频率限制，防止长轮询重试或用户刷屏重复触发 agent run。

## 实施计划

第一阶段：业务语义跑通

- 扩展 `WechatStore` 数据结构，保存 route state、微信会话映射和附件元数据。
- 抽出 `WechatCommandService`，让模拟 `POST /api/wechat/inbound` 支持 `/项目`、`/草稿`、普通创作指令和附件保存。
- 注入 `ChatSessionStore`、`RunService`、`RunBus`，微信普通文本能启动 `source: 'wechat'` 的 Mastra run。
- API 测试覆盖：项目切换、草稿新建、幂等、附件保存、run 创建。

第二阶段：ilink 接入

- 新增 `WechatIlinkClient` 和配置字段：`token`、`baseUrl`、`cdnBaseUrl`、`accountId`、`routeTag`、`allowFrom`、`longPollTimeoutMs`。
- 将 setup session 从本地模拟改为扫码或 token 绑定。
- 增加 `WechatPoller`，API 启动后可按配置开启长轮询。
- 处理 `context_token`、游标持久化、会话过期和重试。

第三阶段：媒体互传

- 实现 ilink 媒体下载、AES-128-ECB 解密和 workspace asset 保存。
- 实现 `/发送 <路径>` 的图片/文件出站。
- 为 agent 结束后的 `file.changed` 建立微信摘要和拉取提示。

第四阶段：前端管理

- 微信接入 modal 展示真实 ilink 状态、扫码 URL、绑定用户、当前 target、最近消息和轮询健康状态。
- 支持设置 `allow_from`、`base_url`、`cdn_base_url`、`route_tag`，敏感 token 只允许写入不回显。

## 验证

相关测试命令：

```bash
pnpm --filter @viwork/api test
pnpm --filter @viwork/api typecheck
pnpm --filter @viwork/web typecheck
```

重点测试文件：

- [apps/api/src/routes/wechat.test.ts](../../apps/api/src/routes/wechat.test.ts)
- [apps/api/src/wechat/wechatStore.ts](../../apps/api/src/wechat/wechatStore.ts)
- [apps/api/src/routes/runs.test.ts](../../apps/api/src/routes/runs.test.ts)
- [apps/api/src/chat/chatSessionStore.test.ts](../../apps/api/src/chat/chatSessionStore.test.ts)

真实 ilink 联调时还需要手工验证：

- 扫码登录成功并写入连接状态。
- 允许用户发第一条消息后 `context_token` 被缓存。
- `/项目`、`/草稿 新建`、普通创作指令可连续执行。
- 微信图片和文件能保存到当前项目或草稿区。
- `/发送 <路径>` 能回传文本、图片和普通文件。
- run 结束后微信收到正文回复和文件变更摘要。
