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
  '知识库',
  '知识库/改编知识',
  '知识库/剧作知识',
  '知识库/审查规范',
  '模板库',
];

export const DEFAULT_GLOBAL_FILES: TemplateFile[] = [
  {
    path: 'Agent 配置/config.toml',
    content: '# viforge agent runtime\n[viforge]\nmax_revision_rounds = 5\n',
  },
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
      { name: 'config.toml', path: 'Agent 配置/config.toml', type: 'file' },
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
