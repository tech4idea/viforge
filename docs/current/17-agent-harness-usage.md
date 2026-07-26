# Agent Harness 使用说明与流程校验

本文面向实际使用 Agent Harness 的人，目标不是解释所有数据模型，而是回答三个问题：

1. 我应该按什么顺序操作？
2. 每个按钮到底会创建或改变什么？
3. 当前流程哪里容易误操作，后续 UI 应该怎么改？

## 一句话理解

Agent Harness 不是普通配置页，而是一个 agent 改动发布流水线：

```text
看清当前 agent 完整提示词 -> 修改或新增行为规则 -> 创建候选 AgentSpec -> 从历史对话沉淀 Fixture -> 运行 EvalRun -> 人工审阅 -> 发布为运行配置
```

关键点：创建候选配置不会影响真实运行；发布为运行配置才会改变真实默认 agent 行为。

首次打开 Harness 时不应该是空白状态。系统会从当前产品 profile 的第一版 system/specialist prompt 自动生成 baseline active AgentSpec。这个 baseline 是现有运行配置的投影，不是人工评测发布记录。

## 核心对象

### AgentSpec

AgentSpec 是一次 agent 运行配置的版本。它绑定：

- 产品，例如 `sitcom` 或 `novel-adaptation`。
- agent，例如 `story-agent`、`reviewer-agent`。
- Agent 行为规则引用。
- 分层配置、记忆策略、知识库检索策略、模型和工具策略引用。

它回答的是：“这个 agent 当前候选版本到底用哪套规则和运行上下文？”

### Agent 行为规则

UI 里说的“Agent 行为规则”，代码里仍叫 `PromptBlock`。它只应该存 agent 的工作规则，不应该存项目事实。

合理内容：

- story-agent 输出必须包含主角目标、阻力、升级、选择、后果。
- reviewer-agent 必须明确给出通过/退回理由。
- agent 写文件前必须遵守 WorkspaceManifest 的正式路径。

不合理内容：

- 这个项目的主角叫老周。
- 第三集已经确定发生在物业办公室。
- 用户刚否定了广场舞方向。

这些属于项目文件、memory 或 session state。

一个行为规则可以被多个 AgentSpec 绑定，也就可以被多个 agent 复用。但不要默认滥用复用：通用写入边界可以共享，角色质量规则最好先按 agent/product 分开，跨 agent 复用必须通过评测证明没有误伤。

### EvalFixture

EvalFixture 是一个固定评测案例。它包含失败或回归案例需要的工作区快照、输入消息、记忆 fixture、知识库 fixture、预期工具事件和断言。

它回答的是：“我要用哪个固定场景测试这个候选 AgentSpec？”

### EvalRun

EvalRun 是一次实际评测运行。它复制 fixture 工作区到隔离目录执行，不应污染真实项目文件。

评测中的 memory write 工具应该 mock：agent 可以调用，系统记录它试图写什么，但不写入真实 memory。

### HumanReview

程序断言只能证明结构和边界没坏，不能证明故事质量变好。HumanReview 是人工评分和发布判断。

### 发布运行配置

发布是把某个 AgentSpec 设为 `active`。发布后，普通 run 才应该默认使用它。

发布 gate 当前要求：至少有一个 passed EvalRun，并且人工评分 decision 是 `pass` 或 `improved`。强制发布可以绕过 gate，但必须写审计原因。

## 推荐操作流程

### 1. 先看当前 agent 全貌

Harness 入口会直接打开独立浏览器标签页，不再挤在主工作台悬浮窗里。在修改规则前，用户必须能看到当前 agent 的提示词和关键上下文。当前 UI 分三层展示：

- 第一层：当前 active 的用户决策摘要，例如运行版本、当前 agent、提示词来源、绑定规则数量。
- 第二层：当前 agent 的 specialist prompt 和绑定的 Agent 行为规则。
- 第三层：右侧“Agent 上下文全貌”预览区展示 active/candidate 和简单差异；更底层的 system/layer/memory/retrieval/tool/model/manifest 和全部 specialist 配置收进高级审计信息。

这样设计的原因是：日常操作先看“我正在改哪个 agent、当前 prompt 是什么、候选比 active 改了什么”；底层 resolved config 仍然保留，但作为审计证据，不再默认压到主界面上。

