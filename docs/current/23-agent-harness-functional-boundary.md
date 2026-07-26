# Agent Harness 当前功能边界

本文基于当前代码实现梳理 Agent Harness 的功能边界。目标不是定义下一版交互，而是先明确现在系统到底在管理什么、运行时如何生效、哪些能力已经存在、哪些只是底层模型预留或 UI 半成品。

后续重构 UI 和交互时，应以本文作为现状基线，避免把配置、评测、审计、运行时生效规则混在同一个模糊入口里。

## 一句话定位

Agent Harness 是一个单机自用的 agent 配置变更实验、评测和发布系统，不是普通设置页，也不是多人协作审批系统。用户自己配置、自己评测、自己人工审阅、自己决定发布或回滚；审计记录用于本机用户复盘和回滚，不用于多人权限分工。

它当前覆盖的闭环是：

```text
基线配置投影 -> 创建候选 Agent runtime 配置 -> 固定评测案例上下文 -> 选择评测运行配置/断言配置/审阅模板 -> 隔离 EvalRun -> 程序断言 -> 人工审阅 -> 发布 active Agent runtime 配置 -> 普通 run 读取 active 配置
```

其中“配置”包含四类内容：

- Agent 主体提示词：system agent 或 specialist agent 的 `instructionOverride`。
- 行为规则：当前有版本化 `BehaviorRuleConfig`，也兼容历史 `PromptBlock`；发布后通过 active resolved runtime config 进入普通 run。
- 工具描述：工具 description、参数说明和输出说明，由独立 `ToolDescriptionConfig` 管理；工具可用范围由 `AgentToolPolicy` 管理，不写在工具描述正文里。
- 运行策略引用：普通 run 会读取的 memory、retrieval、tool、model 等 policy 引用。

断言配置和人工审阅模板不属于 Agent 配置，也不属于普通 run 的 runtime 配置。它们只属于评测验证链路，可以命名、复用和绑定到具体 EvalRun 或 EvalSuite。评测运行配置也应理解为 EvalRun 的执行策略，不等同于发布后生效的 Agent runtime 配置。

当前交互设计已经明确：产物结构暂不作为可编辑发布配置。WorkspaceManifest 仍是现有运行和断言可引用的结构依据，但不在新 Harness 配置流程中开放“修改并发布产物结构”。原因是产物结构变更会牵涉历史上下文、评测案例和长期记忆重建，影响面超出当前版本。

## 当前代码入口

### 共享合同

- `packages/shared/src/contracts.ts`
- `packages/shared/src/toolDescriptions.ts`
- `packages/shared/src/index.ts`

共享合同定义 Harness 的主要数据对象：`AgentLayerConfig`、`AgentSpec`、`PromptBlock`、`ToolDescriptionConfig`、`RunInputSnapshot`、`EvalFixture`、`EvalRun`、`HumanReviewRubric`、`AgentSpecReleaseGate`、`AgentSpecReleaseRecord`、`HarnessSummary` 等。

`toolDescriptions.ts` 定义正式工具描述规格，供 UI 预填和运行时工具 description 默认值使用。

### API

- `apps/api/src/harness/harnessStore.ts`
- `apps/api/src/routes/harness.ts`
- `apps/api/src/routes/runs.ts`
- `apps/api/src/runs/langGraphRunService.ts`
- `apps/api/src/runs/langGraphAgents.ts`

`HarnessStore` 使用文件型状态，持久化在 `WORKSPACES_ROOT/../harness/harness.json`，并维护 snapshot、fixture、eval run 的工作区副本目录。

普通 run 创建时，`routes/runs.ts` 会先调用 Harness 创建 `RunInputSnapshot`，之后 run 事件会被记录成 `RunArtifact`。

LangGraph runtime 会在普通 run 和 EvalRun 中读取 active 或 resolved Harness 配置，并把工具描述、行为规则、agent instruction 和工具 policy 应用到实际 agent registry 与工具对象。普通 run 只读取当前 product 的 active config；EvalRun 可以读取候选 resolved config，因此临时评测和线上运行共享解析逻辑但生效边界不同。

### Web UI

- `apps/web/src/components/HarnessPanel.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/main.tsx`

当前 Harness UI 是一个独立工具页，可通过 `?tool=harness` 打开。页面已经按“历史配置流程入口列表 + 单次配置路线图”组织：

- 入口列表支持按状态、产品、agent、标签、更新时间、发布状态筛选，并按更新时间、创建时间、Gate 状态、评测完成度排序。
- 入口页是独立历史流程列表：列表、筛选和排序占据完整主宽度；每行提供查看、修改、发布检查、回滚、归档、删除等操作。点击查看或修改后进入具体配置流程页，由配置路线图统一展示流程内容，不在入口页额外展开详情，也不使用弹窗。
- 单次配置路线图依次为：评测案例上下文选择或生成、Agent 配置、评测运行配置与断言配置、运行和人工审阅。
- 每个节点都用一个选择框同时承载“复用历史配置”和“新建配置”。选择历史项直接加载；选择“新建...”只打开未保存表单。
- 新建节点配置必须有实际修改并通过合法性校验，点击保存或下一步后才真正创建。
- 评测案例上下文、Agent 配置、评测运行配置、断言配置和人工审阅模板支持命名、自动时间命名、复用和来源追踪；其中部分高级编辑能力仍保留为后续增强点。

## 名词解释对照表

下表先把文档里最容易混淆的术语对齐。后文如果再次出现这些名词，默认沿用这里的定义。

| 名词 | 含义 | 容易混淆的点 |
| --- | --- | --- |
| `PromptBlock` | 历史兼容的一条可版本化提示词/行为规则文本，用来约束 agent 应该怎么工作。 | 不是项目事实，不是会话历史，也不是工具 schema。 |
| `AgentLayerConfig` | 产品级运行配置层，管理 system/specialist 结构、全局行为规则、工具描述覆盖和策略引用。 | 不是单个 agent 的私人草稿；发布后它的影响面是整个产品。 |
| `AgentSpec` | 一个可评测、可发布的 agent 候选版本。 | 不是全部配置的最终容器，只是发布单位和评测对象。 |
| `ToolDescriptionConfig` | 工具描述覆盖，包含工具主描述、参数说明和输出说明。 | 不是工具实现代码，也不是 PromptBlock。 |
| `AgentToolPolicy` | 独立的工具使用策略，定义允许、禁用、高风险工具以及关联的工具描述引用。 | 不应该把 agent 与 tool 的绑定关系写进工具描述或 agent prompt。 |
| `WorkspaceManifest` | 产品级正式产物结构约束，定义路径、目录和 section 要求。 | 当前只作为既有结构依据供运行和断言引用，不作为本期可编辑发布配置。 |
| `MemoryPolicy` | 长期记忆的写入、召回和冲突处理规则。 | 不是记忆正文本身。 |
| `MemoryRecord` | 一条实际的长期记忆记录。 | 不是写入规则。 |
| `KnowledgeBaseEntry` | 一条可检索的知识卡索引。 | 不是行为规则，也不是 memory。 |
| `RetrievalPolicy` | 约束知识卡检索和写入流程的规则。 | 不是知识卡内容。 |
| `RunInputSnapshot` | 普通 run 前对工作区和输入的快照。 | 不是评测案例本身。 |
| `RunArtifact` | 一次普通 run 的运行证据和执行日志。 | 不是候选配置，也不是 fixture。 |
| `EvalFixture` | 固定评测案例上下文，包含对话起点、对话前上下文、快照和固定的 memory/knowledge。 | 不是一次执行结果，也不包含断言。 |
| `EvalRun` | 对某个 fixture 和某个 AgentSpec 的一次评测执行。 | 不是发布结果。 |
| `HumanReview` | 人工对 EvalRun 的评分、备注和发布判断。 | 不是程序断言。 |
| `HumanReviewRubric` | 人工审阅模板，定义打分项、权重、决策选项和备注提示。 | 不是单次评分本身，可被多个流程复用。 |
| `AgentSpecReleaseGate` | 发布前检查结果，决定能否把某个 spec 设为 active。 | 不是审阅正文。 |
| `AgentSpecReleaseRecord` | 发布或回滚的审计记录。 | 不是配置内容。 |
| `draft` | 仅供编辑的草稿状态。 | 不会影响普通 run。 |
| `candidate` | 可评测但未发布的候选状态。 | 还不会影响普通 run。 |
| `active` | 当前生效版本。 | 普通 run 和 runtime 会读取它。 |
| `archived` | 已归档历史版本。 | 保留审计，不参与默认运行。 |

