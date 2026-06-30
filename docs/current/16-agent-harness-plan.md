# Agent Harness 数据模型与实现起点

本文记录 Agent 优化 Harness 的当前实现起点。详细讨论稿保留在 [docs/todo.md](../todo.md)，两张 HTML 架构图保留在：

- [agent-harness-data-flow.html](../agent-harness-data-flow.html)
- [agent-harness-data-model.html](../agent-harness-data-model.html)

## 目标

Harness 的目标是把 agent 优化从主观调 prompt 变成可追踪闭环：

```text
AgentSpec 变更 -> EvalFixture 复现案例 -> EvalRun -> 程序检查 -> 人工评分 -> candidate/active 发布决策
```

Phoenix 暂时只作为 trace 查看工具，不作为配置中心。Langfuse 不再作为设计依赖。V1 不依赖 LLM judge，先做规则检查和人工抽检。

## 当前实现范围

当前第一批实现聚焦数据合同、后端存储/API 和最小前端入口：

- 共享合同新增 `AgentSpec`、`AgentLayerConfig`、`MemoryPolicy`、`MemoryRecord`、`KnowledgeBaseEntry`、`RetrievalPolicy`、`RunInputSnapshot`、`EvalFixture`、`EvalRun`、`HumanReviewRubric`、`HarnessSummary`。
- API 新增 `HarnessStore`，文件型持久化在 `WORKSPACES_ROOT/../harness`。
- 创建普通 run 时，API 会先创建 `RunInputSnapshot`，默认复制全项目轻量快照，排除 `.git`、`node_modules`、`dist`、构建缓存、日志等。
- API 新增 `/api/harness`、`/api/harness/agent-layer-configs`、`/api/harness/agent-specs`、`/api/harness/memory-policies`、`/api/harness/knowledge-base-entries`、`/api/harness/retrieval-policies`、`/api/harness/snapshots`、`/api/harness/eval-fixtures`、`/api/harness/eval-runs`、`/api/harness/human-review-rubrics`。
- Web 新增 Agent Harness 工具面板，可查看统计、新建 draft AgentSpec、创建显式 Agent 行为规则（底层为 PromptBlock）、从 snapshot 或 RunArtifact 创建 fixture、创建 Repro/Live EvalRun，并在评测和人工审阅后执行发布或回滚。SkillSnapshot 目前只作为运行证据和 resolved config 来源保留，不作为普通 UI 配置入口。
- Harness 读取状态时会按 `PRODUCT_PROFILES` 自动投影 baseline active AgentSpec：如果某个 product/agent 尚无 active spec，会从产品 profile 的 `system-agent.md` 和对应 specialist prompt 生成 `seed_<productId>_<agentId>_active_v1`，并生成 seed layer、memory、retrieval 和 manifest。已有 active 不会被覆盖。
- LangGraph workspace tools 已发布 `memory.read`、`memory.write`、`memory.recall`、`knowledge.retrieve` 事件，作为后续自动生成 `memoryFixture` 和 `knowledgeFixture` 的运行证据。
- 从 RunArtifact 生成 EvalFixture 时，系统会带上推荐 assertions、expectedChangedFiles、expectedToolEvents、memoryFixture 和 knowledgeFixture。推荐 assertions 已包含文件变化、allowed diff、Markdown heading、工具调用顺序、agent 阶段/reviewer gate 和来自 product profile artifactPaths 的 canonical path 检查。
- EvalFixture 支持 PATCH 更新，前端可直接编辑 assertions JSON，也可用裁剪控件维护 tags，逐项裁剪 messages、expectedChangedFiles、expectedToolEvents、memoryFixture、knowledgeFixture，并可调整 tool retention，作为“系统推荐 -> 人工确认/裁剪”的 V1 工作流。
- Repro EvalRun 已有 V1 隔离执行：复制 fixture 工作区到独立 eval run 目录，默认回放 expectedChangedFiles 和 expectedToolEvents，再执行程序断言并记录 fileDiff、changedFiles、assertionResults、resolvedAgentConfig。程序断言已支持 product profile canonical path 推导、manifest requiredSections、allowedChanges 和 diff 数量上限。
- HarnessStore 已预留 `evalRunExecutor` 注入点。默认 executor 使用 fixture 回放；正式 app 已接入 LangGraph isolated executor，让候选 AgentSpec 可以在 fixture 工作区里真实执行，workspace tools 指向隔离目录，不污染原项目。Repro 模式下 memory/knowledge 工具会优先使用 EvalFixture 中固定的 `memoryFixture` 和 `knowledgeFixture`，避免回归比较受 live 记忆或当前知识库变化影响。isolated executor 现在会把 resolved `AgentLayerConfig` 传入 agent registry，product 级 specialist 启用列表、system/specialist `instructionOverride`、tool/model/memory/retrieval policy refs 会进入实际执行路径和 prompt 摘要，不再只是记录在 EvalRun metadata 中。`resolvedAgentConfig` 也会保存 prompt block / skill 的内容 hash 和来源，便于判断候选 spec 实际用了哪些配置内容。
- AgentSpec 发布已有第一版 gate：active 发布默认要求至少一个 passed EvalRun 且人工评分 decision 为 pass/improved；发布会归档同 product/agent 的旧 active，并写入 releaseRecords。API 暴露 release-gate 检查结果，紧急场景可 force，但需要显式传入。releaseRecords 会保存 force 标记和当时的 gate 快照，便于审计为什么绕过发布检查。
- Web Harness 面板已按 HumanReviewRubric 渲染评分项，可切换 rubric，保存 decision、scores、subScores 和 notes，不再只写固定通过评分；同一面板可查看当前 AgentSpec 的评分汇总、评分历史、发布 gate 的通过/阻塞原因，并提供带浏览器确认的强制发布入口。Fixture 对比区已支持 active/candidate changedFiles 的逐行并排 diff，并把对应人工备注放在同一阅读区域。
- AgentSpec 发布 gate 会展示 candidate 相比当前 active 的 prompt、skill、layer、memory/retrieval/tool/model policy 差异；force 发布和回滚记录会保存 `forceReason` 与更粗粒度的 `auditCategory`，Web 端已能展开 release record 查看 gate 快照、配置差异、来源 release、前一个 active、备注和审计字段。
- Harness 已新增 `WorkspaceManifest` 数据模型和 API，resolved agent config 会带上当前 product 的 manifest；程序断言可以使用 manifest canonical path、requiredSections 和 requiredDirectories，不再只依赖 product profile 的静态 artifactPaths。
- Web Fixture 编辑区新增最小表单化断言构建器，可快速追加“要求创建/修改文件”“要求 Markdown 标题”“禁止写入路径”“只允许修改 Markdown section”“限制 diff 数”；仍保留 JSON 编辑用于高级断言。
- Web Harness 面板新增 Live/Repro EvalRun 模式切换，默认 Repro 使用 fixture 化 memory/knowledge；Live 模式需要显式选择。
- Web Harness 面板新增 AgentSpec 对比表，可按 spec 查看 eval 通过/失败数、人工评分数量、平均分和 decision 分布，作为发布前对比页的 V1 骨架。同一 Fixture 下也有 active/candidate 横向对比骨架，展示文件 diff 数、断言通过数、人工评分和相对 active 的检查/评分差，并能预览各 EvalRun 的 changedFiles 内容片段。
- HumanReview 已支持批量写入 API 和 UI 入口，可把当前 rubric、decision、scores 和 notes 应用到当前 AgentSpec 的未评分 EvalRun；HarnessStore 的文件写入队列也已改为读改写串行化，避免并发创建 EvalRun 或批量评分时丢状态。
- RunArtifact 现在记录模型参数摘要 `modelParams`、tool IO 字符数和截断标记、memory tombstone、retrieval query metadata，便于从失败 run 生成 fixture 时判断哪些输入需要固定或裁剪。从 RunArtifact 创建 EvalFixture 时会生成 `toolRetentionPolicy`，并按策略生成 `toolRetentionArtifacts`：保留全文、excerpt + hash、summary + hash 或 drop。策略生成会识别常见敏感字段并升级为 summary + hash。Web 端 RunArtifact 和 Fixture 详情会按工具、大小、截断和敏感性给出并允许调整 V1 裁剪策略。
- Active 配置预览已改成三层：默认只展示用户决策摘要、当前 agent 提示词和绑定行为规则；“Agent 上下文全貌”折叠区展示 active/candidate；更底层的 `AgentSpec`、`AgentLayerConfig`、MemoryPolicy、RetrievalPolicy、WorkspaceManifest、全部 specialist 和工具权限收进“高级审计信息”。

