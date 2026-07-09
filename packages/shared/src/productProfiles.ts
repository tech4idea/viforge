import {
  DEFAULT_ADAPTATION_FILES,
  DEFAULT_DIRECTORIES,
  DEFAULT_GLOBAL_DIRECTORIES,
  DEFAULT_GLOBAL_FILES,
  GLOBAL_WORKSPACE_TREE,
  type TemplateFile,
  type WorkspaceTreeNode,
} from './templates';
import novelAdaptationProfileConfig from './product-profiles/novel-adaptation/profile.json';
import sitcomProfileConfig from './product-profiles/sitcom/profile.json';
import studyProfileConfig from './product-profiles/study/profile.json';

export type ProductProfileId = 'novel-adaptation' | 'sitcom' | 'study';

export type ProductProfile = {
  id: ProductProfileId;
  name: string;
  documentTitle: string;
  defaultProjectName: string;
  defaultProjectDescription: string;
  workspaceSections: {
    global: { title: string; description: string };
    project: { title: string; description: string; emptyText: string };
  };
  promptPlaceholder: {
    archived: string;
    project: string;
    temporary: string;
  };
  defaultSkillDraft: {
    title: string;
    description: string;
    prompt: string;
  };
  promptSuggestions: string[];
  globalDirectories: string[];
  globalFiles: TemplateFile[];
  globalTree: WorkspaceTreeNode[];
  projectDirectories: string[];
  projectFiles: TemplateFile[];
  defaultAgentSkillNames: string[];
  agentLabels: Record<string, string>;
  mastra: {
    requestTitle: string;
    systemIntro: string[];
    fallbackProtocol: string;
    summaryInstructions?: string;
  };
  artifactPaths: {
    sourceAnalysis?: string[];
    plan?: string[];
    script: string;
  };
};

type ProductProfileConfig = Omit<ProductProfile, 'globalDirectories' | 'globalFiles' | 'globalTree' | 'projectDirectories' | 'projectFiles'>;

export const novelAdaptationProfile: ProductProfile = {
  ...(novelAdaptationProfileConfig as ProductProfileConfig),
  globalDirectories: DEFAULT_GLOBAL_DIRECTORIES,
  globalFiles: DEFAULT_GLOBAL_FILES,
  globalTree: GLOBAL_WORKSPACE_TREE,
  projectDirectories: DEFAULT_DIRECTORIES,
  projectFiles: DEFAULT_ADAPTATION_FILES,
};

const sitcomGlobalDirectories = [
  'Agent 配置',
  '知识库',
  '知识库/编剧知识',
  '知识库/写作知识',
  '知识库/素材库',
  '模板库',
];

