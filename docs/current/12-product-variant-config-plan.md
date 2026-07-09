# 双产品维护与配置化方案

本文讨论后续如何同时维护两个 viforge 产品形态：

- 情景剧创作工作台
- 小说改编剧本工作台

目标是基础能力一起迭代，只让 agent、工作流、模板、知识库和少量产品文案不同，避免复制两套应用长期分叉。

## 结论

建议不要维护两个长期分叉应用。更稳妥的方式是把当前 monorepo 抽象成一个共享 viforge platform，再用 `product profile` 配置不同创作域。

基础能力保持一套：

- React/Vite 三栏工作台
- Hono API
- 文件系统工作区
- 会话持久化
- Mastra run service
- SSE 流式事件
- 文件引用和聊天片段引用
- 图片生成
- Agent 配置与 skills 管理
- 微信接入
- 预览、编辑、上传、重命名、删除、拖拽移动

差异能力放进产品配置：

- 产品名、页面标题、默认项目名和默认描述
- 左侧工作区分组名称
- 默认项目目录和文件模板
- 全局知识库和模板库
- 默认 agent 列表和 `SKILL.md` 内容
- system agent protocol
- prompt suggestions
- agent timeline label
- 正式产物路径规则
- reviewer 质量门槛

这样两个产品可以共享代码和测试，只在配置和少量 domain-specific 文案上分化。

## 不推荐方案

### 长期维护两个分支

优点是短期快，改起来直接。

问题是基础能力会迅速漂移。比如 Mastra streaming、会话、图片生成、工作区文件 API、编辑器预览、微信接入、权限和日志，一旦在一个分支修 bug，另一个分支就要手动 cherry-pick。随着 runtime 和 UI 继续迭代，这会变成高维护成本。

这个方案只适合原型验证，不适合后续产品化。

### 复制两套 apps

例如 `apps/web-sitcom`、`apps/web-adaptation`、`apps/api-sitcom`、`apps/api-adaptation`。

这比长期分支稍好，因为在同一 repo 里，但仍会导致 UI、API、storage、chat、runs、tests 重复。除非两个产品的基础交互会完全不同，否则不划算。

## 推荐方案：Product Profile

新增一个共享配置层，例如：

```text
packages/shared/src/productProfiles.ts
```

核心类型可以先保持简单：

```ts
export type ProductProfile = {
  id: 'sitcom' | 'novel-adaptation';
  name: string;
  documentTitle: string;
  defaultProjectName: string;
  defaultProjectDescription: string;
  workspaceSectionTitle: string;
  workspaceSectionDescription: string;
  globalDirectories: string[];
  globalFiles: TemplateFile[];
  projectDirectories: string[];
  projectFiles: TemplateFile[];
  promptSuggestions: string[];
  defaultAgentSkillNames: string[];
  agentLabels: Record<string, string>;
  artifactPaths: {
    sourceAnalysis?: string[];
    plan?: string[];
    script: string;
  };
};
```

运行时通过环境变量或构建变量选择：

```bash
VIFORGE_PRODUCT=novel-adaptation pnpm --filter @viforge/api dev
VIFORGE_PRODUCT=novel-adaptation pnpm --filter @viforge/web dev
```

如果前后端都从 `packages/shared` 读取同一个 profile，合同会更稳。后续也可以让 API 暴露：

```text
GET /api/product-profile
```

前端运行时读取 profile，减少 web 构建变量依赖。

## 需要抽象的代码点

### Shared templates

当前 `packages/shared/src/templates.ts` 承担了默认目录、默认文件、全局知识库、skills、system agent 和 prompt suggestions。

建议拆成：

```text
packages/shared/src/productProfiles/common.ts
packages/shared/src/productProfiles/sitcom.ts
packages/shared/src/productProfiles/novel-adaptation.ts
packages/shared/src/productProfiles/index.ts
```

`common.ts` 放共享 helper，比如 `skillFrontmatter()`、`directoryNode()`、`episodeScriptFiles()`、`shotFiles()`、`videoFiles()`、`deliverableFiles()`。

`sitcom.ts` 和 `novel-adaptation.ts` 只描述差异配置。

### Workspace store

当前 `workspaceStore` 直接导入默认目录和默认文件。

建议改成：

```ts
createWorkspaceStore(root, { productProfile })
```

或在 store 内通过 `getActiveProductProfile()` 读取。更推荐依赖注入，测试更清楚。

初始化逻辑需要从 profile 读取：

- `globalDirectories`
- `globalFiles`
- `projectDirectories`
- `projectFiles`
- `defaultAgentSkillNames`
- legacy migration 规则

### Mastra run service

Mastra 是基础能力，不应该按产品分叉。差异应该来自 profile 和全局 `Agent 配置/AGENTS.md`。

建议：

- `buildMastraPrompt()` 的标题由 profile 提供，比如 `# 小说改编剧本创作请求`。
- `buildMastraInstructions()` 的系统说明由 profile 提供。
- fallback protocol 使用 profile 的默认 system agent。
- Mastra workflow 后续如果显式化，也从 profile 读取 agent graph。

一个可能的 workflow 配置：

