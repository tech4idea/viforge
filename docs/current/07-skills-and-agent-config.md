# Agent Skills 与 Agent 配置

## Agent Skills

Agent skills 只以全局工作区中的 Codex skills 目录为来源。后端实现：

- Store：[apps/api/src/skills/skillStore.ts](../../apps/api/src/skills/skillStore.ts)
- Agent skill scanner：[apps/api/src/skills/agentConfigSkills.ts](../../apps/api/src/skills/agentConfigSkills.ts)
- Route：[apps/api/src/routes/skills.ts](../../apps/api/src/routes/skills.ts)

持久化目录：

```text
~/.viforge/data/<productId>/workspaces/_global/Agent 配置/skills/*/SKILL.md
```

API：

- `GET /api/skills`：扫描 `Agent 配置/skills` 并返回可用 Codex skills。
- `POST /api/skills`：在 `Agent 配置/skills/<slug>/SKILL.md` 创建一个文件技能。
- `PATCH /api/skills/:slug`：文件技能不支持启用/停用，当前会返回 404。

前端入口在 [apps/web/src/main.tsx](../../apps/web/src/main.tsx)：

- `loadSkills`
- `createSkill`

旧的 `apps/api/data/skills/skills.json` 广场技能不再作为产品技能来源。新增或编辑 skill 时，应直接操作全局区的 `Agent 配置/skills` 目录。

## 全局 Agent 配置

Agent 配置是 Codex CLI 运行时配置源，存放在全局工作区：

```text
~/.viforge/data/<productId>/workspaces/_global/Agent 配置
```

包含：

- `AGENTS.md`
- `config.toml`
- `auth.json`
- `installation_id`
- `skills/*/SKILL.md`
- `plugins`（如果用户创建）

默认 `AGENTS.md` 来自 active product profile，是 viforge system agent。当前 `novel-adaptation` profile 负责路由 `brainstorm-agent`、`source-analyst-agent`、`adaptation-planner-agent`、`screenwriter-agent`、`reviewer-agent`。其中 `brainstorm-agent` 只做普通对话式方向探索，不进入审稿或返工闭环；原著分析、改编方案和剧本才进入创作/审稿/返工闭环。默认 `skills` 由 profile 的 `defaultAgentSkillNames` 声明，当前包含：

- `brainstorm-agent`
- `source-analyst-agent`
- `adaptation-planner-agent`
- `screenwriter-agent`
- `reviewer-agent`

`SKILL.md` 必须带 Codex 要求的 YAML frontmatter，至少包含 `name` 和 `description`，否则 Codex CLI 启动时会报 `missing YAML frontmatter delimited by ---`。默认 viforge skills 都带 frontmatter。

如果旧工作区仍使用历史默认 `AGENTS.md`，或使用已知的上一版 viforge 默认 system agent，初始化全局工作区时会升级为新的 system agent；用户自定义过的 `AGENTS.md` 不会被覆盖。已知的上一版默认 viforge agent skills 会升级为带 frontmatter 的版本；自定义 skill 不会被覆盖，但如果缺少 frontmatter，会自动在文件头部补一个最小可用 frontmatter，保留原正文。

`config.toml` 中的 `[viforge].max_revision_rounds` 控制自动返工上限，默认值为 `5`。如果已有 `config.toml` 没有该配置，初始化全局工作区时会追加该配置，不覆盖现有 Codex 配置。

初始化和迁移由 [apps/api/src/storage/workspaceStore.ts](../../apps/api/src/storage/workspaceStore.ts) 的 `ensureGlobalWorkspace()` 和 `migrateGlobalAgentConfig()` 处理。`createWorkspaceStore(root, { productProfile })` 可显式注入 profile；未注入时读取 `VIFORGE_PRODUCT` 对应的 active profile。

`buildCodexPrompt()` 会扫描 `Agent 配置/skills`，把默认四个 agent 之外的附加 skill 名称和描述写入提交给 CLI 的 prompt。`prepareCodexHome()` 会把整个 `skills` 目录复制进运行时 `CODEX_HOME/skills`，所以下一次新 run 或同一 session 的后续 run 都能看到最新 skill。

## Codex HOME 复制

发起 Codex run 时，[apps/api/src/runs/codexRunService.ts](../../apps/api/src/runs/codexRunService.ts) 的 `prepareCodexHome()` 会从全局 Agent 配置复制到：

```text
~/.viforge/data/<productId>/workspaces/.codex-home/<sessionId 或 runId>
```

复制内容：

- `AGENTS.md`
- `config.toml`
- `auth.json`
- `installation_id`
- `skills`
- `plugins`

这意味着：

- 用户在全局区编辑 `Agent 配置/config.toml` 或 `Agent 配置/auth.json`，下一次 run 会复制最新版本。
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