const sitcomProjectDirectories = [
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

const sitcomGlobalFiles: TemplateFile[] = [
  {
    path: 'Agent 配置/config.toml',
    content: '# viforge agent runtime\n[viforge]\nmax_revision_rounds = 5\n',
  },
  { path: '知识库/编剧知识/情景剧结构参考.md', content: '# 情景剧结构参考\n\n## 常见结构\n\n- 冷开场\n- 主冲突建立\n- 误会升级\n- 反转收束\n' },
  { path: '知识库/编剧知识/角色关系参考.md', content: '# 角色关系参考\n\n| 关系 | 典型张力 | 适用场景 |\n| --- | --- | --- |\n' },
  { path: '知识库/编剧知识/喜剧冲突参考.md', content: '# 喜剧冲突参考\n\n| 冲突来源 | 表现方式 | 节奏建议 |\n| --- | --- | --- |\n' },
  { path: '知识库/写作知识/对白风格参考.md', content: '# 对白风格参考\n\n## 原则\n\n- 信息短句化\n- 一句一转折\n- 留给演员表演空间\n' },
  { path: '知识库/写作知识/场景描写参考.md', content: '# 场景描写参考\n\n## 重点\n\n- 只写拍得到的内容\n- 道具先于抒情\n- 动作带出关系\n' },
  { path: '知识库/写作知识/节奏控制参考.md', content: '# 节奏控制参考\n\n| 段落 | 目标时长 | 作用 |\n| --- | --- | --- |\n' },
  { path: '知识库/素材库/网络热梗库.md', content: '# 网络热梗库\n\n| 热梗 | 适用角色 | 使用限制 |\n| --- | --- | --- |\n' },
  { path: '知识库/素材库/职场热梗库.md', content: '# 职场热梗库\n\n| 热梗 | 场景 | 风险 |\n| --- | --- | --- |\n' },
  { path: '知识库/素材库/生活热梗库.md', content: '# 生活热梗库\n\n| 热梗 | 使用方式 | 备注 |\n| --- | --- | --- |\n' },
  { path: '模板库/人物小传模板.md', content: '# 人物小传模板\n\n## 基本信息\n\n## 表层目标\n\n## 隐藏需求\n\n## 喜剧缺点\n' },
  { path: '模板库/单集大纲模板.md', content: '# 单集大纲模板\n\n## 主题\n\n## A 故事\n\n## B 故事\n\n## 结尾反转\n' },
  { path: '模板库/剧本文档模板.md', content: '# 剧本文档模板\n\n## 冷开场\n\n## 第一场\n\n## 第二场\n\n## 结尾\n' },
  { path: '模板库/分镜脚本模板.md', content: '# 分镜脚本模板\n\n| 镜头 | 景别 | 画面 | 台词/声音 | 时长 |\n| --- | --- | --- | --- | --- |\n' },
  { path: '模板库/视频提示词模板.md', content: '# 视频提示词模板\n\n## 首帧\n\n## 尾帧\n\n## 运镜\n\n## 负面提示词\n' },
];

const sitcomGlobalTree: WorkspaceTreeNode[] = [
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
      directoryNode('知识库/编剧知识', '编剧知识', ['情景剧结构参考.md', '角色关系参考.md', '喜剧冲突参考.md']),
      directoryNode('知识库/写作知识', '写作知识', ['对白风格参考.md', '场景描写参考.md', '节奏控制参考.md']),
      directoryNode('知识库/素材库', '素材库', ['网络热梗库.md', '职场热梗库.md', '生活热梗库.md']),
    ],
  },
  { name: '模板库', path: '模板库', type: 'directory', children: ['人物小传模板.md', '单集大纲模板.md', '剧本文档模板.md', '分镜脚本模板.md', '视频提示词模板.md'].map((name) => ({ name, path: `模板库/${name}`, type: 'file' })) },
];

const sitcomProjectFiles: TemplateFile[] = [
  { path: '01 基本设定/项目简介.md', content: '# {{topic}}\n\n## 一句话定位\n\n围绕{{topic}}展开的情景剧项目。\n\n## 核心看点\n\n- \n\n## 目标观众\n\n- \n' },
  { path: '01 基本设定/世界观设定.md', content: '# 世界观设定\n\n## 时间与地点\n\n## 日常规则\n\n## 不可违背的设定\n' },
  { path: '01 基本设定/人物设定.md', content: '# 人物设定\n\n| 角色 | 身份 | 欲望 | 缺点 | 喜剧来源 |\n| --- | --- | --- | --- | --- |\n| 主角 |  |  |  |  |\n' },
  { path: '01 基本设定/角色关系.md', content: '# 角色关系\n\n| 角色 A | 角色 B | 关系 | 常见冲突 |\n| --- | --- | --- | --- |\n' },
  { path: '01 基本设定/场景设定.md', content: '# 场景设定\n\n| 场景 | 功能 | 可反复使用的喜剧机关 |\n| --- | --- | --- |\n' },
  { path: '01 基本设定/风格约束.md', content: '# 风格约束\n\n## 语言风格\n\n## 节奏要求\n\n## 禁用内容\n' },
  { path: '02 故事/整季故事线.md', content: '# 整季故事线\n\n## 主线\n\n## 角色成长\n\n## 集数规划\n\n| 集数 | 主题 | 冲突 | 结尾钩子 |\n| --- | --- | --- | --- |\n' },
  ...sitcomEpisodeStoryFiles('01 第一集'),
  ...sitcomEpisodeStoryFiles('02 第二集'),
  ...sitcomEpisodeScriptFiles('01 第一集'),
  ...sitcomEpisodeScriptFiles('02 第二集'),
  { path: '04 分镜脚本/01 第一集/镜头清单.md', content: '# 第一集镜头清单\n\n| 镜头 | 场景 | 内容 | 依赖素材 |\n| --- | --- | --- | --- |\n' },
  ...sitcomShotFiles('01 第一集', '01 第一分镜'),
  ...sitcomShotFiles('01 第一集', '02 第二分镜'),
  { path: '04 分镜脚本/02 第二集/镜头清单.md', content: '# 第二集镜头清单\n\n| 镜头 | 场景 | 内容 | 依赖素材 |\n| --- | --- | --- | --- |\n' },
  ...sitcomVideoFiles('01 第一集', '01 第一分镜'),
  ...sitcomVideoFiles('01 第一集', '02 第二分镜'),
  ...sitcomDeliverableFiles('01 第一集'),
  ...sitcomDeliverableFiles('02 第二集'),
];