补充一句：这份文档里说的“行为规则”，默认指 `BehaviorRuleConfig`，历史段落中的 `PromptBlock` 是兼容来源。说的“工具描述”，默认指 `ToolDescriptionConfig`，历史 LayerConfig 内联 `toolDescriptionOverrides` 已标记为兼容字段。说的“工具策略”，默认指 `AgentToolPolicy`。说的“候选配置”，默认指 `AgentSpec` 和它绑定的 LayerConfig 组合。

## 核心数据对象边界

### AgentLayerConfig

`AgentLayerConfig` 是当前产品级 agent 分层配置。它回答：这个产品当前运行时可用哪些 agent、system agent 如何调度、specialist agent 如何启用、全局行为规则和工具描述如何覆盖。

当前字段边界：

- `productId`：所属产品。  (也有可能跨产品，这样需要如何管理？)
- `status`：draft、candidate、active、archived。
- `promptBlockRefs` / `behaviorRuleRefs`：全局行为规则引用。当前重构方向是让行为规则通过独立配置对象统一管理，发布后对同产品普通 run 生效。
- `toolPolicyRefs`：工具使用策略引用，控制允许、禁用、高风险工具，并可引用工具描述。
- `toolDescriptionRefs`：工具描述引用，覆盖工具 description、参数说明和输出说明。
- `toolDescriptionOverrides`：历史兼容字段，新实现优先使用独立 `ToolDescriptionConfig`。
- `systemAgent`：system agent 的 agentId、promptBlockRefs、allowedTools、instructionOverride。
- `specialists`：specialist agent 列表、skillRef、promptBlockRefs、defaultEnabled、allowedTools、instructionOverride。
- `memoryPolicyRef`、`retrievalPolicyRef`、`toolPolicyRef`、`modelPolicyRef`：运行策略引用。

边界判断：

- 应放入 AgentLayerConfig：影响整个产品 agent runtime 的规则引用、工具描述引用、工具 policy 引用、agent 启用关系、策略引用。
- 不应放入 AgentLayerConfig：项目事实、一次对话上下文、具体评测输入、某次 run 的临时状态。

当前注意点：历史实现里行为规则和工具描述曾经偏向挂在某个 agent 下。最新目标是工具描述、行为规则和工具 policy 都按独立配置对象管理，再由 active LayerConfig/AgentSpec 引用。某个 agent 页面发起修改只是生成候选配置的入口，不代表只对该 agent 生效；如果确实需要 agent 级覆盖，必须显式设置 `scope=agent` 和 `agentId`。

### AgentSpec

`AgentSpec` 是可评测、可发布的 agent 候选版本。它回答：我现在要评测或发布哪一个 agent 的哪一个版本。

当前字段边界：

- `productId`、`agentId`：候选针对哪个产品和哪个观察/发布 agent。
- `status`：draft、candidate、active、archived。
- `layerConfigRef`：该候选绑定的 LayerConfig。
- `promptBlockRefs`：历史/兼容字段，当前仍参与 resolved config，但后续应收敛到 LayerConfig 的全局规则管理。
- `skillRefs`、`memoryPolicyRef`、`retrievalPolicyRef`、`toolPolicyRef`、`modelPolicyRef`：候选直接绑定或覆盖的运行引用。
- `activatedAt`、`changelog`：发布和审计辅助信息。

边界判断：

- AgentSpec 是发布单位和评测对象。
- AgentSpec 不应成为所有配置内容的编辑容器。它应该引用 LayerConfig、PromptBlock、policy、manifest 等对象。
- 发布某个 AgentSpec 后，同 product/agent 的旧 active 会归档。当前实现也会把同产品其它 active AgentSpec 的 `layerConfigRef` 同步到新发布的 LayerConfig，以保证全局工具描述和行为规则发布后其它 agent 也读取同一套配置。

### PromptBlock

`PromptBlock` 是行为规则文本。UI 中称为“行为规则”。它回答：agent 应该遵守哪条可版本化的工作规则。

当前字段边界：

- `productId`：所属产品。
- `title`：规则标题。
- `scope`：system、specialist、reviewer、tool、quality、other。
- `content`：规则正文。
- `contentHash`：内容 hash，用于 resolved config 审计。
- `status`：draft、candidate、active、archived。

应放入 PromptBlock：

- 输出格式要求。
- 质量门槛。
- 写文件边界。
- 工具使用原则。
- review gate 规则。

不应放入 PromptBlock：

- 当前项目角色设定。
- 某次对话里用户刚确认或否定的信息。
- 评测 fixture 的输入消息。
- 工具的正式 schema 描述。工具描述应放入 `ToolDescriptionConfig`。

### ToolDescriptionConfig

`ToolDescriptionConfig` 是工具说明覆盖。它回答：模型在看到某个工具时，应该读到怎样的工具描述、参数说明和输出说明。

当前字段边界：

- `toolId`：工具 ID。
- `description`：工具主描述。
- `parameterDescriptions`：参数级说明。
- `outputDescription`：返回结果说明。

正式工具规格来自 `DEFAULT_TOOL_DESCRIPTION_SPECS`。当前已包含工作区文件、bash、Git 同步、浏览器操作、记忆、知识库、图片生成/编辑、微信发送、定时任务、specialist 委派等工具。

运行时生效方式：

- UI 选择工具时，应从正式规格或 active LayerConfig 覆盖中加载完整描述。
- 保存工具描述会创建候选 LayerConfig。
- EvalRun 使用候选 LayerConfig 中的覆盖。
- 普通 run 使用 active LayerConfig 中的覆盖。
- 工具描述覆盖是产品级全局配置，不是某个 specialist 的局部配置。

### MemoryPolicy 与 MemoryRecord

`MemoryPolicy` 定义长期记忆的命名空间、写入权限、召回顺序、冲突策略和 tombstone 要求。（这里具体策略有哪些，如何解决记忆正确回放，评测时不会出现记忆创越未来等问题等等需要详细说明）

`MemoryRecord` 是实际记忆证据，用于 run artifact 和 fixture 固定。

边界判断：

- MemoryPolicy 管记忆系统规则。
- MemoryRecord 管事实性记忆或长期偏好。
- PromptBlock 不应承载项目事实。
- EvalFixture 可以固定 memoryFixture，避免 Repro 评测受当前 live memory 影响。

### KnowledgeBaseEntry 与 RetrievalPolicy

`KnowledgeBaseEntry` 记录可检索知识卡索引。`RetrievalPolicy` 约束知识库检索类型、topK、rightsRisk 上限、写入流程和禁止使用方式。

边界判断：

- 知识库是可复用材料来源，不是 agent 行为规则。
- Repro EvalRun 可使用 fixture 固定的 knowledgeFixture。
- Live EvalRun 可读取当前 live 知识库。

### WorkspaceManifest

`WorkspaceManifest` 管产品级正式产物结构。它回答：某类正式产物应该写到哪个 canonical path、必须有哪些 section、需要哪些目录。

边界判断：

- WorkspaceManifest 只判断结构和路径合规。
- 它不判断故事质量、喜剧机制、人物一致性。
- 质量判断属于 PromptBlock、HumanReviewRubric 和人工审阅。
- 当前新交互不开放 WorkspaceManifest 编辑和发布。断言配置可以引用既有 WorkspaceManifest 做路径和 section 检查，但用户不能在本期流程中修改产物结构并发布。
- 后续若开放 WorkspaceManifest 配置，必须同步设计历史评测上下文、RunArtifact、memory/knowledge fixture 和长期记忆的重建或迁移策略。

### RunInputSnapshot 与 RunArtifact

`RunInputSnapshot` 是普通 run 前的工作区快照。它用于后续复现。

当前 snapshot 策略：

- 复制项目工作区轻量快照。
- 排除 `.git`、`node_modules`、`dist`、构建缓存、日志等。
- 记录 prompt、引用文件、引用聊天片段、git dirty 状态等 metadata。

`RunArtifact` 是普通 run 后的运行证据，包含 stream events、fileDiff、changedFiles、memoryWrites、memoryTombstones、knowledgeRetrievals、toolIoSummaries、toolEvents、resolvedAgentConfig 等。

边界判断：

- Snapshot 是复现输入。
- Artifact 是失败分析和 fixture 生成依据。
- 二者都不是用户日常编辑配置的入口。

### EvalFixture

`EvalFixture` 在新交互里应理解为固定评测案例上下文。它回答：从哪条历史对话消息开始评测，以及对话开始前需要固定哪些上下文、工作区状态、memory/knowledge fixture。

当前来源：

- 从 RunInputSnapshot 创建。
- 从 RunArtifact 创建。
- 从历史会话消息辅助创建。（以上三者创建有什么区别，各能提供什么内容？）
- 手工编辑 fixture 内容。手动创建完整上下文是后续预留能力，第一版主路径仍应从历史对话或失败运行反查对话起点。

当前包含：

