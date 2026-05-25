# 技能广场与 Agent 配置

## 技能广场

技能广场用于管理可启用/停用的情景剧创作技能。后端实现：

- Store：[apps/api/src/skills/skillStore.ts](../../apps/api/src/skills/skillStore.ts)
- Route：[apps/api/src/routes/skills.ts](../../apps/api/src/routes/skills.ts)

持久化文件：

```text
apps/api/data/skills/skills.json
```

默认系统技能：

- `character-bio`：角色小传
- `conflict-pass`：冲突强化
- `storyboard-breakdown`：分镜拆解
- `video-prompt`：视频提示词

API：

- `GET /api/skills`
- `POST /api/skills`
- `PATCH /api/skills/:slug`

前端入口在 [apps/web/src/main.tsx](../../apps/web/src/main.tsx)：

- `loadSkills`
- `toggleSkill`
- `createSkill`

当前技能广场 UI 通过顶部“技能广场”按钮打开 modal。

## 全局 Agent 配置

Agent 配置不是技能广场同一个系统。它是 Codex CLI 运行时配置源，存放在全局工作区：

```text
apps/api/data/workspaces/_global/Agent 配置
```

包含：

- `AGENTS.md`
- `config.toml`
- `installation_id`
- `skills/*/SKILL.md`
- `plugins`（如果用户创建）

初始化和迁移由 [apps/api/src/storage/workspaceStore.ts](../../apps/api/src/storage/workspaceStore.ts) 的 `ensureGlobalWorkspace()` 和 `migrateGlobalAgentConfig()` 处理。

## Codex HOME 复制

发起 Codex run 时，[apps/api/src/runs/codexRunService.ts](../../apps/api/src/runs/codexRunService.ts) 的 `prepareCodexHome()` 会从全局 Agent 配置复制到：

```text
apps/api/data/.codex-home/<sessionId 或 runId>
```

复制内容：

- `AGENTS.md`
- `config.toml`
- `skills`
- `plugins`

这意味着：

- 用户在全局区编辑 `Agent 配置/config.toml`，下一次 run 会复制最新版本。
- 运行中 Codex 对 HOME 的修改不会污染全局配置。
- 同一个 `sessionId` 会复用同一个 `.codex-home/<sessionId>`，适合多轮会话。

## 全局知识库与模板库

全局工作区还有：

- `知识库`
- `模板库`

这两个目录会作为 Codex `additionalDirectories` 提供给 agent，只读/可读上下文由 Codex sandbox 策略处理。当前 `threadOptions` 使用：

```ts
additionalDirectories: await getGlobalResourceDirectories(store)
```

## 扩展建议

如果要让技能广场和 Codex HOME 中的 `skills` 打通，需要明确同步方向：

- 技能广场 -> `Agent 配置/skills`：适合 UI 管理 Codex skills。
- `Agent 配置/skills` -> 技能广场：适合文件系统为主，UI 只做展示。

当前版本二者是并行能力，不要假设 `skills.json` 会自动同步到 Codex HOME。

