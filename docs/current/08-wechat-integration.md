# 远程微信接入

## 目标

远程微信接入用于把外部微信消息写入当前系统的情景剧创作工作区，作为远程灵感、修改请求或素材记录。

当前实现是本地模拟/接口能力，不是真实微信开放平台 OAuth。

## 后端实现

Store：[apps/api/src/wechat/wechatStore.ts](../../apps/api/src/wechat/wechatStore.ts)

Route：[apps/api/src/routes/wechat.ts](../../apps/api/src/routes/wechat.ts)

持久化文件：

```text
apps/api/data/wechat.json
```

状态结构：

- `connection`
- `setupSession`
- `inboundMessageIds`

## API

- `GET /api/wechat/status`
- `POST /api/wechat/setup-sessions`
- `POST /api/wechat/setup-sessions/:sessionId/complete`
- `POST /api/wechat/inbound`

`createSetupSession()` 生成：

```text
viwork-wechat://pair/<sessionId>
```

`completeSetupSession()` 写入连接信息。

`acceptInbound()` 校验：

- 已连接。
- `externalUserId` 和连接用户一致。
- `externalMessageId` 没有处理过。

通过后写入项目文件：

```text
remote-wechat/<ISO 时间>.md
```

如果当前没有项目，会创建一个“远程微信灵感箱”项目。

## 前端入口

顶部“微信接入”按钮打开 modal。相关函数在 [apps/web/src/main.tsx](../../apps/web/src/main.tsx)：

- `loadWechatStatus`
- `createWechatSetup`
- `completeWechatSetup`

当前 UI 支持：

- 查看连接状态。
- 生成连接码。
- 模拟扫码完成。

## 扩展真实微信接入

可以保留当前后端接口语义，把真实 webhook 适配到 `POST /api/wechat/inbound`：

```json
{
  "externalMessageId": "msg-id",
  "externalUserId": "openid",
  "displayName": "用户昵称",
  "text": "消息正文"
}
```

真实平台要补充：

- 签名校验。
- 消息解密。
- 重试幂等。
- access token 管理。
- 多用户或多项目路由策略。