- workspaceSnapshotRoot。
- inputMessages。
- referencedSnippets。
- memoryFixture。
- knowledgeFixture。
- expectedChangedFiles。
- expectedToolEvents。
- toolRetentionPolicy。
- sensitiveFieldRules。
- toolRetentionArtifacts。
- toolMocks。
- tags。

边界判断：

- EvalFixture 是评测上下文输入，不是运行配置。
- 新交互中 EvalFixture 不承载断言。断言收敛到独立的 AssertionConfig 节点，避免“案例断言”和“运行断言”两个概念重复。
- Fixture 应该可裁剪和固定，保证 active/candidate 比较公平。
- Fixture 中的 memory/knowledge 是评测用快照，不应写回真实 memory/knowledge。

### AssertionConfig

断言配置是评测运行时使用的程序检查规则集合。当前代码已经有独立 `AssertionConfig`，EvalRun 可通过 `assertionConfigId` 使用它；`EvalFixture.assertions` 仍保留为兼容 fallback。

边界判断：

- 断言配置可以被多个评测流程复用或派生。
- 断言配置包含文件变化、路径约束、Markdown section、工具调用顺序、diff 限制和现有 WorkspaceManifest 合规检查。
- 断言配置只影响 EvalRun 和 release gate，不影响普通 run。
- 新建断言配置只打开表单，不立即保存；必须至少有一条有效且可执行的断言，点击保存或下一步才创建。

### EvalRun

`EvalRun` 是一次评测执行结果。它回答：某个 AgentSpec 在某个 Fixture 下表现如何。

当前模式：

- Repro：默认模式。使用 fixture 固定的 memory/knowledge。
- Live：使用当前 live memory/knowledge。

当前执行方式：

- 默认 fixture replay executor 可回放 expectedChangedFiles 和 expectedToolEvents。
- 正式 app 接入 LangGraph isolated executor。
- isolated executor 会复制 fixture workspace 到独立 eval run 目录，不污染真实项目。
- workspace tools 指向隔离目录。
- memory write 默认 mock 并记录。
- resolved AgentLayerConfig 会进入 agent registry，影响 system/specialist instructions、specialist 启用列表和工具描述。

当前结果：

- status。
- outputMessage / errorMessage。
- toolEvents。
- fileDiff。
- changedFiles。
- assertionResults。
- humanReview。
- resolvedAgentConfig。

### HumanReview 与 Rubric

`HumanReviewRubric` 在新交互里应理解为人工审阅模板。它定义打分项、权重、决策选项和备注提示。`HumanReview` 是用户本人对 EvalRun 的人工判断。

边界判断：

- 程序断言验证结构、路径、工具调用和边界。
- HumanReview 以打分表形式判断创作质量和退化风险，作为发布参考证据。
- 发布 gate 当前依赖 passed EvalRun；HumanReview 不阻塞流程。
- 人工审阅模板可以被多个流程复用或派生。
- 新建审阅模板只打开表单，不立即保存；必须至少有一个打分项、权重合法、决策选项完整，点击保存或下一步才创建。

## 当前端到端流程

### 1. Baseline 初始化

读取 Harness summary 时，HarnessStore 会按 `PRODUCT_PROFILES` 自动投影 baseline：

- 为缺失 active 的 product/agent 创建 seed AgentSpec。
- 为产品创建 seed LayerConfig。
- 为产品补 memory policy、retrieval policy、workspace manifest、prompt blocks。
- seed system prompt 来自 product profile 的 `system-agent.md`。
- seed specialist prompt 来自对应 product profile prompt。

边界：baseline 是现有运行配置的可比较投影，不是人工评测发布记录。

### 2. 配置候选

当前 UI 在配置页支持：

- 选择产品和观察 agent。
- 查看或编辑 agent 主体提示词。
- 选择工具并基于正式工具规格编辑工具描述、参数说明、输出说明。
- 查看或修改行为规则。
- 新建行为规则。
- 创建候选 AgentSpec。
- 查看 active/candidate 预览和差异。

当前行为边界：

- 编辑 agent 主体提示词会创建 candidate LayerConfig，并创建 draft AgentSpec 绑定它。
- 编辑工具描述会创建 candidate LayerConfig，并创建 draft AgentSpec 绑定它。
- 选择或新建行为规则应创建 candidate LayerConfig，并创建 draft AgentSpec 绑定它。
- 以上创建候选不会影响真实普通 run。
- 只有发布 active 后，普通 run 才读取该配置。

### 3. 沉淀案例

当前 UI 支持：

- 从历史会话选择用户消息。
- 从 snapshot 或 run artifact 创建 EvalFixture。
- 编辑 fixture input messages 和上下文内容。
- 查看 tool retention、敏感字段裁剪等信息。

当前边界：Fixture 在新交互中只固定评测案例上下文，不修改候选配置，也不承载断言配置。`EvalFixture.assertions` 属于兼容 fallback；主流程使用独立 AssertionConfig。

### 4. 执行评测

当前 UI 支持选择：

- candidate AgentSpec。
- EvalFixture。
- 断言配置。
- 人工审阅模板。
- Repro 或 Live 模式。

创建 EvalRun 后，API 会：

- 复制 fixture workspace 到 eval run 隔离目录。
- 解析候选 AgentSpec 的 resolvedAgentConfig。
- 执行 LangGraph isolated executor 或 fixture replay。
- 收集工具事件、文件 diff、changed files、assertion results。
- 保存结果到 Harness state。

### 5. 人工审阅

当前 UI 支持：

- 选择 rubric。
- 填写 decision。
- 填写 scores、subScores、notes。
- 添加文件/行级 annotation。
- 批量给当前 AgentSpec 的未评分 EvalRun 写入 review。
- 查看当前 AgentSpec 的评分统计。

边界：HumanReview 不修改 agent 配置，只影响发布判断。Rubric 在新交互中应作为“人工审阅模板”管理，可复用、可新建派生，且新建模板必须校验打分项和权重后才保存。

新交互中，评测报告和人工打分必须作为步骤四里的两个平级主区域展示。评测报告负责展示运行证据、程序断言、active/candidate 对比、文件 diff 和工具调用；人工打分负责展示审阅模板、逐项评分、权重调整、决策和备注。人工打分项可能持续增加，不能被压缩到右侧窄侧栏或作为评测报告的附属小组件。

### 6. 发布运行

当前 UI 和 API 支持：

- 检查 release gate。
- 发布 selected AgentSpec 为 active。
- 强制发布并写 forceReason、auditCategory、notes。
- 回滚到指定 AgentSpec 或 release record。
- 查看 releaseRecords。

当前 release gate：

- 至少有一个 EvalRun。
- 至少有一个 passed EvalRun。
- HumanReview 评分作为参考证据保存，不阻塞发布。

发布后：

- 同 product/agent 旧 active 归档。
- 写入 release record。
- 如果新 spec 绑定了 LayerConfig，同产品其它 active AgentSpec 的 layerConfigRef 会同步到这个 LayerConfig，使全局行为规则和工具描述在其它 agent 上同步生效。

## 普通运行时生效边界

普通 run 当前会走以下路径：

1. `/api/runs` 创建 RunInputSnapshot。
2. LangGraph run 根据项目 productId 解析 product profile。
3. HarnessStore 提供当前 product 的 active resolvedAgentConfig。
4. active LayerConfig 的 instructionOverride、BehaviorRuleConfig/PromptBlock 行为规则、AgentToolPolicy 和 ToolDescriptionConfig 应用到运行时。
5. createWorkspaceTools 创建工具时应用工具允许/禁用控制和工具描述覆盖。
6. createAgentRegistry 创建 specialist agent 时应用 LayerConfig 的 specialist 启用列表和 instructionOverride。
7. system agent 使用 LayerConfig 的 system instructionOverride。
8. run events 被记录进 RunArtifact。

这意味着：

- 只创建 candidate 不影响普通 run。
- 发布 active 后才影响普通 run。
- 工具描述、行为规则和工具 policy 按 active resolved config 生效；agent 级覆盖必须显式设置 scope 和 agentId。
- 某个 agent 页面发起修改，只是创建候选和发布入口；发布后不是局部生效。

## 当前 API 边界

### Summary 和配置对象

- `GET /api/harness`：返回 HarnessSummary。
- `GET /api/harness/agent-layer-configs`：列出 LayerConfig。
- `POST /api/harness/agent-layer-configs`：创建 LayerConfig。
- `GET /api/harness/agent-specs`：列出 AgentSpec。
- `POST /api/harness/agent-specs`：创建 AgentSpec。
- `PATCH /api/harness/agent-specs/:agentSpecId/status`：更新 AgentSpec 状态，包含发布。
- `DELETE /api/harness/agent-specs/:agentSpecId`：删除未被引用的 AgentSpec。
- `POST /api/harness/agent-specs/:agentSpecId/rollback`：回滚。
- `GET /api/harness/agent-specs/:agentSpecId/release-gate`：检查发布 gate。
- `GET /api/harness/release-records`：查询发布记录。

