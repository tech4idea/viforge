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
  'Agent 配置/skills/人物设定技能',
  'Agent 配置/skills/故事大纲技能',
  'Agent 配置/skills/剧本改写技能',
  'Agent 配置/skills/分镜拆解技能',
  'Agent 配置/skills/视频生成提示词技能',
  '知识库',
  '知识库/编剧知识',
  '知识库/写作知识',
  '知识库/素材库',
  '模板库',
];

export const DEFAULT_GLOBAL_FILES: TemplateFile[] = [
  {
    path: 'Agent 配置/AGENTS.md',
    content: '# 情景剧创作工作区\n\n## 工作目标\n\n围绕角色、故事、剧本、分镜和视频生成推进情景剧创作。\n\n## 协作约束\n\n- 所有输出默认使用中文\n- 优先复用模板库与知识库\n- 修改项写入对应项目目录\n',
  },
  ...globalSkillFiles(),
  {
    path: '知识库/编剧知识/情景剧结构参考.md',
    content: '# 情景剧结构参考\n\n## 常见结构\n\n- 冷开场\n- 主冲突建立\n- 误会升级\n- 反转收束\n',
  },
  {
    path: '知识库/编剧知识/角色关系参考.md',
    content: '# 角色关系参考\n\n| 关系 | 典型张力 | 适用场景 |\n| --- | --- | --- |\n',
  },
  {
    path: '知识库/编剧知识/喜剧冲突参考.md',
    content: '# 喜剧冲突参考\n\n| 冲突来源 | 表现方式 | 节奏建议 |\n| --- | --- | --- |\n',
  },
  {
    path: '知识库/写作知识/对白风格参考.md',
    content: '# 对白风格参考\n\n## 原则\n\n- 信息短句化\n- 一句一转折\n- 留给演员表演空间\n',
  },
  {
    path: '知识库/写作知识/场景描写参考.md',
    content: '# 场景描写参考\n\n## 重点\n\n- 只写拍得到的内容\n- 道具先于抒情\n- 动作带出关系\n',
  },
  {
    path: '知识库/写作知识/节奏控制参考.md',
    content: '# 节奏控制参考\n\n| 段落 | 目标时长 | 作用 |\n| --- | --- | --- |\n',
  },
  {
    path: '知识库/素材库/网络热梗库.md',
    content: '# 网络热梗库\n\n| 热梗 | 适用角色 | 使用限制 |\n| --- | --- | --- |\n',
  },
  {
    path: '知识库/素材库/职场热梗库.md',
    content: '# 职场热梗库\n\n| 热梗 | 场景 | 风险 |\n| --- | --- | --- |\n',
  },
  {
    path: '知识库/素材库/生活热梗库.md',
    content: '# 生活热梗库\n\n| 热梗 | 使用方式 | 备注 |\n| --- | --- | --- |\n',
  },
  {
    path: '模板库/人物小传模板.md',
    content: '# 人物小传模板\n\n## 基本信息\n\n## 表层目标\n\n## 隐藏需求\n\n## 喜剧缺点\n',
  },
  {
    path: '模板库/单集大纲模板.md',
    content: '# 单集大纲模板\n\n## 主题\n\n## A 故事\n\n## B 故事\n\n## 结尾反转\n',
  },
  {
    path: '模板库/剧本文档模板.md',
    content: '# 剧本文档模板\n\n## 冷开场\n\n## 第一场\n\n## 第二场\n\n## 结尾\n',
  },
  {
    path: '模板库/分镜脚本模板.md',
    content: '# 分镜脚本模板\n\n| 镜头 | 景别 | 画面 | 台词/声音 | 时长 |\n| --- | --- | --- | --- | --- |\n',
  },
  {
    path: '模板库/视频提示词模板.md',
    content: '# 视频提示词模板\n\n## 首帧\n\n## 尾帧\n\n## 运镜\n\n## 负面提示词\n',
  },
];

export const GLOBAL_WORKSPACE_TREE: WorkspaceTreeNode[] = [
  {
    name: 'Agent 配置',
    path: 'Agent 配置',
    type: 'directory',
    children: [
      { name: 'AGENTS.md', path: 'Agent 配置/AGENTS.md', type: 'file' },
      {
        name: 'skills',
        path: 'Agent 配置/skills',
        type: 'directory',
        children: [
          skillNode('人物设定技能'),
          skillNode('故事大纲技能'),
          skillNode('剧本改写技能'),
          skillNode('分镜拆解技能'),
          skillNode('视频生成提示词技能'),
        ],
      },
    ],
  },
  {
    name: '知识库',
    path: '知识库',
    type: 'directory',
    children: [
      directoryNode('知识库/编剧知识', '编剧知识', ['情景剧结构参考.md', '角色关系参考.md', '喜剧冲突参考.md']),
      directoryNode('知识库/写作知识', '写作知识', ['对白风格参考.md', '场景描写参考.md', '节奏控制参考.md']),
      directoryNode('知识库/素材库', '素材库', ['网络热梗库.md', '职场热梗库.md', '生活热梗库.md']),
    ],
  },
  {
    name: '模板库',
    path: '模板库',
    type: 'directory',
    children: ['人物小传模板.md', '单集大纲模板.md', '剧本文档模板.md', '分镜脚本模板.md', '视频提示词模板.md'].map((name) => ({
      name,
      path: `模板库/${name}`,
      type: 'file',
    })),
  },
];