export const sitcomProfile: ProductProfile = {
  ...(sitcomProfileConfig as ProductProfileConfig),
  globalDirectories: sitcomGlobalDirectories,
  globalFiles: sitcomGlobalFiles,
  globalTree: sitcomGlobalTree,
  projectDirectories: sitcomProjectDirectories,
  projectFiles: sitcomProjectFiles,
};

const studyGlobalDirectories = [
  'Agent 配置',
  '知识库',
  '知识库/学习方法',
  '知识库/资料索引',
  '知识库/知识点库',
  '模板库',
];

const studyProjectDirectories = [
  '01 学习目标',
  '02 学习大纲',
  '03 知识点',
  '03 知识点/待学习',
  '03 知识点/已整理',
  '04 资料检索',
  '05 学习笔记',
  '06 复盘与输出',
];

const studyGlobalFiles: TemplateFile[] = [
  {
    path: 'Agent 配置/config.toml',
    content: '# viforge agent runtime\n[viforge]\nmax_revision_rounds = 3\n',
  },
  { path: '知识库/学习方法/学习路径设计.md', content: '# 学习路径设计\n\n## 原则\n\n- 先定义目标产出\n- 再拆分能力模块\n- 每个模块绑定练习和检查点\n' },
  { path: '知识库/学习方法/知识点整理方法.md', content: '# 知识点整理方法\n\n## 推荐结构\n\n- 概念定义\n- 关键问题\n- 例子\n- 常见误区\n- 关联知识\n' },
  { path: '知识库/资料索引/资料来源清单.md', content: '# 资料来源清单\n\n| 来源 | 类型 | 适用主题 | 可信度 | 备注 |\n| --- | --- | --- | --- | --- |\n' },
  { path: '知识库/知识点库/通用知识点索引.md', content: '# 通用知识点索引\n\n| 知识点 | 分类 | 关键词 | 关联资料 |\n| --- | --- | --- | --- |\n' },
  { path: '模板库/学习大纲模板.md', content: '# 学习大纲模板\n\n## 学习目标\n\n## 阶段拆分\n\n| 阶段 | 主题 | 目标 | 练习 | 检查点 |\n| --- | --- | --- | --- | --- |\n' },
  { path: '模板库/知识点卡片模板.md', content: '# 知识点卡片模板\n\n## 定义\n\n## 为什么重要\n\n## 例子\n\n## 易错点\n\n## 关联知识\n' },
  { path: '模板库/资料整理模板.md', content: '# 资料整理模板\n\n| 资料 | 核心观点 | 可引用内容 | 待验证问题 |\n| --- | --- | --- | --- |\n' },
  { path: '模板库/学习复盘模板.md', content: '# 学习复盘模板\n\n## 本轮完成\n\n## 仍不清楚\n\n## 下一步\n' },
];

const studyGlobalTree: WorkspaceTreeNode[] = [
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
      directoryNode('知识库/学习方法', '学习方法', ['学习路径设计.md', '知识点整理方法.md']),
      directoryNode('知识库/资料索引', '资料索引', ['资料来源清单.md']),
      directoryNode('知识库/知识点库', '知识点库', ['通用知识点索引.md']),
    ],
  },
  { name: '模板库', path: '模板库', type: 'directory', children: ['学习大纲模板.md', '知识点卡片模板.md', '资料整理模板.md', '学习复盘模板.md'].map((name) => ({ name, path: `模板库/${name}`, type: 'file' })) },
];

