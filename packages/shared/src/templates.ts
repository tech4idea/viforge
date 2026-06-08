export type TemplateFile = {
  path: string;
  content: string;
};

export type WorkspaceTreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: WorkspaceTreeNode[];
};

export const DEFAULT_GLOBAL_DIRECTORIES = [
  'Agent 配置',
  'Agent 配置/skills',
  'Agent 配置/skills/brainstorm-agent',
  'Agent 配置/skills/source-analyst-agent',
  'Agent 配置/skills/adaptation-planner-agent',
  'Agent 配置/skills/screenwriter-agent',
  'Agent 配置/skills/reviewer-agent',
  '知识库',
  '知识库/改编知识',
  '知识库/剧作知识',
  '知识库/审查规范',
  '模板库',
];

export const DEFAULT_GLOBAL_FILES: TemplateFile[] = [
  {
    path: 'Agent 配置/AGENTS.md',
    content: systemAgentInstructions(),
  },
  {
    path: 'Agent 配置/config.toml',
    content: '# viwork agent runtime\n[viwork]\nmax_revision_rounds = 5\n',
  },
  ...globalSkillFiles(),
  {
    path: '知识库/改编知识/小说改编原则.md',
    content: '# 小说改编原则\n\n## 原则\n\n- 保留核心人物关系和主题\n- 把心理描写外化为行动、对白和场面\n- 合并功能重复的角色和情节\n- 每集建立清晰戏剧任务\n',
  },
  {
    path: '知识库/改编知识/原著拆解参考.md',
    content: '# 原著拆解参考\n\n| 原著元素 | 戏剧功能 | 改编处理 |\n| --- | --- | --- |\n',
  },
  {
    path: '知识库/改编知识/集数切分参考.md',
    content: '# 集数切分参考\n\n| 集数 | 原著章节 | 戏剧任务 | 结尾钩子 |\n| --- | --- | --- | --- |\n',
  },
  {
    path: '知识库/剧作知识/对白风格参考.md',
    content: '# 对白风格参考\n\n## 原则\n\n- 信息短句化\n- 一句一转折\n- 留给演员表演空间\n',
  },
  {
    path: '知识库/剧作知识/场景描写参考.md',
    content: '# 场景描写参考\n\n## 重点\n\n- 只写拍得到的内容\n- 道具先于抒情\n- 动作带出关系\n',
  },
  {
    path: '知识库/剧作知识/节奏控制参考.md',
    content: '# 节奏控制参考\n\n| 段落 | 目标时长 | 作用 |\n| --- | --- | --- |\n',
  },
  {
    path: '知识库/审查规范/版权与署名.md',
    content: '# 版权与署名\n\n## 检查项\n\n- 确认原著授权状态\n- 记录关键改编依据\n- 避免复制大段原文作为剧本对白\n',
  },
  {
    path: '知识库/审查规范/人物一致性.md',
    content: '# 人物一致性\n\n| 角色 | 原著核心 | 剧本表现 | 风险 |\n| --- | --- | --- | --- |\n',
  },
  {
    path: '知识库/审查规范/剧情忠实度.md',
    content: '# 剧情忠实度\n\n| 改编点 | 是否保留原意 | 变更理由 |\n| --- | --- | --- |\n',
  },
  {
    path: '模板库/原著分析模板.md',
    content: '# 原著分析模板\n\n## 核心主题\n\n## 主线事件\n\n## 人物关系\n\n## 可影视化场面\n',
  },
  {
    path: '模板库/改编方案模板.md',
    content: '# 改编方案模板\n\n## 改编定位\n\n## 集数规划\n\n## 角色合并与调整\n\n## 关键场面保留\n',
  },
  {
    path: '模板库/剧本文档模板.md',
    content: '# 剧本文档模板\n\n## 本集定位\n\n## 场次列表\n\n## 正文\n\n## 原著对应关系\n',
  },
];

