# Agent Skills 与 Agent 配置

## Agent Skills

Agent skills 只以全局工作区中的 `Agent 配置/skills` 目录为来源。当前 LangGraph runtime 会把这些 `SKILL.md` 作为 specialist agent 指令读取；历史 Codex runtime 也使用同一目录作为 Codex skills 来源。后端实现：

- Store：[apps/api/src/skills/skillStore.ts](../../apps/api/src/skills/skillStore.ts)
- Agent skill scanner：[apps/api/src/skills/agentConfigSkills.ts](../../apps/api/src/skills/agentConfigSkills.ts)
- Route：[apps/api/src/routes/skills.ts](../../apps/api/src/routes/skills.ts)

持久化目录：

```text
~/.viforge/data/<productId>/workspaces/_global/Agent 配置/skills/*/SKILL.md
```

API：

- `GET /api/skills`：扫描 `Agent 配置/skills` 并返回可用 agent skills。
- `POST /api/skills`：在 `Agent 配置/skills/<slug>/SKILL.md` 创建一个文件技能。
- `PATCH /api/skills/:slug`：文件技能不支持启用/停用，当前会返回 404。

前端入口在 [apps/web/src/main.tsx](../../apps/web/src/main.tsx)：

- `loadSkills`
- `createSkill`

旧的 `apps/api/data/skills/skills.json` 广场技能不再作为产品技能来源。新增或编辑 skill 时，应直接操作全局区的 `Agent 配置/skills` 目录。

## 全局 Agent 配置

Agent 配置是当前产品 agent 指令和运行策略的全局配置源，存放在全局工作区：

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

`SKILL.md` 使用 YAML frontmatter 描述 agent skill，至少包含 `name` 和 `description`。当前 LangGraph runtime 会去掉 frontmatter 后把正文作为 specialist instruction；保留 frontmatter 是为了技能列表展示和兼容历史 Codex runtime。默认 viforge skills 都带 frontmatter。

如果旧工作区仍使用历史默认 `AGENTS.md`，或使用已知的上一版 viforge 默认 system agent，初始化全局工作区时会升级为新的 system agent；用户自定义过的 `AGENTS.md` 不会被覆盖。已知的上一版默认 viforge agent skills 会升级为带 frontmatter 的版本；自定义 skill 不会被覆盖，但如果缺少 frontmatter，会自动在文件头部补一个最小可用 frontmatter，保留原正文。

`config.toml` 中的 `[viforge].max_revision_rounds` 控制自动返工上限，默认值为 `5`。如果已有 `config.toml` 没有该配置，初始化全局工作区时会追加该配置，不覆盖现有配置。

初始化和迁移由 [apps/api/src/storage/workspaceStore.ts](../../apps/api/src/storage/workspaceStore.ts) 的 `ensureGlobalWorkspace()` 和 `migrateGlobalAgentConfig()` 处理。`createWorkspaceStore(root, { productProfile })` 可显式注入 profile；未注入时读取 `VIFORGE_PRODUCT` 对应的 active profile。

当前 LangGraph agent registry 会按项目 product profile 读取 `Agent 配置/AGENTS.md` 和 `Agent 配置/skills/*/SKILL.md`，生成 system agent 与 specialist agent。下一次新 run 或同一 session 的后续 run 都会重新读取当前工作区配置，因此能看到最新 skill。

## 历史 Codex HOME 复制

以下内容只适用于历史 Codex runtime。当前默认 LangGraph runtime 不再复制 `CODEX_HOME`，而是直接读取工作区里的 Agent 配置。历史 Codex runtime 发起 run 时会从全局 Agent 配置复制到：

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

这两个目录在当前 LangGraph runtime 中通过工作区读取、知识检索和项目上下文工具提供给 agent。历史 Codex runtime 曾把它们作为 `additionalDirectories` 提供给 agent：

```ts
additionalDirectories: await getGlobalResourceDirectories(store)
```