### 策略与规则

- `GET /api/harness/memory-policies`
- `POST /api/harness/memory-policies`
- `GET /api/harness/knowledge-base-entries`
- `POST /api/harness/knowledge-base-entries`
- `GET /api/harness/retrieval-policies`
- `POST /api/harness/retrieval-policies`
- `GET /api/harness/prompt-blocks`
- `POST /api/harness/prompt-blocks`
- `POST /api/harness/prompt-blocks/:promptBlockId/versions`
- `GET /api/harness/prompt-blocks/:promptBlockId/diff`
- `PATCH /api/harness/prompt-blocks/:promptBlockId/status`
- `GET /api/harness/skill-snapshots`
- `POST /api/harness/skill-snapshots`
- `POST /api/harness/skill-snapshots/:skillSnapshotId/versions`
- `GET /api/harness/skill-snapshots/:skillSnapshotId/diff`
- `PATCH /api/harness/skill-snapshots/:skillSnapshotId/status`
- `GET /api/harness/workspace-manifests`
- `GET /api/harness/tool-description-configs`
- `POST /api/harness/tool-description-configs`
- `POST /api/harness/tool-description-configs/:toolDescriptionConfigId/versions`
- `GET /api/harness/tool-description-configs/:toolDescriptionConfigId/diff`

注意：WorkspaceManifest 当前只读展示。新交互暂不把 WorkspaceManifest 作为可编辑发布节点，API route 也不开放创建入口；断言配置可以引用现有 WorkspaceManifest 做结构合规检查。ToolDescription 现在有独立版本化 API，普通 run 和 EvalRun 会通过 active/candidate resolved config 中的 `toolDescriptionRefs`、`AgentToolPolicy.toolDescriptionRefs` 和兼容 `toolDescriptionOverrides` 生效。

### Snapshot、Artifact、Fixture、EvalRun

- `GET /api/harness/snapshots`
- `GET /api/harness/run-artifacts`
- `GET /api/harness/run-artifacts/:runId`
- `GET /api/harness/eval-fixtures`
- `POST /api/harness/eval-fixtures`
- `POST /api/harness/run-artifacts/:runId/eval-fixtures`
- `PATCH /api/harness/eval-fixtures/:fixtureId`
- `GET /api/harness/eval-runs`
- `POST /api/harness/eval-runs`
- `POST /api/harness/eval-runs/:evalRunId/human-review`
- `POST /api/harness/human-reviews/batch`
- `GET /api/harness/human-review-rubrics`
- `POST /api/harness/human-review-rubrics`
- `POST /api/harness/human-review-rubrics/:rubricId/versions`
- `GET /api/harness/assertion-configs`
- `POST /api/harness/assertion-configs`
- `POST /api/harness/assertion-configs/:assertionConfigId/versions`
- `GET /api/harness/eval-run-configs`
- `POST /api/harness/eval-run-configs`
- `POST /api/harness/eval-run-configs/:evalRunConfigId/versions`

## 当前 UI 功能边界

### 配置候选页

当前承担：

- 选择产品和观察 agent。
- 显示当前 active 和 selected candidate。
- 编辑 agent 主体提示词。
- 编辑全局工具描述。
- 修改或新建行为规则。
- 创建 draft AgentSpec。
- 删除未引用候选。
- 显示底层 LayerConfig、MemoryPolicy、RetrievalPolicy、PromptBlock、WorkspaceManifest 列表。

当前问题：

- “观察 agent”和“全局配置”概念仍混在一个页面里。
- 创建 AgentSpec、创建 LayerConfig、保存规则、保存工具描述都在同一屏，用户很难判断哪个动作会影响什么。
- active/candidate 的 assembled prompt diff 不够明确。
- ToolDescription 独立版本对象与 LayerConfig 内联覆盖的关系不清。
- WorkspaceManifest 列表属于底层现状展示，新交互不应放入主配置流程的可编辑发布节点。

### 沉淀案例页

当前承担：

- 从历史会话、snapshot、artifact 创建 fixture。
- 编辑 input messages 和上下文。
- 当前仍能管理断言列表，这是历史实现残留。
- 展示 tool retention 和敏感字段裁剪信息。

当前问题：

- Fixture 构建、断言编辑、工具事件裁剪的信息层级较杂。新交互应把断言迁移到独立断言配置节点。
- 自动建议和人工确认的状态不够清楚。

### 执行评测页

当前承担：

- 选择 candidate 和 fixture。
- 选择 Repro/Live。
- 创建 EvalRun。
- 查看 EvalRun details。
- 查看 active/candidate 对比骨架。

当前问题：

- EvalRun 创建和结果阅读分散。
- active/candidate 对比还不够像一个评测报告。

### 人工审阅页

当前承担：

- 按 rubric 评分。
- 写 decision、scores、notes、annotations。
- 批量评分。
- 查看评分历史和统计。

当前问题：

- Review 和 diff 阅读之间的联动还弱。
- annotation 需要更自然地挂到具体文件 diff 行。

### 发布运行页

当前承担：

- release gate 检查。
- 正常发布。
- 强制发布。
- 回滚。
- release record 查看和筛选。

当前问题：

- “发布某个 agent spec”与“同步全局 LayerConfig 到其它 active spec”的影响范围需要更显式。
- force 发布的风险提示还可以更结构化。

## 明确不属于 Harness 的职责

Harness 不应该承担以下职责：

- 直接编辑项目正式文件。
- 作为普通创作工作台替代品。
- 作为多人协作、审批流或权限管理系统。
- 管理所有项目事实和角色设定。
- 作为知识库内容编辑器。
- 作为长期记忆正文编辑器。
- 在未发布时影响普通 run。
- 用程序断言替代人工质量判断。
- 让每个 agent 持有互相冲突的工具描述版本。
- 在评测案例上下文中混入断言配置或人工审阅模板。
- 在当前版本中修改并发布产物结构配置。

## 当前实现中的边界债务

### 1. AgentSpec 与 LayerConfig 的职责重叠

`AgentSpec.promptBlockRefs` 仍存在并参与 resolved config；但用户期望行为规则按 LayerConfig 全局生效。后续应明确：

- AgentSpec 是发布/评测对象。
- LayerConfig 是全局运行配置容器。
- PromptBlock 通过 LayerConfig 进入 runtime。
- AgentSpec 上的 promptBlockRefs 要么作为兼容迁移字段保留，要么从新 UI 中隐藏。

### 2. ToolDescription 有两套模型痕迹

当前既有：

- LayerConfig 内联 `toolDescriptionOverrides`。
- HarnessState 顶层 `toolDescriptionOverrides` 和创建版本方法。

但当前主要生效路径是 LayerConfig 内联覆盖。重构前需要决定是否把工具描述提升为独立版本化对象：

- 独立对象优点：可单独 diff、单独状态机、多个 LayerConfig 引用同一版本。
- 内联 LayerConfig 优点：简单，发布时配置整体一致。

在未决定前，UI 不应同时暴露两套概念。

### 3. 普通 run 与 EvalRun resolved config 需要统一审计

EvalRun 已保存 resolvedAgentConfig。普通 RunArtifact 也记录 resolvedAgentConfig，但当前展示和审计还不够完整。

后续需要保证每次普通 run 都能回答：

- 用了哪个 active AgentSpec。
- 用了哪个 LayerConfig。
- 生效了哪些 PromptBlock。
- 生效了哪些 ToolDescription override。
- 使用了哪个 model/memory/retrieval/workspace manifest。

### 4. UI 的五步流程过于线性

真实使用中可能有不同任务：

- 只想改工具描述。
- 只想补一个回归 fixture。
- 只想查看某个 release record。
- 只想对比 active/candidate。
- 只想跑一次 EvalRun。

当前五步 tab 强迫所有任务共享一个路径，后续重构需要按用户任务拆工作台区域。

### 5. “当前 agent”选择容易误导

当前配置页需要选择 agent，但工具描述和行为规则现在希望全局生效。后续 UI 应避免暗示“我只改了这个 agent 的工具描述”。

可考虑把选择拆成：

- 产品级配置：工具描述、全局行为规则、workspace manifest、policy。
- Agent 级配置：system/specialist prompt、agent 启用、skillRef。
- 发布目标：本次候选用哪个 agent 作为评测和发布对象。

## 后续重构前需要先确定的问题