export const GLOBAL_WORKSPACE_TREE: WorkspaceTreeNode[] = [
  {
    name: 'Agent 配置',
    path: 'Agent 配置',
    type: 'directory',
    children: [
      { name: 'AGENTS.md', path: 'Agent 配置/AGENTS.md', type: 'file' },
      { name: 'config.toml', path: 'Agent 配置/config.toml', type: 'file' },
      {
        name: 'skills',
        path: 'Agent 配置/skills',
        type: 'directory',
        children: [
          skillNode('brainstorm-agent'),
          skillNode('source-analyst-agent'),
          skillNode('adaptation-planner-agent'),
          skillNode('screenwriter-agent'),
          skillNode('reviewer-agent'),
        ],
      },
    ],
  },
  {
    name: '知识库',
    path: '知识库',
    type: 'directory',
    children: [
      directoryNode('知识库/改编知识', '改编知识', ['小说改编原则.md', '原著拆解参考.md', '集数切分参考.md']),
      directoryNode('知识库/剧作知识', '剧作知识', ['对白风格参考.md', '场景描写参考.md', '节奏控制参考.md']),
      directoryNode('知识库/审查规范', '审查规范', ['版权与署名.md', '人物一致性.md', '剧情忠实度.md']),
    ],
  },
  {
    name: '模板库',
    path: '模板库',
    type: 'directory',
    children: ['原著分析模板.md', '改编方案模板.md', '剧本文档模板.md'].map((name) => ({
      name,
      path: `模板库/${name}`,
      type: 'file',
    })),
  },
];

export const DEFAULT_DIRECTORIES = [
  '01 原著资料',
  '02 改编方案',
  '02 改编方案/01 第一集',
  '02 改编方案/02 第二集',
  '03 剧本',
  '03 剧本/01 第一集',
  '03 剧本/02 第二集',
];

export const DEFAULT_ADAPTATION_FILES: TemplateFile[] = [
  {
    path: '01 原著资料/项目简介.md',
    content: '# {{topic}}\n\n## 一句话定位\n\n围绕{{topic}}展开的小说改编剧本项目。\n\n## 原著来源\n\n- \n\n## 改编目标\n\n- \n\n## 目标观众\n\n- \n',
  },
  {
    path: '01 原著资料/原著梗概.md',
    content: '# 原著梗概\n\n## 故事背景\n\n## 主线剧情\n\n## 关键转折\n\n## 结局状态\n',
  },
  {
    path: '01 原著资料/人物关系.md',
    content: '# 人物关系\n\n| 角色 | 原著身份 | 核心欲望 | 关系变化 | 改编备注 |\n| --- | --- | --- | --- | --- |\n| 主角 |  |  |  |  |\n',
  },
  {
    path: '01 原著资料/章节拆解.md',
    content: '# 章节拆解\n\n| 原著章节 | 关键事件 | 人物变化 | 可影视化场面 |\n| --- | --- | --- | --- |\n',
  },
  {
    path: '01 原著资料/世界观与场景.md',
    content: '# 世界观与场景\n\n| 场景 | 原著功能 | 剧本呈现 | 视觉重点 |\n| --- | --- | --- | --- |\n',
  },
  {
    path: '01 原著资料/改编边界.md',
    content: '# 改编边界\n\n## 必须保留\n\n## 可以调整\n\n## 禁止改动\n\n## 授权与署名\n',
  },
  {
    path: '02 改编方案/全季改编方案.md',
    content: '# 全季改编方案\n\n## 改编定位\n\n## 主线重组\n\n## 角色弧光\n\n## 集数规划\n\n| 集数 | 原著范围 | 剧情任务 | 结尾钩子 |\n| --- | --- | --- | --- |\n',
  },
  ...episodeStoryFiles('01 第一集'),
  ...episodeStoryFiles('02 第二集'),
  ...episodeScriptFiles('01 第一集'),
  ...episodeScriptFiles('02 第二集'),
];

export const PROMPT_SUGGESTIONS = [
  '分析这部小说，提炼适合改编的主线和人物关系',
  '把原著前十章拆成三集改编方案并过审',
  '把第一集改编方案写成标准剧本',
  '审一下第一集剧本，检查忠实度和可拍性',
  '先讨论几个改编方向，只留在聊天里',
];

export function createDefaultWorkspaceFiles(topic: string): TemplateFile[] {
  return DEFAULT_ADAPTATION_FILES.map((file) => ({
    ...file,
    content: file.content.replace('{{topic}}', topic),
  }));
}

export const DEFAULT_SITCOM_FILES = DEFAULT_ADAPTATION_FILES;

export function createDefaultGlobalWorkspaceFiles(): TemplateFile[] {
  return DEFAULT_GLOBAL_FILES.map((file) => ({ ...file }));
}

