# 工作区文件系统

## 数据模型

工作区由真实文件系统承载，核心实现位于 [apps/api/src/storage/workspaceStore.ts](../../apps/api/src/storage/workspaceStore.ts)。

根目录：

- 默认：`~/.viwork/data/<productId>/workspaces`（解析 `process.env.HOME` 和 `VIWORK_PRODUCT` 后拼出 `${HOME}/.viwork/data/<productId>/workspaces`）
- 环境变量覆盖：`WORKSPACES_ROOT`
- 产品选择：`VIWORK_PRODUCT`，默认 `novel-adaptation`

默认根目录故意落在 viwork 源码树之外，并按 product id 隔离。Codex CLI 启动时会从 `--cd` 指定的目录向上递归查找 `AGENTS.md` 并把它注入 system prompt；如果根目录在 `apps/api/data/workspaces` 里，向上回溯就会命中 `/home/wbo/project/viwork/AGENTS.md`，把 viwork 仓库的编码规范混进创作 system agent 的提示词。落到 `~/.viwork/data/<productId>/workspaces` 之后，CWD 与 `<CODEX_HOME>/AGENTS.md` 都不在源码树里，那份仓库根 `AGENTS.md` 不会再上溯。仍想用旧路径（`apps/api/data/workspaces`）的开发者只要显式 `export WORKSPACES_ROOT=...` 即可。

特殊目录：

- `_global`：全局区域。
- `<projectId>`：当前产品项目区域。
- `temp-*`：临时会话工作目录，由临时创作助手会话创建，不出现在正式项目列表中。
- `project.json`：项目元数据文件。

## WorkspaceStore 能力

`WorkspaceStore` 暴露两套对称能力：

全局区：

- `listGlobalWorkspaceEntries`
- `readGlobalWorkspaceFile`
- `readGlobalWorkspaceFileBytes`
- `writeGlobalWorkspaceFile`
- `createGlobalWorkspaceFolder`
- `createGlobalWorkspaceFile`
- `createGlobalWorkspaceAsset`
- `moveGlobalWorkspaceEntry`
- `deleteGlobalWorkspaceEntry`

项目区：

- `createProject`
- `listProjects`
- `getProject`
- `listWorkspaceEntries`
- `readWorkspaceFile`
- `readWorkspaceFileBytes`
- `writeWorkspaceFile`
- `createWorkspaceFolder`
- `createWorkspaceFile`
- `createWorkspaceAsset`
- `moveWorkspaceEntry`
- `deleteWorkspaceEntry`

路径安全由 `assertSafePath` 保障：

- 拒绝绝对路径。
- 规范化相对路径。
- 拒绝跳出 workspace root 的 `..` 路径。
- 拒绝非法 project id。

## 全局 Agent 配置迁移

`ensureGlobalWorkspace()` 会初始化全局目录，并迁移旧位置的 agent 配置：

- `AGENTS.md` -> `Agent 配置/AGENTS.md`
- `config.toml` -> `Agent 配置/config.toml`
- `skills` -> `Agent 配置/skills`
- `plugins` -> `Agent 配置/plugins`

这保证全局区的 Agent 配置、知识库、模板库职责分离。

## HTTP API

路由位于 [apps/api/src/routes/projects.ts](../../apps/api/src/routes/projects.ts)。

全局区：

- `GET /api/global/files`
- `POST /api/global/folders`
- `POST /api/global/files`
- `POST /api/global/assets`
- `GET /api/global/raw/*`
- `GET /api/global/files/*`
- `PUT /api/global/files/*`
- `PATCH /api/global/files/*/move`
- `DELETE /api/global/files/*`

项目区：

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `GET /api/projects/:projectId/files`
- `POST /api/projects/:projectId/folders`
- `POST /api/projects/:projectId/files`
- `POST /api/projects/:projectId/assets`
- `GET /api/projects/:projectId/raw/*`
- `GET /api/projects/:projectId/files/*`
- `PUT /api/projects/:projectId/files/*`
- `PATCH /api/projects/:projectId/files/*/move`
- `DELETE /api/projects/:projectId/files/*`

## 前端联动

前端在 [apps/web/src/main.tsx](../../apps/web/src/main.tsx) 中维护：

- `projects`
- `entries`
- `globalEntries`
- `temporaryEntriesByProject`
- `activeWorkspaceScope`
- `selectedProjectId`
- `selectedProjectPath`
- `selectedGlobalPath`
- `selectedTemporaryProjectId`
- `selectedTemporaryPath`
- `collapsedGlobalPaths`
- `collapsedDirectoriesByProject`
- `collapsedTemporarySessionIds`
- `collapsedDirectoriesByTemporaryProject`

工作区树包含全局区域、正式项目和临时会话工作目录。分组标题和说明来自 active product profile。临时会话工作目录位于项目区域下方，始终可见但默认折叠；展开后每个临时会话对应一个 `temp-*` workspace 节点，临时会话节点也默认折叠。展开节点后复用项目文件 API 完成预览、编辑、上传、重命名、删除和同目录内拖拽移动。

工作区树可右键新建、上传、重命名、删除，也支持拖拽移动。拖拽移动入口：

- `handleEntryDragStart`
- `handleDropTargetDragOver`
- `handleDropOnDirectory`
- `moveEntryToDirectory`

上传逻辑会根据当前选中目录或右键目录决定目标目录：

- `resolveUploadTarget`
- `startUpload`
- `uploadAsset`

## 测试

覆盖点：

- [apps/api/src/storage/workspaceStore.test.ts](../../apps/api/src/storage/workspaceStore.test.ts)
- [apps/api/src/routes/projects.test.ts](../../apps/api/src/routes/projects.test.ts)
- [apps/web/src/workspace-tree.test.ts](../../apps/web/src/workspace-tree.test.ts)