## 关键设计决策

### RunInputSnapshot

V1 默认捕获全项目轻量快照，而不是只捕获引用文件。原因是修复后的 agent 可能会读取失败 run 当时没有读取过的文件；如果 fixture 只保存最小文件集，复现环境会人为失真。

快照不复制 `.git`，git commit hash 和 dirty 状态只作为 metadata。git 是长期版本管理和校验依据，RunInputSnapshot 是失败复现的主依据。

### EvalFixture

EvalFixture 从 RunInputSnapshot、trace、会话消息、memory recall 结果、knowledge retrieval 结果和工具事件生成。它不是当前项目目录的引用，而是独立快照，避免项目后续变化污染历史评估。

### AgentLayerConfig

AgentLayerConfig 把 system agent、specialist agent、skill、memory/retrieval/tool/model policy 的组合显式化。短期只做 product 级默认分层，不做 workspace override；但普通 run 和 EvalRun 都要记录 resolved 配置，避免历史结果无法解释。

Baseline seed layer 的 system instruction 来自 product profile 的 `system-agent.md`，specialist `instructionOverride` 来自对应 profile prompt。它不是一次人工发布记录，而是把当前已有第一版提示词投影成可比较、可回滚的 active 基线。

### MemoryPolicy

MemoryPolicy 定义 session/workspace/global namespace、召回顺序、写入权限、冲突策略和 tombstone 要求。MemoryRecord 必须保留 authority、evidenceRefs 和 scope；EvalFixture 在 Repro 模式下固定 memoryFixture，避免回归结果受当前记忆状态污染。

