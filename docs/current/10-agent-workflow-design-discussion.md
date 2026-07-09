# Agent 创作流程设计讨论

本文用于明确 viforge 的多 agent 创作流程，并记录 V1 已采用的产品和技术方案。

## 方案摘要

viforge 的 agent 系统应围绕“创作质量闭环”设计，而不是围绕前端可选 agent 列表设计。

推荐 V1 形态：

- `system_agent` 由 Codex `AGENTS.md` 承担，是唯一默认入口。
- 子 agent 以 Codex skills 为主要形态，由仓库维护模板并同步到全局 `Agent 配置/skills`。
- 前端不暴露 agent 选择器，但必须精细展示当前系统正在经历的创作阶段、调用的 agent、返工轮次和审稿结论。
- 脑暴只作为正常对话和方向探索，不受返工轮次限制，不调用 reviewer-agent，不写入项目工作区；用户明确要求保存时，才写入指定位置。
- 故事、剧本、审稿构成闭环：故事创作 -> 故事审稿 -> 返工 -> 编剧 -> 剧本审稿 -> 返工 -> 最终结果。
- 审稿不保存为项目文件；它是质量控制过程，最终只保证通过后的故事/剧本写入工作区。

## 创作质量基准

后续 agent 不能只按“看起来不错”工作，需要明确判断标准。

### 好故事的定义

这里的“好故事”指适合单元剧情景剧的故事，不只是“好看的段子”或“完整大纲”。

一个合格故事至少需要满足：

- **完整行动**：有清楚的起点、发展和结果，事件之间是因果推进，而不是素材罗列。
- **主角欲望**：核心人物想要某个具体结果，且这个结果能驱动行动。
- **阻力与冲突**：阻力不是装饰，必须持续妨碍主角达成目标。
- **升级**：局面要变得更复杂、更尴尬或代价更高，不能平铺。
- **选择与后果**：角色要做选择，选择带来后果，后果继续推动故事。
- **反转或认知变化**：结尾最好产生局势反转、误会揭开、关系变化或人物自我暴露。
- **人物一致性**：角色行为符合人物设定、欲望、缺点和关系。
- **单元剧适配**：故事能在一集或一个短单元内完成，复用固定人物和场景，不依赖过重外部设定。
- **喜剧根源**：笑点来自人物缺点、关系错位、情境压力和误会升级，而不是硬塞网络段子。

这个标准参考了戏剧理论中对情节统一性、因果性、起承转合、反转和认知变化的要求，也结合了现代编剧中“角色欲望、障碍、冲突、利害关系”的基本原则。

### 好剧本的定义

剧本不是故事正文的文学扩写。它必须能被拍摄、表演和剪辑。

一个合格剧本至少需要满足：

- **场景目标清楚**：每场戏都知道谁想要什么。
- **场景冲突明确**：每场戏都有阻力、误解、对抗、隐瞒或利益冲突。
- **场景推动故事**：没有只解释背景、只抖包袱、只聊天的废场。
- **对白可表演**：对白符合角色身份、关系和当下目的，不像作者替角色说明剧情。
- **潜台词存在**：人物不总是直接说真实意图，台词下方有欲望、回避、试探或攻击。
- **动作可拍摄**：动作、调度和道具是镜头能拍到的，不依赖抽象心理描写。
- **节奏有变化**：冷开场、铺垫、误会升级、反转、收束之间有速度差。
- **喜剧节拍明确**：笑点有铺垫和回收，不破坏人物可信度。
- **格式统一**：场景标题、动作、对白、括号说明等使用固定模板。
- **服务故事**：剧本的改动不能破坏已通过审稿的故事核心。

## Agent 角色

### System Agent

实现位置：

```text
Agent 配置/AGENTS.md
```

职责：

- 识别用户意图：脑暴、故事创作、编剧、审稿、返工、保存结果。
- 判断当前阶段是否具备输入条件。
- 调用合适的 skill agent。
- 对正式故事和剧本维护最多 5 轮的自动返工闭环，轮数后续可配置。
- 将每轮失败原因展示在聊天中。
- 控制写入边界：未通过质量闸门的内容不写入正式项目文件。
- 对最终通过的故事或剧本执行保存。

系统行为原则：

- 当用户只是在探索，保持聊天态，不污染工作区，不审稿、不计轮次。
- system agent 不能把“路由完成”“准备调用 brainstorm-agent”作为单独回复；完成意图判断后，必须在同一次 Codex 流里直接输出对应 agent 的实质内容。
- 当用户要求创作正式故事，进入故事生产闭环。
- 当用户要求剧本，先确认是否已有可用故事；没有则先补故事。
- 当审稿失败，自动把不合格点交回对应 agent。
- 当连续返工超过上限，停止自动循环，向用户呈现卡住原因。