1. ToolDescription 是否成为独立版本化对象，还是继续内联在 LayerConfig。  （确认要独立，且能够支持跨产品同步）
2. PromptBlock 是否彻底从 AgentSpec 迁移到 LayerConfig。 （确认要独立，且能够支持跨产品同步）
3. 发布 LayerConfig 时是否总是同步同产品所有 active AgentSpec，还是引入显式“全局配置发布”对象。 （前者即可）
4. AgentSpec 是否仍然以单个 agent 为发布单位，还是拆成 ProductRuntimeConfig 发布单位加 AgentPrompt 版本。
5. 普通 run 需要展示多少 resolved config 给用户，多少只留在审计详情。
6. Fixture 构建是保留在 Harness 主流程中，还是拆成独立“案例库”。
7. Release gate 是否继续绑定 AgentSpec，还是改成绑定一个完整 candidate bundle。

## 重新设计建议：以 RuntimeConfig 统一内外边界

当前 `AgentSpec + AgentLayerConfig + PromptBlock + ToolDescriptionConfig` 是一种组合依赖模型：AgentSpec 引用 LayerConfig，LayerConfig 又引用或内联规则和工具描述；同时 AgentSpec 自己也残留 promptBlockRefs。这导致两个问题：

- 用户无法判断“我正在改的是单个 agent，还是整个产品运行配置”。
- 开发上存在包含关系和引用关系混用，边界不稳定，发布影响范围不容易解释。

更清晰的方向不是只在 UI 上隐藏名词，而是把内部主模型也收敛成一个清楚的发布单元：`RuntimeConfig` 或 `AgentRuntimeConfig`。用户看到和发布的是这个对象；后端评测、发布、回滚、普通 run resolved config 也以它为主外键。

`PromptBlock`、`ToolDescriptionConfig`、`AgentPrompt` 可以继续作为配置片段存在，但它们不应该再和 `AgentSpec`、`LayerConfig` 形成交叉引用。内部应该只有一种主关系：RuntimeConfig 拥有或引用这些配置片段，并声明生效范围。

### 设计原则

1. 用户只发布一个东西：某个产品的运行配置版本。
2. 运行配置明确声明生效范围：全产品、指定 agent、指定工具、指定策略。
3. 内部也要避免组合依赖混乱：评测、发布、回滚都绑定 RuntimeConfigVersion。
4. 评测对象应是完整 candidate runtime config，而不是单个 AgentSpec。
5. 单 agent 修改只是运行配置里的一个 patch，不应该改变发布模型。

这个设计不是简单把所有对象“塞进 LayerConfig”。更准确地说，是用一个配置包统一承载发布边界，并且在内部明确哪些内容是内联快照、哪些内容是可复用定义，不能两套关系同时存在。

### 推荐外部概念

建议面向用户只保留这些一级概念：

| 用户概念 | 解释 | 内部可能对应 |
| --- | --- | --- |
| 运行配置 | 当前产品的完整 agent runtime 配置包。 | RuntimeConfig / 当前 AgentLayerConfig 演进版 |
| Agent 提示词 | 某个 agent 的主体职责、流程和边界。 | AgentPrompt / specialist instructionOverride |
| 行为规则 | 可复用的工作规则，例如输出质量、写文件边界。 | PromptBlock |
| 工具说明 | 工具 description、参数说明、输出说明。 | ToolDescriptionConfig |
| 评测案例上下文 | 对话起点和对话开始前的固定上下文。 | EvalFixture / RunInputSnapshot 派生对象 |
| 断言配置 | 可复用的程序检查规则集合。 | AssertionConfig / 当前 EvalFixture.assertions 的迁移方向 |
| 人工审阅模板 | 可复用的打分项、权重、决策选项和备注提示。 | HumanReviewRubric |
| 评测结果 | 某个候选运行配置在某个案例集上的结果。 | EvalRun |
| 发布记录 | 某次运行配置发布或回滚的审计。 | ReleaseRecord |

用户不需要直接理解 AgentSpec。AgentSpec 这个名字可以保留为内部兼容对象，或者迁移成 RuntimeConfig 里的 agent patch/version metadata。

### RuntimeConfig 建议结构

概念上，一个运行配置应包含：

```ts
type RuntimeConfig = {
  id: string;
  productId: string;
  version: number;
  status: 'draft' | 'candidate' | 'active' | 'archived';

  agents: Record<string, {
    enabled: boolean;
    promptRef?: string;
    promptOverride?: string;
    skillRef?: string;
    allowedTools?: string[];
  }>;

  behaviorRuleRefs: string[];
  toolDescriptionRefs: string[];

  memoryPolicyRef?: string;
  retrievalPolicyRef?: string;
  toolPolicyRef?: string;
  modelPolicyRef?: string;
  // 当前新交互暂不开放 manifest 编辑和发布；此字段只代表现状或未来扩展。
  workspaceManifestRef?: string;

  changeSet: Array<{
    appliesTo: 'global' | 'agent';
    agentId?: string;
    area: 'agent_prompt' | 'behavior_rule' | 'tool_description' | 'policy';
    targetId?: string;
    summary: string;
  }>;
};
```

这里的关键不是字段名，而是边界：RuntimeConfig 是候选、评测和发布单位；PromptBlock 和 ToolDescriptionConfig 是它引用的可版本化材料。

这里需要特别区分两个维度：

- `appliesTo` 表示生效范围，是全局生效还是只对某个 agent 生效。
- `area` 表示改动类型，是改了提示词、行为规则、工具说明还是策略。manifest/产物结构当前不进入新配置流程。

不建议把 `tool`、`policy` 和 `global`、`agent` 放在同一个 `scope` 枚举里。前者是改动对象类型，后者是生效范围。混在一起会导致语义不清，例如“tool scope”到底是工具级生效，还是改了工具描述。

更合理的表达：

```text
appliesTo=global, area=tool_description, targetId=browser_evaluate
含义：修改 browser_evaluate 工具说明，对全产品所有 agent 生效。

appliesTo=agent, agentId=story-agent, area=tool_description, targetId=write_workspace_file
含义：修改 story-agent 看到的 write_workspace_file 工具说明。

appliesTo=global, area=policy, targetId=memory-policy
含义：修改全产品默认 memory policy。

appliesTo=agent, agentId=reviewer-agent, area=policy, targetId=model-policy
含义：修改 reviewer-agent 的模型策略覆盖。
```

是否支持 agent 级 tool/policy，需要产品设计明确。当前用户期望工具描述和行为规则全局管理，因此第一版可以只支持 `appliesTo=global` 的 tool_description 和 behavior_rule，agent 级覆盖作为未来能力预留。manifest/产物结构暂不开放编辑和发布。

#### 生效范围只保留 system、product 和 agent

上面的 `global` 只是简写。结合当前产品形态，Harness 配置层不应支持 project 级覆盖。项目级个性化应该通过项目文件系统、项目资料、项目 memory 或工作区约定来表达，而不是再引入一层 Harness 配置覆盖。

Harness 配置只保留三层生效范围：

| 范围 | 含义 | 典型例子 |
| --- | --- | --- |
| `system` | 真正全局，跨产品、跨项目共享。 | 通用浏览器工具说明、通用 Git 同步工具说明、安全底线。 |
| `product` | 产品级全局，对某个产品下所有项目生效。 | 情景剧产品的 story/reviewer 行为规则、产品默认工具说明。 |
| `agent` | agent 级覆盖，只对某个 agent 生效。 | reviewer-agent 的审稿 rubric prompt、story-agent 的故事结构提示词。 |

因此更准确的字段可以是：

```ts
type EffectiveScope =
  | { level: 'system' }
  | { level: 'product'; productId: string }
  | { level: 'agent'; productId: string; agentId: string };
```

推荐优先级：

1. 先实现 `product` 级 RuntimeConfig，解决当前 Harness 混乱。
2. `system` 级素材库用于跨产品复用工具说明和通用规则。
3. `agent` 级配置只用于 agent prompt 或明确声明的局部覆盖，不默认开放所有 area。

项目级差异的推荐承载位置：

- 项目正式文件：角色设定、故事约束、世界观、剧集规划。
- 项目 memory：用户偏好、已确认事实、历史决定。
- 项目工作区模板：项目内目录和文件约定。
- 用户本次 prompt：一次性局部要求。

这些都不应进入 Harness RuntimeConfig，否则 Harness 会从“产品级 agent runtime 管理”膨胀成“每个项目的隐藏配置系统”。

#### 所有相关配置都要统一 scope 模型

是的，相关配置的 scope 需要对齐，否则系统会再次出现“有的对象按 product 生效，有的按 agent 生效，有的叫 global 但实际是 product”的理解偏差。

建议所有可被 RuntimeConfig 引用的配置片段都使用同一套 `EffectiveScope`：