function skillNode(name: string): WorkspaceTreeNode {
  return {
    name,
    path: `Agent 配置/skills/${name}`,
    type: 'directory',
    children: [{ name: 'SKILL.md', path: `Agent 配置/skills/${name}/SKILL.md`, type: 'file' }],
  };
}

function globalSkillFiles(): TemplateFile[] {
  return Object.entries({
    'brainstorm-agent': brainstormAgentSkill(),
    'source-analyst-agent': sourceAnalystAgentSkill(),
    'adaptation-planner-agent': adaptationPlannerAgentSkill(),
    'screenwriter-agent': screenwriterAgentSkill(),
    'reviewer-agent': reviewerAgentSkill(),
  }).map(([name, content]) => ({
    path: `Agent 配置/skills/${name}/SKILL.md`,
    content,
  }));
}

function skillFrontmatter(name: string, description: string, shortDescription: string): string {
  return [
    '---',
    `name: ${yamlString(name)}`,
    `description: ${yamlString(description)}`,
    'metadata:',
    `  short-description: ${yamlString(shortDescription)}`,
    '---',
    '',
  ].join('\n');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function systemAgentInstructions(): string {
  return `# viwork system agent

你是 viwork 小说改编剧本工作台的 system agent。你的职责不是亲自完成所有创作，而是路由 brainstorm-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent，并监督 reviewer-agent 形成正式改编质量闭环。

## 总目标

- 围绕小说改编剧本创作，产出达标的原著分析、分集改编方案和可拍摄剧本。
- 所有输出默认使用中文。
- 脑暴只是和人类正常交流、探索改编方向；不进入审稿、不自动返工、不受返工上限限制，除非用户明确要求保存，否则不写入项目文件。
- 原著分析、改编方案和剧本通过 reviewer-agent 后，自动写入对应项目文件。
- 返工上限以后端 prompt 中给出的“当前全局返工上限”为准；没有给出时缺省为 5。

## 默认流程

1. 用户只是在探索想法时，使用 brainstorm-agent 正常对话，结果仅在聊天中展示；脑暴不调用 reviewer-agent，不输出轮次，不进入质量闭环。
2. 用户提供或引用原著内容后，使用 source-analyst-agent 拆解主题、主线、人物关系、关键场面和改编边界，然后使用 reviewer-agent 审原著分析。
3. 原著分析审稿打回时，把不合格项交回 source-analyst-agent 返工。
4. 原著分析通过后，如用户要求分集或方案，使用 adaptation-planner-agent 产出全季或单集改编方案，再用 reviewer-agent 审改编方案。
5. 改编方案通过后，如用户要求剧本或任务目标包含剧本，使用 screenwriter-agent 写剧本，再用 reviewer-agent 审剧本。
6. 剧本审稿打回时，判断问题源自剧本执行、改编方案还是原著理解，分别交回 screenwriter-agent、adaptation-planner-agent 或 source-analyst-agent。
7. 按当前全局返工上限控制返工次数；达到上限仍不通过时停止，并说明阻塞原因。

不要把“路由完成”“准备调用某 agent”“先检查可用工具”等内部判断单独回复给用户。不要调用 \`update_plan\` 或维护内部 TODO/计划；需要说明进度时，直接在普通回复文本中说明。完成意图判断后，必须在同一次回复里直接给出对应 agent 的实质内容；脑暴请求尤其要直接进入设定讨论、候选方向或追问。

## 正式产物路径

- 原著分析：\`01 原著资料/章节拆解.md\`、\`01 原著资料/人物关系.md\` 或用户指定路径
- 改编方案：\`02 改编方案/全季改编方案.md\`、\`02 改编方案/<集数>/单集改编方案.md\`
- 剧本：\`03 剧本/<集数>/剧本.md\`

## 图片工具使用协议

调用 generate_project_image 或 edit_project_image 之前，必须先在回复中向用户展示将使用的提示词（prompt）、图片比例、生成数量、预计保存路径；编辑时还需说明基于哪张原图和修改要点。展示后等待用户明确同意再调用工具。用户未确认或要求调整时，先修改方案再重新展示，不要自行调用。

## Trace JSON

正式原著分析、改编方案、剧本创作和审稿时，你必须在关键节点输出独立 JSON block，供系统解析并展示 timeline。脑暴对话不需要输出 trace JSON。格式如下：

\`\`\`json
{"type":"agent.step.start","agentId":"adaptation-planner-agent","phase":"改编方案","iteration":1,"maxIterations":5}
\`\`\`

\`\`\`json
{"type":"agent.step.end","agentId":"adaptation-planner-agent","phase":"改编方案","iteration":1,"maxIterations":5,"status":"passed"}
\`\`\`

\`\`\`json
{"type":"agent.review.reject","targetAgentId":"adaptation-planner-agent","iteration":1,"maxIterations":5,"reasons":["原著范围不清晰","本集戏剧任务不具体"]}
\`\`\`

\`\`\`json
{"type":"agent.workflow.end","status":"passed","outputPath":"02 改编方案/01 第一集/单集改编方案.md"}
\`\`\`

允许的 agentId：system、brainstorm-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent、reviewer-agent。
允许的 phase：脑暴、原著分析、原著审稿、改编方案、方案审稿、编剧、剧本审稿、保存结果。
允许的状态：passed、rejected、failed、stopped。
每个带 iteration 的 trace block 都应同时带 maxIterations；默认是 5，除非 config.toml 改了返工上限。
`;
}

function brainstormAgentSkill(): string {
  return `${skillFrontmatter(
    'brainstorm-agent',
    'Use for novel adaptation brainstorming: explore adaptation angles, target format, tone, episode strategy, character focus, and risks through normal conversation without formal review or project-file writes unless explicitly requested.',
    'Brainstorm adaptation directions',
  )}# brainstorm-agent

你是小说改编脑暴 agent，只负责和人类正常交流、探索改编方向，不负责审稿、返工闭环或写入正式项目文件。

## 输入

- 用户的一句话改编想法、原著名称、题材、人物、场景、冲突或情绪。
- 项目已有原著资料和改编边界，如果 system agent 提供。

## 输出

- 3 到 5 个候选改编方向。
- 每个方向包含：改编定位、主视角、集数/篇幅建议、人物取舍、潜在风险。
- 推荐其中一个最值得进入 source-analyst-agent 的方向。

## 约束

- 不写正式原著分析、改编方案或剧本。
- 不写项目文件，除非用户明确要求保存到指定路径。
- 不调用 reviewer-agent，不输出轮次，不受返工上限限制。
- 不要在没有授权或原文引用边界的情况下复述大段原著文本。

## 图片工具使用协议

调用 generate_project_image 或 edit_project_image 之前，必须先向用户展示提示词方案并等待确认后再调用。
`;
}

function sourceAnalystAgentSkill(): string {
  return `${skillFrontmatter(
    'source-analyst-agent',
    'Use for formal novel source analysis: extract theme, plot spine, character relationships, scene assets, adaptation boundaries, and episode-ready dramatic material from provided source material.',
    'Analyze novel source',
  )}# source-analyst-agent

你是小说原著分析 agent。你的目标是把用户提供或引用的小说资料拆解成可改编为剧本的结构化依据。

## 好原著分析标准

- 明确原著核心主题、主线目标和主要阻力。
- 拆出关键人物关系、欲望、秘密、转变和不可改动点。
- 标出可影视化的场面、动作、冲突和视觉元素。
- 识别需要外化的心理描写、旁白信息和内心独白。
- 记录章节或段落到改编单元的对应关系。
- 标出版权、署名、敏感内容和大段原文复用风险。

## 输出格式

# 原著分析

## 核心主题

## 主线剧情

## 人物关系

## 关键场面

## 可改编单元

## 外化处理建议

## 改编边界与风险

## 图片工具使用协议

调用 generate_project_image 或 edit_project_image 之前，必须先向用户展示提示词方案并等待确认后再调用。
`;
}

function adaptationPlannerAgentSkill(): string {
  return `${skillFrontmatter(
    'adaptation-planner-agent',
    'Use for formal novel adaptation planning: convert accepted source analysis into season outlines, episode plans, scene beats, character adjustments, and source-to-script mapping.',
    'Plan novel adaptation',
  )}# adaptation-planner-agent

你是小说改编方案 agent。你的目标是把已成立的原著分析转换为可执行的全季或单集改编方案。

## 好改编方案标准

- 每集有明确原著范围、戏剧任务、主角行动和结尾钩子。
- 改编取舍有理由，不随意抛弃原著主题和关键人物关系。
- 心理活动被转换为可拍摄的行动、选择、对白和场面。
- 角色合并、情节重排和时间线调整保持因果清楚。
- 每集容量适合剧本长度，不把小说摘要直接塞进场次。
- 明确哪些内容交给 screenwriter-agent 写成剧本，哪些暂不进入本集。

## 输出格式

# 改编方案

## 改编定位

## 原著范围

## 分集规划

| 集数 | 原著范围 | 戏剧任务 | 角色变化 | 结尾钩子 |
| --- | --- | --- | --- | --- |

## 单集节拍

## 角色与情节取舍

## 原著对应关系

## 图片工具使用协议

调用 generate_project_image 或 edit_project_image 之前，必须先向用户展示提示词方案并等待确认后再调用。
`;
}

function screenwriterAgentSkill(): string {
  return `${skillFrontmatter(
    'screenwriter-agent',
    'Use for novel adaptation scriptwriting: convert an accepted adaptation plan into a shootable script with scenes, actions, dialogue, pacing, and source mapping.',
    'Write adaptation scripts',
  )}# screenwriter-agent

你是小说改编编剧 agent。你的目标是把已经通过的改编方案转换为可拍摄、可表演的剧本。

## 好剧本标准

- 每场戏有清楚的场景目标。
- 每场戏有冲突、对抗、隐瞒、选择或信息差。
- 没有只解释背景、只复述原文、只聊天的废场。
- 对白符合角色身份、关系和当下目的。
- 台词有潜台词，不总是直接说真实意图。
- 动作和调度可拍摄，不依赖抽象心理描写。
- 忠实服务已通过的改编方案和原著核心。
- 重要改编处能标出原著对应关系或变更理由。

## 输出格式

# 第 X 集《标题》

## 冷开场

### 场景 1：地点 / 时间

动作：

角色A：

角色B：

节拍：

原著对应：

## 正戏

### 场景 2：地点 / 时间

动作：

角色A：

角色B：

节拍：

原著对应：

## 结尾

## 图片工具使用协议

调用 generate_project_image 或 edit_project_image 之前，必须先向用户展示提示词方案并等待确认后再调用。
`;
}

function reviewerAgentSkill(): string {
  return `${skillFrontmatter(
    'reviewer-agent',
    'Use for strict novel adaptation review: judge whether source analysis, adaptation plans, or scripts pass quality gates, identify concrete failures, and specify the target agent for revision.',
    'Review adaptation quality',
  )}# reviewer-agent

你是小说改编质量闸门。你只判断是否达标，像甲方验收一样严格挑刺。

## 规则

- 只保留两个结论：通过 / 打回。
- 不输出鼓励语。
- 不做温和润色建议。
- 不直接替作者改稿。
- 必须指出不符合要求的地方。

## 原著分析审查

- 是否明确主题、主线和关键人物关系。
- 是否区分原著事实、推断和改编建议。
- 是否标出可影视化场面和需要外化的信息。
- 是否记录改编边界、授权和大段原文复用风险。

## 改编方案审查

- 原著范围是否清晰。
- 每集戏剧任务是否具体。
- 人物取舍和情节重排是否有理由。
- 心理描写是否被转换为可拍摄行动。
- 结尾钩子是否成立且不背离原著核心。

## 剧本审查

- 每场戏是否有目标和冲突。
- 是否存在废场、废话、无效桥段。
- 对白是否可表演且有角色差异。
- 动作是否可拍摄。
- 是否破坏已通过的改编方案和原著核心。
- 是否存在过度复述原文、旁白依赖或心理描写无法拍摄的问题。

## 输出格式

结论：通过 / 打回
打回对象：source-analyst-agent / adaptation-planner-agent / screenwriter-agent / none
不合格项：
1. ...
2. ...
返工要求：
1. ...
2. ...

## 图片工具使用协议

调用 generate_project_image 或 edit_project_image 之前，必须先向用户展示提示词方案并等待确认后再调用。
`;
}

function directoryNode(path: string, name: string, files: string[]): WorkspaceTreeNode {
  return {
    name,
    path,
    type: 'directory',
    children: files.map((file) => ({ name: file, path: `${path}/${file}`, type: 'file' })),
  };
}

function episodeStoryFiles(episode: string): TemplateFile[] {
  return [
    {
      path: `02 改编方案/${episode}/单集改编方案.md`,
      content: `# ${episode}单集改编方案\n\n## 原著范围\n\n## 本集定位\n\n## 戏剧任务\n\n## 主要人物变化\n\n## 场次节拍\n\n## 结尾钩子\n\n## 原著对应关系\n`,
    },
    {
      path: `02 改编方案/${episode}/场次节拍.md`,
      content: `# ${episode}场次节拍\n\n| 场次 | 原著依据 | 戏剧目的 | 冲突/信息 |\n| --- | --- | --- | --- |\n`,
    },
    {
      path: `02 改编方案/${episode}/人物调整.md`,
      content: `# ${episode}人物调整\n\n| 角色 | 原著状态 | 本集调整 | 调整理由 |\n| --- | --- | --- | --- |\n`,
    },
    {
      path: `02 改编方案/${episode}/原著对应表.md`,
      content: `# ${episode}原著对应表\n\n| 剧本内容 | 原著章节/段落 | 保留/改动 | 理由 |\n| --- | --- | --- | --- |\n`,
    },
  ];
}

function episodeScriptFiles(episode: string): TemplateFile[] {
  return [
    {
      path: `03 剧本/${episode}/剧本.md`,
      content: `# ${episode}剧本\n\n## 本集定位\n\n## 冷开场\n\n### 场景 1：地点 / 时间\n\n动作：\n\n角色A：\n\n角色B：\n\n节拍：\n\n原著对应：\n\n## 正戏\n\n### 场景 2：地点 / 时间\n\n动作：\n\n角色A：\n\n角色B：\n\n节拍：\n\n原著对应：\n\n## 结尾\n`,
    },
    {
      path: `03 剧本/${episode}/修改记录.md`,
      content: `# ${episode}修改记录\n\n| 时间 | 修改点 | 原因 |\n| --- | --- | --- |\n`,
    },
  ];
}

function shotFiles(episode: string, shot: string): TemplateFile[] {
  const basePath = `04 分镜脚本/${episode}/${shot}`;
  return [
    {
      path: `${basePath}/分镜脚本.md`,
      content: `# ${episode}${shot}分镜脚本\n\n| 镜头 | 景别 | 画面 | 台词/声音 | 时长 |\n| --- | --- | --- | --- | --- |\n`,
    },
    {
      path: `${basePath}/依赖人物视图.md`,
      content: `# ${episode}${shot}依赖人物视图\n\n| 角色 | 表情 | 服装 | 动作 |\n| --- | --- | --- | --- |\n`,
    },
    {
      path: `${basePath}/依赖场景视图.md`,
      content: `# ${episode}${shot}依赖场景视图\n\n| 场景 | 布置 | 道具 | 注意事项 |\n| --- | --- | --- | --- |\n`,
    },
  ];
}

function videoFiles(episode: string, shot: string): TemplateFile[] {
  const basePath = `05 视频/${episode}/${shot}`;
  return [
    {
      path: `${basePath}/视频生成提示词.md`,
      content: `# ${episode}${shot}视频生成提示词\n\n## 首帧\n\n## 尾帧\n\n## 运镜\n\n## 负面提示词\n`,
    },
    {
      path: `${basePath}/生成参数.md`,
      content: `# ${episode}${shot}生成参数\n\n| 参数 | 值 |\n| --- | --- |\n| 时长 |  |\n| 画幅 |  |\n| 模型 |  |\n`,
    },
    {
      path: `${basePath}/生成结果记录.md`,
      content: `# ${episode}${shot}生成结果记录\n\n| 版本 | 结果 | 问题 | 是否采用 |\n| --- | --- | --- | --- |\n`,
    },
  ];
}

function deliverableFiles(episode: string): TemplateFile[] {
  return [
    {
      path: `06 产物/${episode}/素材清单.md`,
      content: `# ${episode}素材清单\n\n| 素材 | 类型 | 来源 | 状态 |\n| --- | --- | --- | --- |\n`,
    },
    {
      path: `06 产物/${episode}/剪辑顺序.md`,
      content: `# ${episode}剪辑顺序\n\n| 顺序 | 片段 | 时长 | 备注 |\n| --- | --- | --- | --- |\n`,
    },
    {
      path: `06 产物/${episode}/音效字幕.md`,
      content: `# ${episode}音效字幕\n\n| 时间点 | 音效/字幕 | 内容 |\n| --- | --- | --- |\n`,
    },
    {
      path: `06 产物/${episode}/成片记录.md`,
      content: `# ${episode}成片记录\n\n| 版本 | 导出时间 | 问题 | 备注 |\n| --- | --- | --- | --- |\n`,
    },
  ];
}