const studyProjectFiles: TemplateFile[] = [
  { path: '01 学习目标/项目简介.md', content: '# {{topic}}\n\n## 学习主题\n\n{{topic}}\n\n## 学习目标\n\n- \n\n## 期望产出\n\n- \n\n## 当前基础\n\n- \n' },
  { path: '01 学习目标/问题清单.md', content: '# 问题清单\n\n| 问题 | 优先级 | 状态 | 备注 |\n| --- | --- | --- | --- |\n' },
  { path: '02 学习大纲/总览.md', content: '# {{topic}}学习大纲\n\n## 学习路径\n\n| 阶段 | 主题 | 目标 | 练习 | 检查点 |\n| --- | --- | --- | --- | --- |\n' },
  { path: '02 学习大纲/阶段计划.md', content: '# 阶段计划\n\n| 周期 | 重点 | 资料 | 任务 | 交付物 |\n| --- | --- | --- | --- | --- |\n' },
  { path: '03 知识点/知识点索引.md', content: '# 知识点索引\n\n| 知识点 | 分类 | 掌握状态 | 关联文件 |\n| --- | --- | --- | --- |\n' },
  { path: '03 知识点/待学习/待整理知识点.md', content: '# 待整理知识点\n\n| 知识点 | 来源 | 需要解决的问题 |\n| --- | --- | --- |\n' },
  { path: '03 知识点/已整理/知识点卡片.md', content: '# 知识点卡片\n\n## 定义\n\n## 关键问题\n\n## 例子\n\n## 易错点\n\n## 关联知识\n' },
  { path: '04 资料检索/搜索记录.md', content: '# 搜索记录\n\n| 查询词 | 结果摘要 | 可用资料 | 下一步 |\n| --- | --- | --- | --- |\n' },
  { path: '04 资料检索/资料整理.md', content: '# 资料整理\n\n| 资料 | 核心观点 | 适用知识点 | 可信度 |\n| --- | --- | --- | --- |\n' },
  { path: '05 学习笔记/课堂笔记.md', content: '# 学习笔记\n\n## 今日主题\n\n## 关键收获\n\n## 待追问\n' },
  { path: '06 复盘与输出/复盘记录.md', content: '# 复盘记录\n\n| 时间 | 完成内容 | 卡点 | 下一步 |\n| --- | --- | --- | --- |\n' },
  { path: '06 复盘与输出/输出作品.md', content: '# 输出作品\n\n## 主题\n\n## 内容\n\n## 证据与引用\n' },
];

export const studyProfile: ProductProfile = {
  ...(studyProfileConfig as ProductProfileConfig),
  globalDirectories: studyGlobalDirectories,
  globalFiles: studyGlobalFiles,
  globalTree: studyGlobalTree,
  projectDirectories: studyProjectDirectories,
  projectFiles: studyProjectFiles,
};

export const PRODUCT_PROFILES = {
  'novel-adaptation': novelAdaptationProfile,
  sitcom: sitcomProfile,
  study: studyProfile,
} satisfies Record<ProductProfileId, ProductProfile>;

export const DEFAULT_PRODUCT_PROFILE_ID: ProductProfileId = 'novel-adaptation';

export function resolveProductProfile(productId?: string | null): ProductProfile {
  if (productId === 'sitcom' || productId === 'novel-adaptation' || productId === 'study') {
    return PRODUCT_PROFILES[productId];
  }
  return PRODUCT_PROFILES[DEFAULT_PRODUCT_PROFILE_ID];
}

export function createDefaultWorkspaceFilesForProfile(profile: ProductProfile, topic: string): TemplateFile[] {
  return profile.projectFiles.map((file) => ({
    ...file,
    content: file.content.replaceAll('{{topic}}', topic),
  }));
}

export function createDefaultGlobalWorkspaceFilesForProfile(profile: ProductProfile): TemplateFile[] {
  return profile.globalFiles.map((file) => ({ ...file }));
}

function directoryNode(path: string, name: string, files: string[]): WorkspaceTreeNode {
  return {
    name,
    path,
    type: 'directory',
    children: files.map((file) => ({ name: file, path: `${path}/${file}`, type: 'file' })),
  };
}

function sitcomEpisodeStoryFiles(episode: string): TemplateFile[] {
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

function sitcomEpisodeScriptFiles(episode: string): TemplateFile[] {
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

function sitcomShotFiles(episode: string, shot: string): TemplateFile[] {
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

function sitcomVideoFiles(episode: string, shot: string): TemplateFile[] {
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

function sitcomDeliverableFiles(episode: string): TemplateFile[] {
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