### Brainstorm Agent

定位：

- 探索故事种子的发散 agent。

职责：

- 根据一句话想法、题材、人物、关系或场景，生成候选方向。
- 提炼潜在冲突、喜剧机制、关系张力和反转可能。
- 帮助用户从模糊方向中找到可发展的故事种子。

输出：

- 候选方向。
- 每个方向的喜剧张力。
- 潜在风险。
- 推荐继续发展的一个方向。

写入策略：

- 默认只留在聊天会话。
- 只有用户明确要求“保存到某文件/某目录”时，才写入指定工作区。
- 不进入 reviewer-agent 审稿，不受自动返工上限限制。

### Story Agent

定位：

- 根据人类给出的想法，创作一个符合单元剧设定的好故事。
- 它不是大纲整理器，也不是表格生成器。

输入：

- 用户给出的故事方向或想法。
- 固定人物、人物设定、角色弧光、角色关系。
- 固定场景、单集时长、题材禁区、风格口径。
- 历史剧情和已有项目设定。
- 脑暴候选方向，如果用户明确采用。

职责：

- 创作一次只聚焦一个小故事。
- 形成完整行动链：目标、阻力、升级、选择、后果、反转或收束。
- 保证故事符合人物设定和历史剧情。
- 保证故事适配单元剧：一集完成，人物和场景可复用。
- 生成必要中间结构，但最终产物是故事正文。

输出：

- 故事标题。
- 一句话故事核。
- 故事正文。
- 主角目标。
- 主要阻力。
- 升级链条。
- 关键反转或收束。
- 涉及人物和场景。

正式产物：

```text
02 故事/<集数>/故事正文.md
```

不需要故事版本记录文件，版本管理交给系统层实现。

### Screenwriter Agent

定位：

- 把已成立的故事转换为可拍摄、可表演的剧本。

输入：

- 通过故事审稿的故事正文。
- 人物设定、角色关系、角色弧光、历史剧情。
- 场景设定、风格约束、单集时长。
- 剧本固定模板。
- 审稿 agent 打回的不合格点。

职责：

- 将故事拆成戏剧场景，而不是机械扩写大纲。
- 写清场景目标、冲突、动作、对白和节奏。
- 保持角色声音差异。
- 保留故事核心，不为了段子牺牲因果和人物。
- 根据审稿打回点返工。

剧本格式建议：

```md
# 第 X 集《标题》

## 冷开场

### 场景 1：地点 / 时间

动作：

角色A：

角色B：

节拍：

## 正戏

### 场景 2：地点 / 时间

动作：

角色A：

角色B：

节拍：

## 结尾
```

正式产物：

```text
03 剧本/<集数>/剧本.md
```

不需要 `第一版/第二版/定稿` 文件，版本管理交给系统层实现。

### Reviewer Agent

定位：

- 质量闸门。
- 它不是润色 agent，也不是建议 agent。

覆盖范围：

- 故事审稿。
- 剧本审稿。

职责：

- 判断是否达标。
- 找出不符合要求的地方。
- 判断应打回 story agent 还是 screenwriter agent。
- 不替作者改稿。
- 不输出鼓励语。

输出格式：

```md
结论：通过 / 打回
打回对象：story-agent / screenwriter-agent / none
不合格项：
1. ...
2. ...
3. ...
返工要求：
1. ...
2. ...
```

审稿不需要落盘，只需要在聊天中展示每轮失败原因，并保证最终结果达标。

## 自动返工机制

默认最多 5 轮，后续可配置。该机制只适用于正式故事和剧本生产；脑暴是普通对话，不进入审稿或返工机制。

流程：

1. system agent 调用 story 或 screenwriter。
2. reviewer 检查输出。
3. 如果通过，进入下一阶段或保存最终结果。
4. 如果打回，system agent 把不合格项传回对应 agent。
5. 每轮失败原因展示在聊天中。
6. 达到轮数上限仍未通过时，停止自动返工，展示阻塞原因和最近一次不合格项。

这个机制需要避免无限循环，同时不能把一次失败直接交给用户处理。

## 前端精细展示方案

虽然不需要前端暴露 agent 选择器，但前端必须展示系统内部进度。否则用户看不到“到底是谁在工作”和“为什么反复修改”。

### 会话消息顶部

正式故事/剧本创作 run 的 assistant 消息顶部显示：

- 当前阶段：脑暴 / 故事创作 / 故事审稿 / 编剧 / 剧本审稿 / 保存结果
- 当前 agent：system / brainstorm / story / screenwriter / reviewer
- 状态：运行中 / 通过 / 打回 / 已停止
- 返工轮次：例如 `第 2/5 轮`

### Agent Timeline

在助手消息内展示一条紧凑 timeline：