export const DEFAULT_DIRECTORIES = [
  '01 基本设定',
  '02 故事',
  '02 故事/01 第一集',
  '02 故事/02 第二集',
  '03 剧本',
  '03 剧本/01 第一集',
  '03 剧本/02 第二集',
  '04 分镜脚本',
  '04 分镜脚本/01 第一集',
  '04 分镜脚本/01 第一集/01 第一分镜',
  '04 分镜脚本/01 第一集/02 第二分镜',
  '04 分镜脚本/02 第二集',
  '05 视频',
  '05 视频/01 第一集',
  '05 视频/01 第一集/01 第一分镜',
  '05 视频/01 第一集/02 第二分镜',
  '05 视频/02 第二集',
  '06 产物',
  '06 产物/01 第一集',
  '06 产物/02 第二集',
];

export const DEFAULT_SITCOM_FILES: TemplateFile[] = [
  {
    path: '01 基本设定/项目简介.md',
    content: '# {{topic}}\n\n## 一句话定位\n\n围绕{{topic}}展开的情景剧项目。\n\n## 核心看点\n\n- \n\n## 目标观众\n\n- \n',
  },
  {
    path: '01 基本设定/世界观设定.md',
    content: '# 世界观设定\n\n## 时间与地点\n\n## 日常规则\n\n## 不可违背的设定\n',
  },
  {
    path: '01 基本设定/人物设定.md',
    content: '# 人物设定\n\n| 角色 | 身份 | 欲望 | 缺点 | 喜剧来源 |\n| --- | --- | --- | --- | --- |\n| 主角 |  |  |  |  |\n',
  },
  {
    path: '01 基本设定/角色关系.md',
    content: '# 角色关系\n\n| 角色 A | 角色 B | 关系 | 常见冲突 |\n| --- | --- | --- | --- |\n',
  },
  {
    path: '01 基本设定/场景设定.md',
    content: '# 场景设定\n\n| 场景 | 功能 | 可反复使用的喜剧机关 |\n| --- | --- | --- |\n',
  },
  {
    path: '01 基本设定/风格约束.md',
    content: '# 风格约束\n\n## 语言风格\n\n## 节奏要求\n\n## 禁用内容\n',
  },
  {
    path: '02 故事/整季故事线.md',
    content: '# 整季故事线\n\n## 主线\n\n## 角色成长\n\n## 集数规划\n\n| 集数 | 主题 | 冲突 | 结尾钩子 |\n| --- | --- | --- | --- |\n',
  },
  ...episodeStoryFiles('01 第一集'),
  ...episodeStoryFiles('02 第二集'),
  ...episodeScriptFiles('01 第一集'),
  ...episodeScriptFiles('02 第二集'),
  {
    path: '04 分镜脚本/01 第一集/镜头清单.md',
    content: '# 第一集镜头清单\n\n| 镜头 | 场景 | 内容 | 依赖素材 |\n| --- | --- | --- | --- |\n',
  },
  ...shotFiles('01 第一集', '01 第一分镜'),
  ...shotFiles('01 第一集', '02 第二分镜'),
  {
    path: '04 分镜脚本/02 第二集/镜头清单.md',
    content: '# 第二集镜头清单\n\n| 镜头 | 场景 | 内容 | 依赖素材 |\n| --- | --- | --- | --- |\n',
  },
  ...videoFiles('01 第一集', '01 第一分镜'),
  ...videoFiles('01 第一集', '02 第二分镜'),
  ...deliverableFiles('01 第一集'),
  ...deliverableFiles('02 第二集'),
];

export const PROMPT_SUGGESTIONS = [
  '根据题材生成 3 集情景剧大纲',
  '完善主角和反派的人物设定',
  '把这一场改得更有冲突',
  '把剧本拆成分镜表',
  '整理需要生成的视频素材清单',
];

export function createDefaultWorkspaceFiles(topic: string): TemplateFile[] {
  return DEFAULT_SITCOM_FILES.map((file) => ({
    ...file,
    content: file.content.replace('{{topic}}', topic),
  }));
}

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
  return [
    ['人物设定技能', '# 人物设定技能\n\n根据项目设定补全人物身份、缺点、欲望和喜剧来源。\n'],
    ['故事大纲技能', '# 故事大纲技能\n\n围绕单集主题输出 A/B 故事与结尾反转。\n'],
    ['剧本改写技能', '# 剧本改写技能\n\n对现有剧本做节奏、冲突和对白上的局部改写。\n'],
    ['分镜拆解技能', '# 分镜拆解技能\n\n把剧本文本拆成镜头清单和逐镜头描述。\n'],
    ['视频生成提示词技能', '# 视频生成提示词技能\n\n根据分镜脚本整理视频模型可用的提示词。\n'],
  ].map(([name, content]) => ({
    path: `Agent 配置/skills/${name}/SKILL.md`,
    content,
  }));
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
      path: `02 故事/${episode}/单集大纲.md`,
      content: `# ${episode}单集大纲\n\n## 主题\n\n## A 故事\n\n## B 故事\n\n## 结尾反转\n`,
    },
    {
      path: `02 故事/${episode}/情节卡片.md`,
      content: `# ${episode}情节卡片\n\n| 序号 | 情节 | 作用 | 关联角色 |\n| --- | --- | --- | --- |\n`,
    },
    {
      path: `02 故事/${episode}/冲突设计.md`,
      content: `# ${episode}冲突设计\n\n| 冲突 | 发起者 | 阻力 | 升级方式 | 笑点 |\n| --- | --- | --- | --- | --- |\n`,
    },
  ];
}

function episodeScriptFiles(episode: string): TemplateFile[] {
  return [
    {
      path: `03 剧本/${episode}/第一版剧本.md`,
      content: `# ${episode}第一版剧本\n\n## 冷开场\n\n## 第一场\n\n## 第二场\n\n## 结尾\n`,
    },
    {
      path: `03 剧本/${episode}/定稿剧本.md`,
      content: `# ${episode}定稿剧本\n\n`,
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