| 配置片段 | 允许 scope | 说明 |
| --- | --- | --- |
| AgentPrompt | `agent` | agent 主体提示词天然属于某个 agent；system agent 可用 `agentId=system` 表示。 |
| BehaviorRule | `system`、`product`、`agent` | 通用安全规则可 system；产品写作规则可 product；个别 agent 专用规则可 agent。 |
| ToolDescription | `system`、`product`、`agent` | 默认建议 system 或 product；agent 级只在确有必要时开放。 |
| MemoryPolicy | `system`、`product`、`agent` | 默认 product；特殊 agent 的记忆写入策略可 agent。 |
| RetrievalPolicy | `system`、`product`、`agent` | 默认 product；知识搜索类 agent 可有 agent 级策略。 |
| ModelPolicy | `system`、`product`、`agent` | 默认 product；高成本/特殊能力 agent 可 agent 级模型策略。 |
| ToolPolicy | `system`、`product`、`agent` | 默认 product；个别 agent 的 allowed tools 可 agent。 |
| WorkspaceManifest | 暂不开放编辑 | 当前只作为现有结构依据供运行和断言引用。 |
| HumanReviewRubric | `product`、`agent` | 产品通用评分可 product；reviewer 或 story-agent 专用评分可 agent。 |
| EvalSuite | `product`、`agent` | 产品级 smoke suite 或 agent 专项 regression suite。 |

统一 scope 后，RuntimeConfig 的 resolved 逻辑也更清楚：

```text
system 默认素材 -> product 配置选择/覆盖 -> agent 配置选择/覆盖
```

不引入 project 级 Harness 覆盖。项目个性化从文件系统和 memory 进入 agent 上下文。

scope 统一不代表所有对象都必须支持所有 scope。每类对象应有允许范围，超出范围直接不建模。WorkspaceManifest 当前不进入新编辑流程，避免产物结构变更牵连历史上下文和记忆重建。

#### area 不建议在单条 change 里多选

`area` 从业务上可以多选，因为一次用户操作可能同时修改了工具说明和行为规则。但在数据模型里，不建议让单条 change item 的 `area` 是数组。

原因：

- 单条 change 如果有多个 area，就很难做精确 diff、评测覆盖和回滚。
- 发布 gate 需要按影响类型判断评测要求；多 area 会让规则复杂化。
- 回滚时用户通常想回滚某一类改动，例如只回滚工具说明，不一定回滚行为规则。

更好的做法是：

```ts
type ChangeSet = {
  id: string;
  title: string;
  changes: Array<{
    effectiveScope: EffectiveScope;
    area: 'agent_prompt' | 'behavior_rule' | 'tool_description' | 'policy';
    targetId?: string;
    fromRef?: string;
    toRef?: string;
    summary: string;
  }>;
};
```

这样一次操作可以形成一个 changeSet，changeSet 里有多条原子 change。UI 上可以显示为“一次改动包含 3 项”，但底层每项都只有一个 area。

举例：

```text
ChangeSet: 优化浏览器检索和故事输出规则
- product/sitcom + tool_description + browser_snapshot: v2 -> v3
- product/sitcom + tool_description + browser_evaluate: v1 -> v2
- agent/story-agent + behavior_rule + story-quality-gate: v4 -> v5
```

UI 过滤时可以多选 area，例如同时筛选 tool_description 和 behavior_rule；但那是查询条件多选，不是数据里的单条 change 多选。

### RuntimeConfig 不应包含评测配置

RuntimeConfig 只回答一个问题：普通 run 在运行时应该使用哪套 agent、提示词、行为规则、工具说明和策略。

它不应该包含评测配置。评测配置应该独立存在，避免把“运行时怎么工作”和“怎么验证它工作得好不好”绑死。

建议边界：

| 对象 | 是否属于 RuntimeConfig | 原因 |
| --- | --- | --- |
| agent prompt | 是 | 直接影响普通 run 行为。 |
| behavior rules | 是 | 直接影响普通 run 行为。 |
| tool descriptions | 是 | 直接影响模型如何理解工具。 |
| memory/retrieval/model/tool policy | 是 | 直接影响 runtime 策略。 |
| workspace manifest | 暂不开放编辑 | 它会影响正式产物路径和结构约束，但当前不作为新流程可编辑发布项。 |
| EvalFixture | 否 | 它是评测案例上下文输入，不是运行配置。 |
| assertions | 否 | 它是评测判定规则，不应随普通 run 生效。 |
| tool retention policy | 否 | 它是 fixture/artifact 裁剪策略。 |
| HumanReviewRubric | 否 | 它是人工审阅模板，不是 agent 指令。 |
| ReleaseGate policy | 可独立 | 它约束发布流程，不直接影响普通 run。 |

因此更完整的关系应该是：

```text
RuntimeConfigCandidate + EvalSuite/EvalFixtureSet -> EvalRun -> Review -> ReleaseDecision
```

其中 `EvalSuite` 可以是未来新增对象，用来表示“这套运行配置需要用哪些 fixture、哪些断言、哪些人工 rubric 来验证”。它可以引用 RuntimeConfig，但不应被 RuntimeConfig 包含。

### 内部模型应避免两层主对象

当前最大的混乱来自两个看似主对象的东西同时存在：

- `AgentSpec` 像发布对象。
- `AgentLayerConfig` 像运行配置对象。

但真实系统运行时需要的是一份完整配置。后续内部应收敛为：

```text
RuntimeConfigVersion
  - agents[]
  - behaviorRules[]
  - toolDescriptions[]
  - policies
  - changeSet
  - status
```

其中 `AgentSpec` 不再作为核心对象。它可以在迁移期作为兼容层存在，但不应继续参与新功能设计。

更明确的内部边界：

| 对象 | 是否主对象 | 建议职责 |
| --- | --- | --- |
| RuntimeConfigVersion | 是 | 候选、评测、发布、回滚、普通 run 生效的唯一配置版本。 |
| AgentPrompt | 否 | 某个 agent 的主体提示词版本，可内联或引用到 RuntimeConfig。 |
| BehaviorRule | 否 | 行为规则版本，即当前 PromptBlock 的重命名方向。 |
| ToolDescription | 否 | 工具说明版本。 |
| Policy / Manifest | 否 | 运行策略和工作区结构约束。 |
| EvalFixture | 独立主对象 | 评测案例库，不属于 RuntimeConfig。 |
| EvalRun | 独立主对象 | RuntimeConfigVersion + Fixture 的执行结果。 |
| ReleaseRecord | 独立主对象 | RuntimeConfigVersion 的发布/回滚审计。 |

这样内部只有一个配置发布主对象，另外几个对象要么是配置片段，要么是评测/审计对象。

### 内联还是引用：需要按实际场景拆开看

不能笼统地说“全部内联一定损失复用、diff、回滚、跨产品同步”。实际取舍取决于配置片段是否需要独立生命周期。

这里说的“素材库”，指的是可被多个 RuntimeConfig 引用的版本化配置片段集合，例如：

- `AgentPromptLibrary`：system-agent、story-agent、reviewer-agent 等主体提示词版本。
- `BehaviorRuleLibrary`：行为规则版本，也就是当前 `PromptBlock` 的更清晰命名方向。
- `ToolDescriptionLibrary`：工具说明版本，例如 `browser_evaluate@4`、`send_wechat_message@2`。
- `PolicyLibrary`：memory、retrieval、model、tool policy。
- `ManifestLibrary`：workspace manifest 版本，当前仅代表现状或未来扩展，新交互暂不开放编辑发布。

“引用素材库”意味着 RuntimeConfig 只保存 `ref`，例如 `browser_evaluate@4`；真正内容存在素材库里。“内联”意味着 RuntimeConfig 直接保存该片段内容，发布时不需要再查另一个对象。

#### 适合内联到 RuntimeConfig 的内容

以下内容可以直接内联，因为它们通常只服务于这一个配置版本：

- agent 是否启用。
- agent allowedTools。
- 某次候选的 changeSet。
- policy ref 选择结果。
- 临时的实验性 prompt override。

内联的好处：

- resolved config 更容易解释。
- 发布和回滚简单，就是切换整份 RuntimeConfigVersion。
- 没有悬空引用、版本解析、素材状态不同步的问题。

内联不一定损失 diff：可以直接对两份 RuntimeConfigVersion 做结构化 diff。对于小规模系统，这反而更可靠。

#### 适合独立版本化再被 RuntimeConfig 引用的内容

以下内容更适合独立对象：

- 多个 RuntimeConfig 会复用的行为规则。
- 多个产品会共享的工具说明。
- 需要单独评审、单独发布记录、单独跨产品同步的工具描述。
- 体积较大且希望单独 diff 的 agent prompt。

独立对象的好处只有在这些场景真实存在时才成立。如果一条规则永远只被一个 RuntimeConfig 用，独立对象只是增加复杂度。

#### 复用能力是否会损失

不会必然损失。