```ts
workflow: {
  brainstormAgent: 'brainstorm-agent',
  formalStages: [
    { agent: 'source-analyst-agent', reviewPhase: '原著审稿' },
    { agent: 'adaptation-planner-agent', reviewPhase: '方案审稿' },
    { agent: 'screenwriter-agent', reviewPhase: '剧本审稿' },
  ],
  reviewerAgent: 'reviewer-agent',
  maxRevisionRoundsKey: 'max_revision_rounds',
}
```

情景剧 profile 可以是：

```ts
formalStages: [
  { agent: 'story-agent', reviewPhase: '故事审稿' },
  { agent: 'screenwriter-agent', reviewPhase: '剧本审稿' },
]
```

小说改编 profile 可以是：

```ts
formalStages: [
  { agent: 'source-analyst-agent', reviewPhase: '原著审稿' },
  { agent: 'adaptation-planner-agent', reviewPhase: '方案审稿' },
  { agent: 'screenwriter-agent', reviewPhase: '剧本审稿' },
]
```

### Web UI

前端应尽量不硬编码领域文案。

需要配置化：

- `DEFAULT_PROJECT_NAME`
- `DEFAULT_PROJECT_DESCRIPTION`
- document title
- `WORKSPACE_SECTIONS[1]`
- empty project text
- skill 创建默认值
- prompt placeholder
- reference helper text
- agent label map

建议新增：

```text
apps/web/src/product-profile.ts
```

该文件从 API 或 shared profile 拿配置，供 `main.tsx`、`workspace-tree.ts`、`assistant-stream.tsx` 使用。

## 数据隔离

两个产品如果共用一套机器，建议工作区根目录按产品隔离：

```text
~/.viforge/data/sitcom/workspaces
~/.viforge/data/novel-adaptation/workspaces
```

否则全局 `Agent 配置`、知识库、模板库会互相覆盖。

可以用：

```bash
WORKSPACES_ROOT=~/.viforge/data/novel-adaptation/workspaces
```

更好的默认值是让 `WORKSPACES_ROOT` 自动带上 product id：

```ts
~/.viforge/data/<productId>/workspaces
```

这样两个产品共享代码，但数据天然隔离。

## 迁移策略

### 第一阶段：稳定当前小说改编分支

- 保留 Mastra 为默认 run service。
- 小说改编 profile 暂时仍可以内联在 `templates.ts` 和少量 UI 常量里。
- 清理明显的情景剧文案和测试断言。
- 文档声明 Codex runtime 是历史实现，不再作为默认运行方案。

### 第二阶段：抽出 Product Profile

- 新增 `ProductProfile` 类型。
- 把当前小说改编模板迁移到 `novel-adaptation` profile。
- 把情景剧旧模板恢复为 `sitcom` profile。
- `workspaceStore`、`MastraRunService`、`web` 都从 profile 读取领域配置。
- 加 `VIFORGE_PRODUCT` 或 `/api/product-profile`。

### 第三阶段：显式 Mastra workflow

- 不再只依赖 system agent 在一条回复里自觉路由。
- 后端按 profile.workflow 明确执行 agent stages。
- reviewer 返回结构化结果。
- 达标后由后端写入正式产物路径。
- 前端 timeline 继续消费统一的 `agent.*` events。

### 第四阶段：产品包和部署

同一代码库可以产出两个启动入口：

```bash
pnpm dev:sitcom
pnpm dev:novel
```

或两套 Docker compose env：

```text
VIFORGE_PRODUCT=sitcom
VIFORGE_PRODUCT=novel-adaptation
```

基础能力升级只改一次，产品差异只改 profile。

## 测试策略

共享基础能力测试不应关心具体产品：

- API path encoding
- workspace file CRUD
- chat session persistence
- run event SSE
- image generation routes
- viewer/editor behavior

产品 profile 测试应覆盖：

- 每个 profile 的默认目录和文件完整。
- 每个 profile 的默认 `AGENTS.md` 包含对应 agent 列表。
- 每个 profile 的正式产物路径存在。
- agent label 和 trace phase 能被前端正确展示。

建议新增矩阵测试：

```ts
for (const profile of [sitcomProfile, novelAdaptationProfile]) {
  it(`creates default workspace for ${profile.id}`, ...)
}
```

## 风险点

- 不要把“领域配置”拆得过细。第一版 profile 只抽当前确实有差异的字段。
- 不要让 profile 变成任意脚本执行。配置应该是结构化数据和 markdown prompt，不是可执行代码。
- 工作区迁移要保守。用户自定义的 `AGENTS.md` 和 skills 不应被强制覆盖。
- agent workflow 显式化后，需要定义 reviewer 的结构化输出，否则后端无法稳定判断“通过 / 打回 / 打回对象”。

## 建议的近期实现

当前最实用的下一步是先抽 `ProductProfile`，但暂时只支持 `novel-adaptation` 一个 active profile。等小说改编版本跑稳后，再把情景剧旧配置补回 `sitcom` profile。

这样不会为了抽象而一次性重写太多，同时能避免后续继续把领域差异散落到 `templates.ts`、`main.tsx`、`workspace-tree.ts`、`mastraRunService.ts` 和测试里。