```text
system 路由 -> story-agent 产出 -> reviewer 打回 -> story-agent 返工 -> reviewer 通过 -> screenwriter 产出 -> reviewer 通过
```

每个节点显示：

- agent 名称。
- 开始/结束状态。
- 如果打回，显示一行硬伤摘要。

### 打回详情

每轮打回折叠展示：

```text
第 1 轮打回：主角目标不具体；冲突没有升级；结尾只是结束不是反转。
第 2 轮打回：角色行为和人物设定冲突。
```

### 最终结果区

通过后显示：

- 最终故事或剧本摘要。
- 已写入文件路径。
- 是否存在未保存内容。

### 技术事件建议

为支持精细展示，需要让后端或 system agent 产生结构化过程事件。建议新增内部事件协议：

```ts
type AgentTraceEvent =
  | { type: 'agent.step.start'; runId: string; agentId: string; phase: string; iteration: number; maxIterations?: number }
  | { type: 'agent.step.end'; runId: string; agentId: string; phase: string; iteration: number; maxIterations?: number; status: 'passed' | 'rejected' | 'failed' }
  | { type: 'agent.review.reject'; runId: string; targetAgentId: string; iteration: number; maxIterations?: number; reasons: string[] }
  | { type: 'agent.workflow.end'; runId: string; status: 'passed' | 'stopped'; outputPath?: string };
```

V1 可以先让 `AGENTS.md` 要求 system agent 在关键节点输出固定 JSON block，后端解析为 trace event；V2 再升级为后端显式 orchestrator。

V1 采用 JSON block 方案：

- system agent 在输出中写入固定格式 trace block。
- 后端解析 trace block 并转成前端 timeline 事件。
- 后端暂不强制拆分多次 Codex run。
- trace 合同按后续 orchestrator 的目标形态设计，避免未来迁移时重做前端。
- 脑暴对话不需要输出 trace block，也不展示 routing trace；它应表现为一条普通助手回复，直接进入设定讨论、候选方向或追问。

这一选择的理由是：当前最需要验证的是 agent 指令、审稿标准和返工闭环是否能产出稳定质量，而不是先投入更重的后端编排系统。JSON block 方案可靠性弱一些，但足够支撑 V1 的可视化和迭代。

需要注意：V1 的子 agent 是 Codex skill，不是后端显式启动的独立 run。后端只打开一条 Codex stream，所以如果 system agent 只输出“已路由到某 agent”并结束，前端没有可靠事件能自动续跑下一条 agent 流。当前约束是通过 `AGENTS.md` 和后端 prompt 要求同一条回复内直接给出子 agent 内容；如果后续需要强保证，应升级到后端 orchestrator，由后端分类并显式发起 child-agent run。

## 技术落点

### Agent 定义

V1 当前使用仓库维护的默认模板，集中在 [packages/shared/src/templates.ts](../../packages/shared/src/templates.ts) 中生成 `AGENTS.md` 和四个 `SKILL.md`。如果后续模板继续变长，可以再拆到独立目录：

```text
packages/shared/src/agentSkills/
  system/AGENTS.md
  brainstorm-agent/SKILL.md
  story-agent/SKILL.md
  screenwriter-agent/SKILL.md
  reviewer-agent/SKILL.md
```

初始化全局 Agent 配置时写入：

```text
apps/api/data/workspaces/_global/Agent 配置/
  AGENTS.md
  skills/
    brainstorm-agent/SKILL.md
    story-agent/SKILL.md
    screenwriter-agent/SKILL.md
    reviewer-agent/SKILL.md
```

理由：

- git 能维护版本。
- 后端能快速迭代。
- Codex runtime 已经复制 `AGENTS.md` 和 `skills` 到 `CODEX_HOME`。
- 后续要注入知识搜索功能时，skill 形态更自然。

### 关于 skill 调用和强制闭环

Codex skill 更像“可被 agent 读取和采用的能力包”，不是传统意义上的后端函数调用。因此只把子 agent 写成 skill，并不能天然保证：

- system agent 一定调用了正确 skill。
- reviewer 一定参与了每轮检查。
- 返工一定按 5 轮上限执行。
- 前端一定知道当前 agent 状态。

因此 V1 需要两层约束：

1. `AGENTS.md` 写清工作协议，要求 system agent 按固定流程调用 skill。
2. system agent 输出结构化 trace block，后端解析并展示。

如果后续发现 Codex 自主执行不够稳定，再升级为后端 orchestrator：

- 后端显式调用 story run。
- 后端显式调用 reviewer run。
- 根据 reviewer 结果决定是否创建下一轮 story/screenwriter run。

这会更可靠，但实现成本更高。V1 先用 skill + trace 协议验证质量。

### 全局 Agent 配置

返工上限和 agent 工作协议放在全局 Agent 配置中：