### 2. 评测基础和 baseline active

Harness 会自动准备 baseline active AgentSpec：

- 从 `PRODUCT_PROFILES` 读取产品和默认 agent 枚举。
- 对没有 active AgentSpec 的 product/agent 创建 `seed_<productId>_<agentId>_active_v1`。
- seed layer 的 system prompt 来自 product profile 的 `system-agent.md`。
- seed specialist prompt 来自对应 agent prompt。
- 同时补齐 seed memory/retrieval policy 和 workspace manifest。

这个动作在读取 Harness 状态时自动发生，不需要用户点击。

按钮：`初始化评测基础`

它应该只在一个产品第一次使用 harness 时点击。它会创建或准备：

- 默认 AgentLayerConfig。
- 默认 MemoryPolicy。
- 默认 RetrievalPolicy。
- 默认 WorkspaceManifest。
- 一条示例知识卡。
- 一个 draft AgentSpec。

它不是日常每次改提示词都要点的按钮。

当前 UI 已根据是否存在基础配置动态显示这个按钮；正常情况下有 seed baseline 后不需要用户先点初始化。

### 3. 修改或新增 Agent 行为规则

如果只是调 prompt，不要直接改 AgentSpec，而是新增或新建一个行为规则版本，然后让候选 AgentSpec 引用它。

推荐规则：

- 小改动：基于已有行为规则创建新版本。
- 新增独立约束：新建行为规则。
- 不确定是否通用：先只绑定到当前 agent 的候选 AgentSpec，不要跨 agent 共享。

当前 UI 已把“查看当前规则”和“修改当前规则”合并：选择行为规则后可以直接看标题、类型、内容，并且只有内容、标题或类型发生变化时，才允许保存为新版本。新建行为规则使用独立输入框，创建成功后会清空，避免连续误点生成重复规则。创建候选 AgentSpec 同样要求至少有候选名称或行为规则变化。

### 4. 创建候选配置

按钮：`创建候选配置`

它创建一个新的 draft AgentSpec，绑定当前选择的产品、agent 和 Agent 行为规则。

它不会成为线上运行配置，也不会影响普通创作 run。

创建候选时会优先从当前 active AgentSpec 复制 layer、skill、memory、retrieval、tool、model policy 引用，再叠加用户选中的行为规则。这样候选不会变成半空配置，active/candidate 对比也有真实基线。

什么时候点：

- 已经确认要测试一个新的 agent 行为组合。
- 已经选好 product、agent 和行为规则。
- 需要一个可被 EvalRun 引用的候选版本。

什么时候不该点：

- 还没写完行为规则。
- 只是想看当前 prompt。
- 只是想初始化 harness 基础数据。

当前 UI 现在提供了删除未被引用的草稿候选入口；只有没有 EvalRun 和 release record 引用的 AgentSpec 才能删除，active 版本仍然不允许从这里清理。

### 5. 创建或选择评测案例

推荐优先级：

1. 从历史会话选择一条用户消息创建 Fixture。
2. 从失败 RunArtifact 创建 Fixture。
3. 从 RunInputSnapshot 创建 Fixture。
4. 手动编辑 assertions。

从历史会话创建 Fixture 时，只能选择一条用户消息。系统会使用这条消息对应 run 的输入快照恢复 workspace，并保存这条消息之前的最近会话上下文；EvalRun 会按 user/assistant 消息序列送入 LangGraph，而不是把多条消息拼成一段文本。agent 输出只作为历史上下文或预期结果来源，不会被当作新的用户输入。

从失败 RunArtifact 创建也可以保留，因为它能带出当时的文件 diff、工具事件、memory recall、knowledge retrieval 和 resolved config 线索；但普通用户入口优先走历史会话。

断言构建器是“选择一个断言类型 -> 填对应字段 -> 添加断言”。自动生成的断言会显示成可勾选列表，可批量删除；同时保留 JSON 高级编辑。手动编辑 JSON 时不会被后台刷新覆盖，只有点击“保存断言”后才写入 Fixture。

### 6. 运行 EvalRun

选择 fixture、candidate AgentSpec 和 run mode：

- Repro：默认模式。读取 fixture 中固定的 memory/knowledge，适合回归比较。
- Live：读取当前 live memory/knowledge，用于诊断真实环境下是否仍然正常。