- 如果全部内联，仍然可以通过“复制片段到新配置”实现人工复用，但不会保留共享身份。
- 如果需要追踪“多个产品都使用同一个 browser_evaluate 描述 v4”，就需要独立 ToolDescription 对象。
- 如果只是想让用户少写几遍，模板复制已经够用，不必引入共享引用。

因此复用分两种：

- 内容复用：复制即可，简单。
- 身份复用：需要独立对象和引用，复杂但可追踪。

只有明确需要身份复用时，才值得把片段独立出来。

#### diff 能力是否会损失

也不会必然损失。

- 内联模型可以做 RuntimeConfig 整包结构化 diff，能直接回答“这次发布实际改变了什么”。
- 引用模型可以做片段级 diff，能回答“ToolDescription v3 到 v4 改了什么”。

更合理的是两层 diff：

- 发布 diff：RuntimeConfigVersion A vs B。
- 片段 diff：某个 BehaviorRule 或 ToolDescription 的两个版本。

如果只做片段 diff，反而可能看不清最终发布影响，因为某个片段改了但未必被 active RuntimeConfig 引用。

#### 回滚能力是否会损失

整包内联的回滚最简单：active 指针回到旧 RuntimeConfigVersion。

引用模型的回滚有两种：

- 回滚整包 RuntimeConfigVersion：清晰。
- 只回滚某个片段版本：更灵活，但需要重新生成一个新的 RuntimeConfigVersion，不能偷偷改 active 配置里的引用。

因此推荐原则是：对外和运行时永远回滚 RuntimeConfigVersion；片段回滚只是创建新候选的编辑动作。

#### 跨产品同步能力是否会损失

要分清楚同步的对象：

- 同步一整套产品运行配置：RuntimeConfig 整包即可。
- 只同步某个工具描述到多个产品：需要独立 ToolDescription 对象，或需要“从产品 A 的配置中抽取片段复制到产品 B”的操作。
- 同步某条行为规则模板：独立 BehaviorRule 对象更自然。

如果跨产品同步只是低频人工操作，复制片段更简单。如果跨产品同步是产品能力，例如“browser 工具说明统一升级到 v4，并查看哪些产品未升级”，那就需要独立对象和引用。

所以不能预设全部场景都需要引用。建议采用混合模型，但主发布边界必须只有 RuntimeConfig。

### 推荐内部折中：RuntimeConfig + 可选素材库

推荐模型：

```text
RuntimeConfigVersion
  agents:
    story-agent:
      prompt: { mode: 'inline' | 'ref', content? ref? }
      enabled: true
      allowedTools: []
  behaviorRules:
    - { mode: 'inline' | 'ref', content? ref?, scope, appliesTo }
  toolDescriptions:
    - { mode: 'inline' | 'ref', toolId, description? ref? }
  policies:
    memoryPolicyRef
    retrievalPolicyRef
    modelPolicyRef
```

解释：

- RuntimeConfigVersion 是唯一发布单位。
- 配置片段可以内联，也可以引用素材库。
- 普通 run 不需要临时解析多层发布对象，只读取 active RuntimeConfigVersion 的 resolved view。
- 所有编辑动作最终都生成新的 RuntimeConfigVersion candidate。

这个模型比“所有对象都独立引用”简单，也比“所有内容都物理内联”保留更多演进空间。

### 是否应该全部引用素材库

全部引用模式有明显优点：概念一致、复用清晰、片段级 diff 和跨产品同步更自然。它适合配置片段数量多、跨产品共享多、审计要求强的系统。当前 ViForge 桌面版是单机自用场景，不应把这些能力理解为多人维护或审批流。

但它不是没有成本。

#### 全引用模式的优势

- 每个配置片段都有独立版本号和历史。
- RuntimeConfig 变得轻，主要保存 ref 和生效范围。
- 片段可跨产品复用，例如多个产品共享同一个浏览器工具描述版本。
- 片段级 diff、回滚和同步更直接。
- 更容易回答“哪些 RuntimeConfig 正在使用 ToolDescription X v4”。

#### 全引用模式的成本

- 运行时必须解析引用图，生成 resolved RuntimeConfig 快照。
- 发布审计必须保存 resolved snapshot，否则以后素材库变化或删除会影响历史解释。
- 编辑体验更复杂：用户改一句提示词，本质上要创建素材新版本，再创建 RuntimeConfig 新版本引用它。
- 删除和归档更复杂：素材是否被某个历史 RuntimeConfig 引用，需要引用计数或保护规则。
- 跨产品同步会引入依赖治理：共享片段升级后，哪些产品自动升级、哪些产品保持旧版本，必须有规则。
- 小型一次性配置也被迫对象化，会增加数据噪音。

#### 内联模式的真实优势

内联不是完全没有优势，它的优势主要在工程简单性和历史稳定性：

- RuntimeConfig 自包含，读取和回滚简单。
- 历史版本天然是完整快照，不怕素材库后续变化。
- 没有引用解析、悬空 ref、素材归档保护问题。
- 对一次性实验、小范围临时修改更轻量。

但纯内联的缺点也明显：跨产品同步、片段级复用和片段级审计会弱一些。

#### 更推荐的做法

如果目标是“内部也尽量清晰”，我倾向于全引用为主，但必须强制保存 resolved snapshot：

```text
RuntimeConfigVersion
  refs:
    agentPromptRefs
    behaviorRuleRefs
    toolDescriptionRefs
    policyRefs
  resolvedSnapshot:
    发布/评测时实际使用的完整展开内容和 hash
```

这样可以同时获得：

- 引用模式的复用、同步和片段级 diff。
- 快照模式的历史可解释和回滚稳定性。

这比“全内联”更灵活，也比“只有 ref 不存 resolved 内容”更安全。

### 需要禁止的内部模式

为了避免再次混乱，后续实现应禁止：

- AgentSpec 和 RuntimeConfig 同时作为发布主对象。
- PromptBlock 同时挂在 AgentSpec 和 RuntimeConfig 上。
- ToolDescription 同时有顶层版本对象和 LayerConfig 内联覆盖，但二者没有明确主从关系。
- 发布某个局部对象后隐式影响普通 run。
- 普通 run 在运行时从多个 active 对象临时拼配置，却没有保存 resolved config 快照。

可以接受的是：素材库对象独立存在，但它们只有被某个 RuntimeConfigVersion 引用并发布后才生效。

### AgentSpec 的去留

当前 AgentSpec 的问题是它看起来像“单 agent 配置版本”，但实际又引用全局 LayerConfig，容易制造误解。

建议重构时这样处理：

- 对外废弃 AgentSpec 概念，不再让用户选择或发布 AgentSpec。
- 内部可临时保留 AgentSpec 作为迁移兼容层，但新评测、新发布、新 UI 不再以它为主外键。
- 新模型中评测和发布绑定 RuntimeConfigVersion。
- 如果需要表示“这次只改了 story-agent”，用 RuntimeConfig.changeSet 的 `appliesTo=agent, agentId=story-agent` 表达，而不是创建一个只属于 story-agent 的发布对象。

这样可以回答用户最关心的问题：这次发布到底影响谁。答案写在 RuntimeConfig 的 changeSet、appliesTo 和 area 里，而不是靠用户推断 AgentSpec 和 LayerConfig 的关系。

### PromptBlock 和 ToolDescription 的地位

PromptBlock 和 ToolDescriptionConfig 不应该消失。它们应该成为“配置素材库”里的独立版本化对象。

建议边界：

- PromptBlock：行为规则素材，可被 RuntimeConfig 引用。
- ToolDescriptionConfig：工具说明素材，可被 RuntimeConfig 引用。
- AgentPrompt：agent 主体提示词素材，可被 RuntimeConfig 的 agents 引用。

UI 上可以把它们展示为 RuntimeConfig 的组成部分：

```text
运行配置 v12
- Agent 提示词：story-agent prompt v5, reviewer-agent prompt v3
- 行为规则：全局写入边界 v2, 故事质量门槛 v7
- 工具说明：browser_evaluate v4, send_wechat_message v2
- 策略：memory policy v1, retrieval policy v2
```

用户编辑时，可以仍然从“工具说明”或“行为规则”入口进入，但保存结果应该是“生成一个新的运行配置候选”，而不是让用户理解多个对象如何组合。
（我觉得可以不用预留那么多入口，直接）

### 评测模型应从 AgentSpec 转向 RuntimeConfig

当前 EvalRun 绑定 AgentSpec，会让评测天然偏向单 agent。下一版更清晰的模型是：

```text
EvalRun = RuntimeConfigCandidate + EvalFixture + EvalMode + Result
```

如果这次只改了某个 agent，candidate 的 changeSet 可以标记 `appliesTo=agent,agentId=story-agent`。但 EvalRun 仍然评测完整运行配置，因为真实系统运行时也总是完整配置在生效。