### KnowledgeBase / RetrievalPolicy

知识库短期仍可使用全局工作区文本目录，但 Harness 数据模型要记录可检索知识卡索引。RetrievalPolicy 定义可检索类型、topK、rightsRisk 上限、写入流程和禁止复用规则。EvalFixture 可保存 knowledgeFixture，保证 candidate/active 比较时检索输入一致。

### HumanReviewRubric

创意度不放进 WorkspaceManifest。WorkspaceManifest 只定义结构合法性；创意度、因果推进、人物一致性、喜剧机制、可表演性属于人工评分 rubric。

### WorkspaceManifest

WorkspaceManifest 已作为 Harness 一等对象进入共享合同和 API。它定义 product 级模板版本、requiredDirectories、artifactTypes 的 canonicalPath 和 requiredSections。EvalRun 执行断言时会优先使用 active WorkspaceManifest；没有 manifest 时才退回 product profile artifactPaths。

这个边界很重要：manifest 只负责“文件结构和正式产物是否合规”，不负责判断故事是否好。故事质量仍由 HumanReviewRubric 和人工评分处理。

## 后续实现重点

1. 继续打磨真实 LangGraph 隔离执行。当前已完成 executor 适配器、app 接入、隔离 workspace、Repro memory/knowledge fixture 注入、Live/Repro 模式切换，并已让 executor 使用 resolved AgentLayerConfig 的启用 specialist、system/specialist instruction override 和 policy refs。resolved config 已记录 prompt block / skill 的内容 hash 和来源。独立 PromptBlock 存储已经进入 shared contracts、API 与 Harness 面板创建入口，并支持创建新版本；SkillSnapshot 相关 API 和合同保留用于证据链，但 UI 暂不作为用户编辑入口。后续重点是给 PromptBlock 做更清晰的 diff 视图和发布状态机。
2. 继续增强 EvalFixture 推荐项。当前已能从真实 run artifact 自动补消息、工具事件、文件 diff、memory、knowledge、Markdown heading、路径断言，并有最小表单化断言构建器。构建器已支持 section 级 diff 断言；Fixture 编辑区也已支持逐项确认/裁剪消息、文件、memory、knowledge、工具事件、assertion groups 和 tool retention。后续要把这些控件整合成更流畅的分步向导。
3. 扩展程序断言执行器。当前已覆盖文件变化、禁止写入、allowed diff、allowedChanges、diff 数量上限、Markdown heading/text、工具调用顺序、agent 阶段、reviewer gate、workflow gate、WorkspaceManifest canonical path/requiredSections/requiredDirectories、`diff.allowedMarkdownSections`，以及 `diff.allowedMarkdownTableRows`：只允许指定 Markdown 表格 key 行变化，并默认禁止删除该行。后续可补更细粒度的段落级 diff 和表格列级 diff。
4. 完善人工评分 UI。当前已有 rubric 渲染、subScores、评分历史、当前 AgentSpec 评分汇总、批量评分入口、跨 AgentSpec 对比表、同 Fixture active/candidate 对比、changedFiles 逐行并排 diff 和人工备注并排阅读。后续要继续增强为更完整的 review workspace，例如按断言失败点定位到 diff 行、支持 reviewer 对具体文件行写备注。
5. 强化 AgentSpec candidate -> active 发布和回滚状态机。当前已有发布 gate、旧 active 自动归档、releaseRecords、回滚入口、force reason、独立 audit category、配置差异展示、V1 发布前对比表、回滚到指定 spec 的确认备注、按 release record 选择回滚目标，以及 release record 详情展开视图。后续重点是补更严格的权限/确认策略和 release record 筛选。
6. 继续完善 run artifact。当前已记录 memory/knowledge 事件、memoryWrites、memoryTombstones、knowledgeRetrievals、traceId、model、modelParams、tool IO summary 和 resolved run config；Web 端已能按工具 IO 大小、截断和敏感性显示裁剪建议，并能把建议保存到 EvalFixture 的 `toolRetentionPolicy`。EvalFixture 生成逻辑已会按该策略生成 `toolRetentionArtifacts`，支持 full、excerpt + hash、summary + hash 和 drop，并会识别常见敏感字段后自动升级裁剪级别。后续要补的是更强的人工裁剪向导和可配置敏感字段规则。