```text
Agent 配置/AGENTS.md
Agent 配置/config.toml
Agent 配置/skills/*/SKILL.md
```

默认返工上限为 5 轮。后续如果需要 UI 配置，可以先落到全局 `config.toml`，再由前端提供设置入口。

## 文件结构建议

当前项目模板是阶段优先：

```text
02 故事/01 第一集/...
03 剧本/01 第一集/...
04 分镜脚本/01 第一集/...
```

另一种方案是集数优先：

```text
01 第一集/故事/...
01 第一集/剧本/...
01 第一集/分镜/...
```

判断：

- 阶段优先适合“当前产品已有结构”和创作阶段型工作流。
- 集数优先适合按单集交付、查看一集全资产。
- 现在直接切到集数优先会影响现有 workspace tree、模板、测试和用户习惯。

推荐：

- V1 保持阶段优先，避免大规模迁移。
- 在 `02 故事/<集数>/故事正文.md` 中明确“故事”是剧本前的正式产物。
- 后续如需集数维度体验，用前端虚拟聚合视图实现，不急着改变真实文件结构。

最终建议文件：

```text
02 故事/01 第一集/故事正文.md
03 剧本/01 第一集/剧本.md
```

保留辅助文件：

```text
02 故事/01 第一集/单集大纲.md
02 故事/01 第一集/情节卡片.md
02 故事/01 第一集/冲突设计.md
```

这些是辅助结构，不是主产物。

## 已确认决策

1. 脑暴只留在聊天中，除非用户明确要求保存；脑暴不审稿、不自动返工、不受轮次上限限制。
2. V1 保持阶段优先目录：`02 故事/<集数>/故事正文.md`、`03 剧本/<集数>/剧本.md`。
3. 审稿记录不落盘，只保证最终结果。
4. 自动返工默认最多 5 轮，后续可配置。
5. 每轮失败原因需要在聊天中展示。
6. story agent 一次生成一个小故事。
7. 单元剧硬约束包括固定人物、固定场景、单集时长、题材禁区、风格口径、人物设定、角色弧光、历史剧情。
8. 剧本需要固定模板和统一标准。
9. 子 agent V1 倾向使用 Codex skill。
10. agent 模板需要随仓库提交，并在初始化全局 Agent 配置时写入默认 skills。
11. Agent trace V1 使用 system agent 输出 JSON block，后端解析为 timeline 事件。
12. 返工上限配置放在全局 Agent 配置，默认 5 轮。
13. 最终结果达标后自动写入对应项目文件。
14. reviewer 只保留 `通过/打回`，不设置 `勉强通过`。
15. system agent 路由不能形成一次可见的空回复；脑暴必须同一条流直接进入 brainstorm-agent 的实质讨论。

## V1 已落地内容

1. 默认全局 `Agent 配置/AGENTS.md` 已升级为 viforge system agent。
2. 默认 skills 已切换为 `brainstorm-agent`、`story-agent`、`screenwriter-agent`、`reviewer-agent`。
3. 默认 workspace 模板已新增 `02 故事/<集数>/故事正文.md`，并统一剧本正式产物为 `03 剧本/<集数>/剧本.md`。
4. 后端已支持解析 system agent 输出的 agent trace JSON block，并转成结构化 `agent.*` stream event。
5. 前端已展示当前阶段/agent/状态/返工轮次、agent timeline、打回详情、最终写入路径和未保存状态。
6. 全局 `Agent 配置/config.toml` 已加入 `[viforge].max_revision_rounds = 5` 默认配置。

## 后续演进建议

1. 用真实创作样例持续校准 system agent 和 reviewer-agent 的稳定性。
2. 如果 JSON block 协议不够稳定，再升级为后端 orchestrator 显式编排 story/reviewer/screenwriter run。
3. 给 `config.toml` 增加前端设置入口，但不要在 V1 把 agent 选择暴露给用户。

## 参考依据

- Aristotle, *Poetics*：情节需要统一、完整、有因果推进，并包含开始、中段、结尾、反转或认知变化等戏剧要素。参考：https://www.csun.edu/~hcfll004/poetics.html
- University of Hawaii CriticaLink, Aristotle: Plot：强调情节统一、长度适当、能被整体把握。参考：https://www.english.hawaii.edu/criticalink/aristotle/terms/plot.html
- Palomar College Pressbooks, *FADE IN: A Guide to Screenwriting Basics*：强调故事从问题出现开始，场景需要冲突、障碍和不断上升的 stakes。参考：https://pressbooks.palomar.edu/candacerose/chapter/chapter-8-conflict-obstacles-and-rising-stakes/
- The Script Lab, “Character + Want + Conflict = Story”：强调角色、强烈欲望、困难和 stakes 是故事驱动核心。参考：https://thescriptlab.com/screenwriting/script-tips/464-character-want-conflict-story/