无论 Repro 还是 Live，EvalRun 都不应该写真实 memory。memory write 工具应该 mock 并记录到 artifact。

EvalRun 会使用 source RunArtifact 记录的模型参数；如果 source 没有模型记录，才回退到当前运行时默认模型。候选 AgentSpec 新增或修改的 PromptBlock 会拼入对应 agent 的 instruction，避免“界面绑定了规则但评测实际没用”的情况。

### 7. 人工审阅

看 EvalRun 的断言结果、文件 diff、工具事件和 mocked memory writes，然后填写 HumanReview。

建议 decision 语义：

- `pass`：质量可接受，没有明显退化。
- `improved`：相对 active 明显更好。
- `fail`：未达基本要求。
- `regressed`：比 active 更差。
- `needs_regression_case`：发现新问题，应先沉淀 fixture。

### 8. 发布运行配置

按钮：`检查发布 Gate`、`发布为运行配置`

只有完成 EvalRun 和 HumanReview 后才进入这个节点。

发布前应确认：

- candidate 相比 active 改了哪些行为规则或 policy。
- EvalRun 是否 passed。
- HumanReview 是否 pass/improved。
- 是否存在高风险 mocked memory writes。
- 文件 diff 是否符合预期。

如果 gate blocked，不要直接强制发布，除非是明确紧急修复，并写审计原因。

## 当前卡点与 UI 改造建议

### 卡点 1：看不到每个 agent 的提示词全貌

这是当前最大问题。用户无法判断新增规则应该写在哪里，也无法知道规则和已有 system/specialist instruction 是否冲突。

当前已做的改动：

- Active AgentSpec 预览。
- Candidate AgentSpec 预览。
- 当前 agent prompt 分段展示。
- 行为规则来源标记：agent spec / layer config / prompt block / missing。
- 底层 spec/layer/memory/retrieval/manifest/tools 收进高级审计信息。
- 配置页默认记住上次选择的产品、agent、候选、fixture、EvalRun 和 tab。

仍建议后续补：Active vs Candidate 的 assembled prompt diff。目前能看到 active/candidate 两边内容，但还不是专门的逐段 diff 视图。

### 卡点 2：误点后没有修改或删除

需要区分三类操作：

- 编辑：对行为规则创建新版本，不直接改历史版本。
- 归档：对 draft/candidate AgentSpec、行为规则版本做 archive。
- 删除：只允许删除没有 EvalRun、release record 引用的草稿对象。

批判点：完全开放删除会破坏审计链；完全不允许清理又会让 UI 充满垃圾记录。合理折中是：默认归档，极少数未引用草稿允许硬删除。

### 卡点 3：创建规则按钮位置不防呆

应改成：

```text
行为规则标题
行为规则内容
[保存行为规则草稿] [保存并生成候选配置]
```

并在标题或内容为空、没有发生差异时禁用“保存并生成候选配置”。当前 UI 已实现这一步。

### 卡点 4：两个创建按钮语义不清

更清晰的文案应是：

- `初始化评测基础`：只在产品第一次接入 harness 时使用。
- `创建候选 AgentSpec`：为当前 agent 改动创建一个可评测版本。

并且 UI 已根据当前产品是否已有基础配置决定是否展示初始化按钮。

### 卡点 5：交付前应先跑一遍用户路径

按上面的流程反推，当前 UI 还没到“顺手可用”。最应该先补的不是更多模型字段，而是：

1. 当前 agent prompt/resolved config 预览。
2. draft/candidate 归档或清理。
3. 行为规则创建区防呆。
4. 初始化按钮从主流程降级为 checklist。
5. EvalRun memory write mock 的 UI 标识。

当前实现已经覆盖 1, 2, 3, 4；第 5 项在 EvalRun 结果和 release gate 中继续强化。

## 最小可交付标准

下一版 UI 至少要满足：

1. 用户改规则前能看到当前 agent 上下文。
2. 用户能清理误创建的 draft/candidate。
3. 新建行为规则不会因为按钮位置导致误点。
4. 用户能明确知道“初始化基础”和“创建候选”不是同一件事。
5. 发布按钮只出现在评测和人工审阅之后。

达不到这五点，就不应该继续往里面塞更多配置项。否则功能越多，用户越难判断自己在改什么。