这能避免一个误区：只评测 story-agent 的 AgentSpec，但发布后全局工具描述也影响了 reviewer-agent。

### 发布模型应显式表达影响范围

发布页应该展示：

- 本次发布的 RuntimeConfig 版本。
- 相比当前 active 的 changeSet。
- 影响范围：全产品 / 指定 agent / 指定工具 / 策略。
- 关联 EvalRun 和 HumanReview。
- 是否存在未覆盖到的影响范围，例如改了全局工具描述但只跑了 story-agent fixture。

发布 gate 也应该从“某个 AgentSpec 是否有 passed EvalRun”升级为“候选 RuntimeConfig 的影响范围是否被足够评测覆盖”。

示例：

```text
改动：browser_evaluate 工具描述，全局生效
最低评测要求：至少覆盖一个需要浏览器工具的 fixture；如有多个产品共享该工具描述，需要按产品各跑一组 smoke fixture。
```

### 推荐重构后的四个区

这比当前五步线性流程更符合用户任务：

1. 配置包：查看 active RuntimeConfig，编辑 agent prompt、行为规则、工具说明和策略，生成 candidate。
2. 案例库：管理 fixture、assertion、tool retention、memory/knowledge 固定输入。
3. 评测报告：选择 candidate 和 fixture set，运行并比较 active/candidate。
4. 发布审计：查看影响范围、gate、人工审阅、发布和回滚。

这四个区里，只有“运行配置”是用户必须理解的配置发布概念。PromptBlock、ToolDescription、AgentPrompt 是可展开的组成材料。

### 迁移策略

为了避免一次性重写，可以分三步：

1. UI 层先隐藏 AgentSpec，把当前 AgentSpec + LayerConfig 组合包装成“运行配置候选”。底层数据暂不大改。
2. 后端新增 RuntimeConfig 读模型，把现有 AgentSpec、LayerConfig、PromptBlock、ToolDescription 解析成统一 DTO。
3. 再逐步把 EvalRun、release gate、release record 的主外键从 AgentSpec 迁移到 RuntimeConfigVersion。

这样可以先解决用户理解问题，再清理数据模型。

### 对当前建议的批判性结论

“对外只暴露 LayerConfig 一个概念”这个方向是对的，因为它抓住了用户只需要理解一个发布对象的问题。但不建议继续叫 LayerConfig，也不建议把所有内容物理内联进去。

更好的设计是：

- 对外叫“运行配置”或 `RuntimeConfig`。
- 对内保留 AgentPrompt、PromptBlock、ToolDescriptionConfig 等独立版本化素材。
- RuntimeConfig 引用这些素材，并声明生效范围。
- EvalRun 和发布 gate 绑定 RuntimeConfig，而不是绑定单 agent AgentSpec。

这会比当前组合依赖模型更清晰，也比“一个巨大 LayerConfig 包含一切”的模型更可维护。

## 建议的重构方向基线

基于当前边界，下一版交互可以先按四个工作区重构，而不是沿用现在的五步 tab：

1. 入口列表：查看历史配置流程，支持筛选、排序、查看、修改、发布检查、回滚、归档和删除未引用草稿。
2. 配置路线图：按评测案例上下文、Agent 配置、评测运行配置与断言配置、运行和人工审阅组织一次流程。
3. 配置库：管理可复用的 Agent prompts、PromptBlocks、ToolDescriptions 和 policies；WorkspaceManifest 暂不进入可编辑发布流程。
4. 案例库：管理评测案例上下文、snapshots、artifacts、tool retention；断言迁移到独立断言配置。
5. 评测台：选择 candidate bundle、案例上下文、评测运行配置、断言配置和审阅模板，运行 EvalRun，对比 active/candidate。
6. 发布台：查看 gate、人工审阅摘要、发布影响范围、本机 release records 和 rollback。

这只是功能分区建议，不是 UI 设计稿。真正进入 UI 设计前，应先决定上面“后续重构前需要先确定的问题”。

## 新交互需要补齐的关键细节

以下内容作为当前 PRD 和交互稿的对齐结论，后续实现时应直接落到 UI 状态、表单校验和审计记录中。

### 新建配置流程

- 入口列表点击“新建”后进入独立配置流程页，不在列表页展开详情，也不使用弹窗。
- 新建流程先选择产品、目标 agent 或全产品范围，并以当前 active 运行配置作为基线。
- 系统可以自动命名为“产品 / 范围 / 时间”，但必须允许用户改名。
- 新建动作只生成未保存表单，不创建候选运行配置，不提示配置创建成功。
- 保存或下一步时校验流程名、产品、范围、节点输入和真实差异；没有 Agent runtime 差异时只能保存流程草稿，不能生成候选运行配置。
- 候选配置已产生 EvalRun 后再次修改 Agent 配置，旧 EvalRun 必须标记为“基于旧候选”，不再作为发布 Gate 的通过证据。

### Agent 配置编辑

- Agent 配置阶段允许同时修改多个 agent 提示词、多条行为规则和多个工具说明。
- UI 按“Agent 提示词 / 行为规则 / 工具说明”分区，分区内按 agentId、规则标题或 toolId 展示原子变更项。
- 提示词编辑需要展示 agent 名称、范围、来源版本、候选正文、整段 diff 和变更摘要。
- 工具说明编辑需要按主描述、参数说明和输出说明展示字段级 diff。
- 行为规则编辑需要展示标题、范围、启停状态、来源版本、候选正文和正文 diff。
- 保存时统一生成一个候选运行配置，但 changeSet 必须按原子变更项拆开，方便评测覆盖、发布 diff 和回滚解释。
- Harness 只校验结构完整性、引用合法性、版本差异和范围合法性，不做提示词、工具说明或行为规则的语义审查。

### Diff 边界

- 发布 diff 比较 candidate RuntimeConfig 和当前 active RuntimeConfig，回答发布后普通 run 实际会改变什么。
- 片段 diff 比较某个提示词、行为规则或工具说明的新旧版本，回答具体文本改了什么。
- 断言配置 diff 和审阅模板 diff 不属于普通 run 发布内容，但需要作为评测证据展示，解释本次评测和人工审阅使用了什么标准。
- 片段回滚不是直接改 active 引用；片段回滚应创建一个新的候选 RuntimeConfig，再经过评测和发布。

### 断言配置交互

- 断言配置在步骤三是主编辑对象，评测运行配置只是紧凑执行参数区。
- 一个选择框同时支持选择历史断言配置和“新建断言配置...”。选择新建只打开未保存表单。
- 断言按文件变化、路径约束、Markdown section、工具事件、diff 限制和现有结构合规分组。
- 新增断言先选类型，再填写目标路径、toolId、参数路径、比较操作符、阈值、启停状态、失败等级和说明等结构字段。
- 断言列表支持新增、复制、启停、删除未引用项；已被 EvalRun 引用的断言版本只能派生新版本后修改。
- 断言失败结果应能回跳到对应断言配置项和评测报告里的文件 diff、工具调用或结构检查结果。
- Harness 只校验断言结构、引用、启停状态和可执行性，不判断断言是否合理或覆盖是否充分。

### 人工打分交互

- 人工打分和评测报告是步骤四下的两个平级主工作区，不能把打分表压缩到右侧窄侧栏。
- 人工打分区按审阅模板渲染所有打分项，每项必须显式标记为“已评分”或“不涉及”。
- 已评分项必须填写 1-10 分；不涉及项不填写分值、不参与总分，但可填写原因备注。
- 总分按涉及项权重重新归一化计算。
- 未完成逐项检查时，人工审阅提交按钮禁用，并显示未完成项定位。
- 新增打分项默认只插入当前未保存审阅表单；如果要复用，必须派生新审阅模板。
- 调整权重需要显示总权重、归一化结果和影响说明；已被历史审阅引用的模板不能静默修改，只能派生新版本。
- 派生模板复制原模板并生成未保存表单，自动命名为“原模板 / 派生 / 时间”；保存前必须校验打分项、权重和决策选项。

### 发布、强制发布和回滚

- 发布页只做决策和审计，不再编辑配置内容。
- 普通发布前必须展示发布 diff、影响范围、评测覆盖、程序断言、人工审阅和未解决风险。
- Gate 全部通过后普通发布启用；发布后 candidate 设为 active，旧 active 归档，并写发布记录。
- 强制发布必须选择原因并填写本机审计备注；记录中保存 force 标记、失败 Gate 项、发布 diff 和备注。
- 回滚从历史已发布版本或 release record 触发，需要展示当前 active 与目标版本 diff、回滚范围和被替换配置片段。
- 回滚必须填写原因，提交后生成新的发布记录；回滚后普通 run 读取回滚目标配置。
- 删除只允许无引用草稿；被 EvalRun、HumanReview、断言结果或 release record 引用过的对象只能归档。
