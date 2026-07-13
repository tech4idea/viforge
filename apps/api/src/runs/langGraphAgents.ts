import { exec } from 'node:child_process';

import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver, BaseStore, Item } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { InMemoryStore, MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { z } from 'zod';

import type { AgentLayerConfig, AigcHubModelMetadata, ChatMessageAttachment, GeminiImageAspectRatio, KnowledgeBaseEntry, MemoryRecord, ProductProfile, RunImageGenerationOptions, StreamEvent } from '@viforge/shared';

import { buildAigcHubHeaders } from '../aigcHubHeaders';
import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL, AIGC_HUB_IMAGE_MODEL, PRODUCT_PROFILE } from '../env';
import type { GitService } from '../storage/gitService';
import type { GitConfigStore } from '../storage/gitConfigStore';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { PlaywriterService } from '../browser/playwriterService';
import type { WechatSendContext } from './runService';
import { getPromptText } from './langfusePromptStore';
import { readProductSkillPrompt } from '../productProfilePrompts';

type LangGraphMemoryBackend = {
  checkpointer: BaseCheckpointSaver;
  store: BaseStore;
};

const inMemoryBackends = new Map<string, LangGraphMemoryBackend>();
let postgresMemoryBackend: Promise<LangGraphMemoryBackend> | null = null;

async function getLangGraphMemoryBackend(): Promise<LangGraphMemoryBackend> {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) {
    if (process.env.VIFORGE_LANGGRAPH_ALLOW_IN_MEMORY !== '1') {
      throw new Error('LangGraph PostgreSQL is not configured. Start embedded PostgreSQL in desktop mode or set DATABASE_URL for service mode.');
    }

    const key = process.env.VITEST_WORKER_ID ?? 'default';
    let backend = inMemoryBackends.get(key);
    if (!backend) {
      backend = { checkpointer: new MemorySaver(), store: new InMemoryStore() };
      inMemoryBackends.set(key, backend);
    }
    return backend;
  }

  if (!postgresMemoryBackend) {
    postgresMemoryBackend = createPostgresLangGraphMemoryBackend(databaseUrl);
  }
  return postgresMemoryBackend;
}

async function createPostgresLangGraphMemoryBackend(databaseUrl: string): Promise<LangGraphMemoryBackend> {
  const checkpointer = PostgresSaver.fromConnString(databaseUrl, { schema: 'langgraph' });
  await checkpointer.setup();

  const store = PostgresStore.fromConnString(databaseUrl, {
    schema: 'langgraph_store',
    index: createStoreIndexConfig(),
    textSearchLanguage: 'simple',
  });
  await store.setup();

  return { checkpointer, store };
}

function createStoreIndexConfig(): ConstructorParameters<typeof PostgresStore>[0]['index'] | undefined {
  if (process.env.VIFORGE_PGVECTOR_AVAILABLE === '0') return undefined;
  if (!process.env.VIFORGE_AIGC_HUB_API_KEY && !process.env.AIGC_HUB_API_KEY) return undefined;

  return {
    dims: Number(process.env.VIFORGE_LANGGRAPH_STORE_EMBEDDING_DIMS ?? '1024'),
    embed: createMemoryEmbeddings(),
    fields: ['content', 'memory'],
  };
}

function createMemoryEmbeddings(): OpenAIEmbeddings {
  const baseUrl = process.env.VIFORGE_AIGC_HUB_BASE_URL || process.env.AIGC_HUB_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.VIFORGE_AIGC_HUB_API_KEY || process.env.AIGC_HUB_API_KEY || '';
  return new OpenAIEmbeddings({
    model: process.env.VIFORGE_AIGC_HUB_EMBEDDING_MODEL ?? 'doubao-embedding-vision',
    apiKey,
    configuration: {
      baseURL: trimTrailingSlashes(baseUrl),
      defaultHeaders: buildAigcHubHeaders(),
    },
  });
}

export type LangGraphStreamChunk = {
  type: string;
  payload?: Record<string, unknown>;
  object?: unknown;
};

export type LangGraphStreamOutput = {
  fullStream: ReadableStream<LangGraphStreamChunk> | AsyncIterable<LangGraphStreamChunk>;
};

export type LangGraphAgentClient = {
  id?: string;
  name?: string;
  stream(messages: LangGraphAgentInput, options: Record<string, unknown>): Promise<LangGraphStreamOutput>;
  generate(messages: LangGraphAgentInput, options: Record<string, unknown>): Promise<{ text: string }>;
};

export type LangGraphAgentInput = string | Array<{ role: 'user' | 'assistant'; content: string }>;

export type LangGraphToolset = ReturnType<typeof createWorkspaceTools> & Record<string, unknown>;

type ViforgeTool = StructuredToolInterface & {
  id: string;
  execute?: (input: Record<string, unknown>, options?: unknown) => Promise<unknown>;
};

export function createTool<Schema extends z.AnyZodObject>(fields: {
  id: string;
  description: string;
  inputSchema: Schema;
  execute: (input: z.infer<Schema>) => Promise<unknown> | unknown;
}): ViforgeTool {
  const created = tool(async (input: z.infer<Schema>) => fields.execute(input), {
    name: fields.id,
    description: fields.description,
    schema: fields.inputSchema,
  }) as unknown as ViforgeTool;
  created.id = fields.id;
  created.execute = async (input) => fields.execute(input as z.infer<Schema>);
  return created;
}

const AGENT_CONTROLLED_SEMANTIC_RECALL = {
  scope: 'resource' as const,
  topK: 6,
  messageRange: { before: 0, after: 0 },
};

const MEMORY_TOOL_CONFIG = {
  lastMessages: false as const,
  semanticRecall: AGENT_CONTROLLED_SEMANTIC_RECALL,
  workingMemory: { enabled: true, scope: 'resource' as const },
};

const AGENT_MEMORY_TOOL_PROTOCOL = [
  '## 长期记忆工具使用原则',
  '系统只自动保留最近几轮短期对话；语义检索和长期记忆更新由你按任务需要主动调用工具。',
  '当当前上下文不足以确认早期设定、用户偏好、角色关系、伏笔、已否决方案或审稿标准时，调用 recall_project_memory。',
  '当需要查看或合并结构化项目长期记忆时，调用 read_project_memory；写回完整 Markdown 时调用 update_project_memory。',
  '当本轮产生了未来仍有复用价值的稳定事实、偏好、角色规则、连续性约束、已否决方向或质量标准时，调用 remember_project_memory 写入精选语义记忆。',
  '不要把一次性过程、临时推理、工具流水账、未经确认的猜测或整段对话写入长期记忆。',
].join('\n');

type AgentDef = {
  id: string;
  name: string;
  workingMemoryTemplate: string;
};

export type AgentRegistry = {
  brainstorm: LangGraphAgentClient | null;
  character: LangGraphAgentClient | null;
  continuity: LangGraphAgentClient | null;
  story: LangGraphAgentClient | null;
  sourceAnalyst: LangGraphAgentClient | null;
  adaptationPlanner: LangGraphAgentClient | null;
  screenwriter: LangGraphAgentClient | null;
  reviewer: LangGraphAgentClient | null;
  outline: LangGraphAgentClient | null;
  knowledgeSearch: LangGraphAgentClient | null;
  knowledgeOrganizer: LangGraphAgentClient | null;
  systemAgent: (instructions: string, toolsOverride?: LangGraphToolset) => Promise<LangGraphAgentClient>;
};

const AGENT_DEFS: AgentDef[] = [
  {
    id: 'brainstorm-agent',
    name: '脑暴助手',
    workingMemoryTemplate: [
      '# 脑暴记忆',
      '- 已探索方向：',
      '- 已否决方案及原因：',
      '- 灵感关键词：',
      '- 用户偏好倾向：',
    ].join('\n'),
  },
  {
    id: 'character-agent',
    name: '人物设定',
    workingMemoryTemplate: [
      '# 人物设定记忆',
      '- 角色表层目标：',
      '- 角色隐藏需求：',
      '- 喜剧缺点与行为边界：',
      '- 角色关系压力：',
    ].join('\n'),
  },
  {
    id: 'continuity-agent',
    name: '连续性检查',
    workingMemoryTemplate: [
      '# 连续性记忆',
      '- 已确认项目事实：',
      '- 已发生剧情事件：',
      '- 角色关系变化：',
      '- 不可违背设定：',
      '- 可回收包袱：',
    ].join('\n'),
  },
  {
    id: 'story-agent',
    name: '故事创作',
    workingMemoryTemplate: [
      '# 故事创作记忆',
      '- 已确定的单集方向：',
      '- A/B 故事线与交叉点：',
      '- 已使用的喜剧机制：',
      '- 待回收的伏笔与包袱：',
    ].join('\n'),
  },
  {
    id: 'source-analyst-agent',
    name: '原著分析',
    workingMemoryTemplate: [
      '# 原著分析记忆',
      '- 核心主题与母题：',
      '- 关键人物关系：',
      '- 重要场景资产：',
      '- 改编边界与风险：',
    ].join('\n'),
  },
  {
    id: 'adaptation-planner-agent',
    name: '改编方案',
    workingMemoryTemplate: [
      '# 改编方案记忆',
      '- 全季结构规划：',
      '- 单集节拍设计：',
      '- 原著到剧本映射：',
      '- 已确定的改编决策：',
    ].join('\n'),
  },
  {
    id: 'screenwriter-agent',
    name: '编剧',
    workingMemoryTemplate: [
      '# 编剧记忆',
      '- 对白风格约束：',
      '- 场景转换规则：',
      '- 角色声音特征：',
      '- 已完成的场次：',
    ].join('\n'),
  },
  {
    id: 'reviewer-agent',
    name: '审稿',
    workingMemoryTemplate: [
      '# 审稿记忆',
      '- 高频问题模式：',
      '- 质量标准要点：',
      '- 已通过项：',
      '- 待修复项：',
    ].join('\n'),
  },
  {
    id: 'outline-agent',
    name: '学习大纲',
    workingMemoryTemplate: [
      '# 学习大纲记忆',
      '- 学习目标：',
      '- 当前基础：',
      '- 阶段计划：',
      '- 检查点：',
    ].join('\n'),
  },
  {
    id: 'knowledge-search-agent',
    name: '知识点搜索',
    workingMemoryTemplate: [
      '# 知识点搜索记忆',
      '- 已检索主题：',
      '- 可靠资料来源：',
      '- 待验证问题：',
      '- 常用关键词：',
    ].join('\n'),
  },
  {
    id: 'knowledge-organizer-agent',
    name: '知识点整理',
    workingMemoryTemplate: [
      '# 知识点整理记忆',
      '- 已整理知识点：',
      '- 关联知识：',
      '- 常见误区：',
      '- 待补充资料：',
    ].join('\n'),
  },
];

type ProjectMemoryMessage = {
  id: string;
  role: string;
  threadId: string;
  resourceId: string;
  content: string;
  createdAt: string;
  score?: number;
};

type ProjectMemoryStore = {
  getWorkingMemory(input: { resourceId: string }): Promise<string>;
  updateWorkingMemory(input: { resourceId: string; content: string }): Promise<void>;
  saveMemory(input: { resourceId: string; content: string; traceId?: string }): Promise<{ messageId: string; usage?: unknown }>;
  recall(input: { resourceId: string; query: string; topK: number; traceId?: string }): Promise<{ messages: ProjectMemoryMessage[]; usage?: unknown }>;
};

function createProjectMemoryStore(store: BaseStore): ProjectMemoryStore {
  const workingMemoryNamespace = (resourceId: string) => ['viforge', 'projects', resourceId, 'working-memory'];
  const semanticMemoryNamespace = (resourceId: string) => ['viforge', 'projects', resourceId, 'memories'];

  return {
    async getWorkingMemory({ resourceId }) {
      const item = await store.get(workingMemoryNamespace(resourceId), 'main');
      return typeof item?.value.content === 'string' ? item.value.content : '';
    },
    async updateWorkingMemory({ resourceId, content }) {
      await store.put(workingMemoryNamespace(resourceId), 'main', {
        content,
        resourceId,
        updatedAt: new Date().toISOString(),
      }, ['content']);
    },
    async saveMemory({ resourceId, content }) {
      const messageId = `memory-${randomId()}-${Date.now()}`;
      const createdAt = new Date().toISOString();
      await store.put(semanticMemoryNamespace(resourceId), messageId, {
        role: 'assistant',
        threadId: 'project-memory',
        resourceId,
        content,
        createdAt,
      }, ['content']);
      return { messageId, usage: { store: 'langgraph', indexed: true } };
    },
    async recall({ resourceId, query, topK }) {
      const items = await store.search(semanticMemoryNamespace(resourceId), { query, limit: topK });
      const fallbackItems = items.length > 0
        ? items
        : await store.search(semanticMemoryNamespace(resourceId), { limit: topK });
      return { messages: fallbackItems.map(storeItemToMemoryMessage), usage: { store: 'langgraph', query } };
    },
  };
}

type ScoredItem = Item & { score?: number };

function storeItemToMemoryMessage(item: ScoredItem): ProjectMemoryMessage {
  const value = item.value ?? {};
  return {
    id: item.key,
    role: typeof value.role === 'string' ? value.role : 'assistant',
    threadId: typeof value.threadId === 'string' ? value.threadId : 'project-memory',
    resourceId: typeof value.resourceId === 'string' ? value.resourceId : item.namespace.at(2) ?? '',
    content: typeof value.content === 'string' ? value.content : JSON.stringify(value),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : item.createdAt.toISOString(),
    score: typeof item.score === 'number' ? item.score : undefined,
  };
}

export function createWorkspaceTools(
  store: WorkspaceStore,
  projectId: string,
  publish: (event: StreamEvent) => void,
  runId: string,
  emittedAt: () => string,
  options: {
    imageGeneration?: RunImageGenerationOptions;
    traceId?: string;
    wechat?: WechatSendContext;
    gitService?: GitService;
    gitConfigStore?: GitConfigStore;
    browserService?: PlaywriterService;
    memoryFixture?: MemoryRecord[];
    mockMemoryWrites?: boolean;
    knowledgeFixture?: KnowledgeBaseEntry[];
  } = {},
) {
  const projectMemory = getLangGraphMemoryBackend().then(({ store }) => createProjectMemoryStore(store));
  const resource = projectId;

  const tools: Record<string, ReturnType<typeof createTool>> = {
    list_workspace_entries: createTool({
      id: 'list_workspace_entries',
      description: [
        '列出当前项目工作区中的文件和目录。',
        '默认只列出顶层条目；传入 path 可浏览子目录；传入 query 可模糊搜索所有文件。',
        '文件较多时优先用 path 或 query 缩小范围，避免一次性加载全部列表。',
      ].join('\n'),
      inputSchema: z.object({
        path: z.string().optional().describe('要列出的子目录路径（相对工作区根），不传则列顶层'),
        query: z.string().optional().describe('按文件名或路径模糊搜索，支持子序列匹配'),
      }),
      execute: async ({ path: subPath, query }) => ({
        entries: await store.listWorkspaceEntries(projectId, { path: subPath, query }),
      }),
    }),
    read_workspace_file: createTool({
      id: 'read_workspace_file',
      description: '读取当前项目工作区中的 UTF-8 文本文件。图片、PDF 等二进制文件只返回元数据摘要，不返回内容。',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: filePath }) => {
        const asset = await store.readWorkspaceFileBytes(projectId, filePath);
        if (!isTextMimeType(asset.mimeType)) {
          return {
            path: asset.path,
            mimeType: asset.mimeType,
            size: asset.bytes.length,
            content: `[二进制文件，无法以文本读取。类型: ${asset.mimeType}，大小: ${formatFileSize(asset.bytes.length)}]`,
          };
        }
        return { path: asset.path, content: asset.bytes.toString('utf8') };
      },
    }),
    write_workspace_file: createTool({
      id: 'write_workspace_file',
      description: '在项目工作区中写入一个 UTF-8 文本文件。用于输出分析、方案、剧本等工作成果。',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path: filePath, content }) => {
        const existed = await workspaceFileExists(store, projectId, filePath);
        const written = await store.writeWorkspaceFile(projectId, filePath, content);
        publish({ type: 'file.changed', runId, emittedAt: emittedAt(), path: written.path, change: existed ? 'modified' : 'created' });
        return written;
      },
    }),
    delete_workspace_file: createTool({
      id: 'delete_workspace_file',
      description: '删除当前项目工作区中的文件或目录。用于清理不再需要的工作成果。',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: filePath }) => {
        const result = await store.deleteWorkspaceEntry(projectId, filePath);
        publish({ type: 'file.changed', runId, emittedAt: emittedAt(), path: filePath, change: 'deleted' });
        return result;
      },
    }),
    move_workspace_entry: createTool({
      id: 'move_workspace_entry',
      description: [
        '移动或重命名当前项目工作区中的文件或目录。',
        'source 与 target 都是相对项目工作区根目录的路径，如 "03 剧本/01 第一集/定稿剧本.md"。',
        'target 已存在时会拒绝，避免覆盖；如需改名，请换一个不冲突的 target 路径。',
        '典型用途：整理目录结构、把生成图片归档到 "分镜/第1集/" 等子目录、给文档改名。',
      ].join('\n'),
      inputSchema: z.object({
        source: z.string().min(1).describe('工作区中当前存在的路径（文件或目录）'),
        target: z.string().min(1).describe('希望移动/重命名到的新路径；目录不存在会自动创建，但目标路径不能已存在'),
      }),
      execute: async ({ source, target }) => {
        if (source === target) {
          return { error: `source 与 target 不能相同: ${source}` };
        }
        if (await workspaceFileExists(store, projectId, target)) {
          return { error: `target 已存在，拒绝覆盖: ${target}` };
        }
        try {
          const moved = await store.moveWorkspaceEntry(projectId, source, target);
          publish({ type: 'file.changed', runId, emittedAt: emittedAt(), path: source, change: 'deleted' });
          publish({ type: 'file.changed', runId, emittedAt: emittedAt(), path: moved.path, change: 'created' });
          return moved;
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
    run_bash: createTool({
      id: 'run_bash',
      description: [
        '在当前项目工作区目录下执行 shell 命令（bash）。',
        '适合批量处理文件、用脚本提取内容、搜索大文件、格式转换等 read_workspace_file 不便处理的场景。',
        '命令的工作目录就是项目工作区根目录；默认超时 120 秒，可按需要调整；输出超过 8000 字符会被截断。',
        '不要执行需要交互输入的命令，不要安装系统级软件包，不要访问工作区之外的路径。',
      ].join('\n'),
      inputSchema: z.object({
        command: z.string().min(1).describe('要执行的 bash 命令'),
        timeout: z.number().int().min(1).max(300).default(120).describe('超时秒数，默认 120，最大 300'),
      }),
      execute: ({ command, timeout }) => new Promise((resolve) => {
        const cwd = store.getProjectRoot(projectId);
        exec(command, { cwd, timeout: timeout * 1000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          const out = stdout.length > 8000 ? stdout.slice(0, 8000) + '\n... [truncated]' : stdout;
          const err = stderr.length > 2000 ? stderr.slice(0, 2000) + '\n... [truncated]' : stderr;
          if (error && error.killed) {
            resolve({ exitCode: -1, stdout: out, stderr: `命令超时（${timeout} 秒限制）` });
            return;
          }
          resolve({ exitCode: error?.code ?? 0, stdout: out, stderr: err });
        });
      }),
    }),
    sync_to_remote: createTool({
      id: 'sync_to_remote',
      description: [
        '将当前项目工作区的所有改动提交并推送到远端 Git 仓库。',
        '在完成一轮有实质产出的工作后（如写完剧本、完成分析），主动调用此工具备份成果。',
        '不需要手动执行 git add/commit，工具会自动处理。',
        'message 是提交说明，应简要概括本次改动内容。',
      ].join('\n'),
      inputSchema: z.object({
        message: z.string().min(1).describe('提交说明，概括本次改动内容'),
      }),
      execute: async ({ message }) => {
        const git = options.gitService;
        const gitCfg = options.gitConfigStore;
        if (!git || !gitCfg) {
          return { error: '版本管理服务未启用' };
        }

        const project = await store.getProject(projectId);
        if (!project?.git?.remoteUrl) {
          return { error: '当前项目未配置远端仓库，无法同步' };
        }

        const globalConfig = await gitCfg.getGlobalGitConfig();
        const token = project.git.accessToken ?? globalConfig?.accessToken;
        if (!token) {
          return { error: '未配置访问令牌，无法推送' };
        }

        const branch = project.git.branch ?? 'main';
        const projectRoot = store.getProjectRoot(projectId);

        try {
          const result = await git.commitAndPush(projectRoot, message, project.git.remoteUrl, token, branch);
          if (result.success && result.commitHash) {
            await store.updateProjectGitConfig(projectId, {
              ...project.git,
              lastSyncAt: new Date().toISOString(),
              lastCommitHash: result.commitHash,
            });
          }
          return result;
        } catch (error) {
          return { error: error instanceof Error ? error.message : '同步失败' };
        }
      },
    }),
    read_global_file: createTool({
      id: 'read_global_file',
      description: '读取全局工作区中的 UTF-8 文本文件，如知识库、模板或 Agent 配置。',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: filePath }) => store.readGlobalWorkspaceFile(filePath),
    }),
    browser_status: createTool({
      id: 'browser_status',
      description: '检查 Playwriter 浏览器连接状态。Playwriter 连接到用户已登录的真实浏览器标签页，适合读取当前网页、导航、搜索和整理资料。',
      inputSchema: z.object({}),
      execute: async () => {
        if (!options.browserService) {
          return { enabled: false, error: 'Playwriter 浏览器服务未配置。请先启动 playwriter serve 并设置 VIFORGE_PLAYWRITER_HOST。' };
        }
        return options.browserService.status();
      },
    }),
    browser_use_install: createTool({
      id: 'browser_use_install',
      description: [
        '当用户有网页访问需求但 Playwriter 未安装、relay 未启动或浏览器标签页未授权时，调用此工具生成安装与连接指引。',
        '该工具不会访问网页，只返回当前检测状态和用户需要执行的步骤。',
      ].join('\n'),
      inputSchema: z.object({}),
      execute: async () => {
        if (!options.browserService) {
          return {
            enabled: false,
            relayReachable: false,
            connectedBrowsers: 0,
            steps: [
              '安装 Playwriter Chrome 扩展。',
              '在浏览器所在机器启动 relay：playwriter serve --host 127.0.0.1 --replace。',
              '打开需要访问的标签页，点击 Playwriter 扩展图标授权。',
              '重试网页访问请求。',
            ],
          };
        }
        return options.browserService.installGuide();
      },
    }),
    browser_navigate: createTool({
      id: 'browser_navigate',
      description: [
        '通过 Playwriter 在用户授权的真实浏览器标签页中打开 URL。',
        '适合访问用户已登录页面或需要浏览器环境的网页。只在用户要求浏览网页、搜索资料或读取页面时使用。',
      ].join('\n'),
      inputSchema: z.object({
        url: z.string().min(1).describe('要打开的网址。缺少协议时会自动补 https://'),
        sessionId: z.string().optional().describe('可选 Playwriter session id；默认使用环境变量或 1'),
      }),
      execute: async ({ url, sessionId }) => {
        if (!options.browserService) {
          return { error: 'Playwriter 浏览器服务未配置。请先启动 playwriter serve 并设置 VIFORGE_PLAYWRITER_HOST。' };
        }
        return safeBrowserToolCall(() => options.browserService!.navigate({ url, sessionId }));
      },
    }),
    browser_snapshot: createTool({
      id: 'browser_snapshot',
      description: [
        '读取当前 Playwriter 浏览器标签页的可访问性快照，返回页面文字、链接、按钮、输入框和 aria-ref 定位信息。',
        '需要理解网页内容、选择可点击元素或整理资料时优先使用，不要用截图 OCR 替代。',
      ].join('\n'),
      inputSchema: z.object({
        sessionId: z.string().optional().describe('可选 Playwriter session id；默认使用环境变量或 1'),
      }),
      execute: async ({ sessionId }) => {
        if (!options.browserService) {
          return { error: 'Playwriter 浏览器服务未配置。请先启动 playwriter serve 并设置 VIFORGE_PLAYWRITER_HOST。' };
        }
        return safeBrowserToolCall(() => options.browserService!.snapshot({ sessionId }));
      },
    }),
    browser_evaluate: createTool({
      id: 'browser_evaluate',
      description: [
        '在 Playwriter stateful sandbox 中执行一段受控 Playwright JavaScript。作用域包含 page、context、state、require。',
        '用于点击 aria-ref 元素、填写表单、读取标题/URL、等待响应、提取页面结构等浏览器操作。',
        '不要读取本地文件、不要访问工作区外路径、不要执行与浏览器任务无关的 Node.js 代码。对登录、提交、购买、删除、发布等敏感操作必须先让用户确认。',
      ].join('\n'),
      inputSchema: z.object({
        code: z.string().min(1).describe('要执行的 Playwright JavaScript，建议用 console.log(JSON.stringify(result)) 输出结构化结果'),
        sessionId: z.string().optional().describe('可选 Playwriter session id；默认使用环境变量或 1'),
        timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000).describe('执行超时毫秒数，默认 30000'),
      }),
      execute: async ({ code, sessionId, timeoutMs }) => {
        if (!options.browserService) {
          return { error: 'Playwriter 浏览器服务未配置。请先启动 playwriter serve 并设置 VIFORGE_PLAYWRITER_HOST。' };
        }
        return safeBrowserToolCall(() => options.browserService!.evaluate({ code, sessionId, timeoutMs }));
      },
    }),
    read_project_memory: createTool({
      id: 'read_project_memory',
      description: [
        '读取当前项目的结构化长期记忆。',
        '当需要确认用户偏好、项目长期设定、角色关系、伏笔、质量标准等稳定信息时使用。',
        '不要把它当作普通聊天历史；普通短期上下文已经由系统保留。',
      ].join('\n'),
      inputSchema: z.object({}),
      execute: async () => {
        if (options.memoryFixture) {
          const workingMemory = options.memoryFixture.map(formatFixtureMemoryRecord).join('\n\n');
          publish({ type: 'memory.read', runId, emittedAt: emittedAt(), scope: 'workspace', bytes: Buffer.byteLength(workingMemory, 'utf8') });
          return { memory: workingMemory, usage: { store: 'fixture', count: options.memoryFixture.length } };
        }
        const workingMemory = await (await projectMemory).getWorkingMemory({ resourceId: resource });
        publish({ type: 'memory.read', runId, emittedAt: emittedAt(), scope: 'workspace', bytes: Buffer.byteLength(workingMemory, 'utf8') });
        return { memory: workingMemory ?? '' };
      },
    }),
    update_project_memory: createTool({
      id: 'update_project_memory',
      description: [
        '更新当前项目的结构化长期记忆。',
        '只写入跨轮次仍然有价值的稳定信息，例如用户明确偏好、已确认设定、角色关系变化、伏笔、审稿标准。',
        '不要写入一次性过程、临时推理、工具调用流水账或未经确认的猜测。',
        'content 应该是完整的 Markdown 记忆正文；如需增量更新，先调用 read_project_memory 再合并。',
      ].join('\n'),
      inputSchema: z.object({
        content: z.string().min(1).describe('完整的项目结构化长期记忆 Markdown 正文'),
        reason: z.string().min(1).describe('本次更新的原因，便于审计和追踪'),
      }),
      execute: async ({ content, reason }) => {
        if (options.memoryFixture || options.mockMemoryWrites) {
          publish({
            type: 'memory.write',
            runId,
            emittedAt: emittedAt(),
            scope: 'workspace',
            authority: 'agent_inferred',
            memoryType: 'summary',
            updateMode: 'summarize',
            content,
            mocked: true,
            persisted: false,
          });
          return { updated: true, reason, bytes: Buffer.byteLength(content, 'utf8'), usage: { store: options.memoryFixture ? 'fixture' : 'eval-mock', mocked: true, persisted: false } };
        }
        await (await projectMemory).updateWorkingMemory({ resourceId: resource, content });
        publish({
          type: 'memory.write',
          runId,
          emittedAt: emittedAt(),
          scope: 'workspace',
          authority: 'agent_inferred',
          memoryType: 'summary',
          updateMode: 'summarize',
          content,
        });
        return { updated: true, reason, bytes: Buffer.byteLength(content, 'utf8') };
      },
    }),
    recall_project_memory: createTool({
      id: 'recall_project_memory',
      description: [
        '按语义检索当前项目中由 agent 主动写入的精选长期记忆。',
        '适合在当前任务需要找回早期关键设定、用户偏好、角色关系、已否决方案、审稿结论时使用。',
        '普通问候、短问题、当前上下文已经足够时不要调用。',
      ].join('\n'),
      inputSchema: z.object({
        query: z.string().min(1).describe('用于语义检索的自然语言查询，写清要找回的信息类型'),
        topK: z.number().int().min(1).max(12).default(6),
      }),
      execute: async ({ query, topK }) => {
        if (options.memoryFixture) {
          const matches = selectMemoryFixture(options.memoryFixture, query, topK);
          publish({ type: 'memory.recall', runId, emittedAt: emittedAt(), query, matches, topK, scope: 'workspace', source: 'fixture' });
          return { query, matches: matches.map(memoryRecordToFixtureMessage), usage: { store: 'fixture', query } };
        }
        const result = await (await projectMemory).recall({ resourceId: resource, query, topK, traceId: options.traceId });
        publish({
          type: 'memory.recall',
          runId,
          emittedAt: emittedAt(),
          query,
          matches: result.messages.map((message) => projectMemoryMessageToRecord(message, projectId)),
          topK,
          scope: 'workspace',
          source: 'live',
        });
        return {
          query,
          matches: result.messages.map(formatMemoryMessage),
          usage: result.usage,
        };
      },
    }),
    remember_project_memory: createTool({
      id: 'remember_project_memory',
      description: [
        '把一条精选长期记忆写入语义索引，供 recall_project_memory 未来检索。',
        '只保存对后续创作有复用价值的信息，例如已确认设定、角色规则、用户偏好、已否决方向、审稿结论。',
        '每条 memory 应简洁、可独立理解，并包含必要上下文；不要保存整段对话或临时分析。',
      ].join('\n'),
      inputSchema: z.object({
        memory: z.string().min(1).describe('要长期保存并建立语义索引的记忆条目'),
        category: z.enum(['user_preference', 'project_fact', 'character', 'continuity', 'plot_thread', 'rejected_option', 'quality_standard', 'other']).default('other'),
        reason: z.string().min(1).describe('为什么这条信息值得长期记住'),
      }),
      execute: async ({ memory: memoryText, category, reason }) => {
        if (options.memoryFixture || options.mockMemoryWrites) {
          publish({
            type: 'memory.write',
            runId,
            emittedAt: emittedAt(),
            scope: 'workspace',
            authority: 'agent_inferred',
            memoryType: categoryToMemoryType(category),
            updateMode: 'append',
            content: memoryText,
            mocked: true,
            persisted: false,
          });
          return { remembered: true, category, messageId: `mock-memory-${Date.now()}`, usage: { store: options.memoryFixture ? 'fixture' : 'eval-mock', mocked: true, persisted: false }, reason };
        }
        const content = [
          '# 精选长期记忆',
          `- category: ${category}`,
          `- reason: ${reason}`,
          '',
          memoryText,
        ].join('\n');
        const result = await (await projectMemory).saveMemory({ resourceId: resource, content, traceId: options.traceId });
        publish({
          type: 'memory.write',
          runId,
          emittedAt: emittedAt(),
          scope: 'workspace',
          authority: 'agent_inferred',
          memoryType: categoryToMemoryType(category),
          updateMode: 'append',
          content: memoryText,
        });
        return { remembered: true, category, messageId: result.messageId, usage: result.usage };
      },
    }),
    retrieve_knowledge_cards: createTool({
      id: 'retrieve_knowledge_cards',
      description: [
        '从全局知识库索引中检索可复用的创作机制卡、观点卡或笑点模式卡。',
        '检索结果只用于启发，不要复制具体台词、完整桥段、人物身份或受版权保护的表达。',
        '知识库索引优先读取 知识库/index.yaml；如果没有索引，会退化为扫描 知识库 下的 Markdown 文件。',
      ].join('\n'),
      inputSchema: z.object({
        query: z.string().min(1).describe('检索意图，例如“业主群误会升级机制”'),
        tags: z.array(z.string()).default([]).describe('可选标签过滤'),
        topK: z.number().int().min(1).max(12).default(5),
      }),
      execute: async ({ query, tags, topK }) => {
        if (options.knowledgeFixture) {
          const matches = selectKnowledgeFixture(options.knowledgeFixture, query, tags, topK);
          publish({ type: 'knowledge.retrieve', runId, emittedAt: emittedAt(), query, matches, tags, topK, source: 'fixture' });
          return { query, matches, usage: { store: 'fixture' } };
        }
        const matches = await retrieveKnowledgeCards(store, query, tags, topK);
        publish({ type: 'knowledge.retrieve', runId, emittedAt: emittedAt(), query, matches, tags, topK, source: 'live' });
        return { query, matches };
      },
    }),
    generate_project_image: createTool({
      id: 'generate_project_image',
      description: [
        '通过 AIGC Hub 生成图片，并保存到当前项目工作区的”生成图片/”目录。',
        '当用户明确要求生成、绘制、出图、生成角色图/场景图/剧照/分镜图/海报时使用。',
        '普通视觉描述或提示词整理不需要调用此工具。',
        '缺省以时间戳命名；可通过 outputDir / fileName 自定义保存目录和文件主名（扩展名自动追加）。',
        '不要猜测或填写模型名；工具会自动使用前端/微信会话配置的图片模型，未配置时使用 VIFORGE_AIGC_HUB_IMAGE_MODEL。',
      ].join('\n'),
      inputSchema: z.object({
        prompt: z.string().min(1),
        aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).default('1:1'),
        count: z.number().int().min(1).max(4).default(1),
        outputDir: z
          .string()
          .optional()
          .describe('可选。图片保存的相对目录（相对项目工作区根目录），如 "生成图片/角色"。缺省时为 "生成图片/"。'),
        fileName: z
          .string()
          .optional()
          .describe('可选。图片文件主名（不含扩展名，工具会根据实际 MIME 自动追加），如 "主角-立绘"。缺省时使用时间戳。'),
      }),
      execute: async ({ prompt, aspectRatio, count, outputDir, fileName }) => {
        const resolvedAspectRatio = aspectRatio ?? '1:1';
        const resolvedCount = count ?? 1;
        const gatewayBaseUrl = process.env.VIFORGE_AIGC_HUB_BASE_URL ?? AIGC_HUB_BASE_URL;
        const gatewayApiKey = process.env.VIFORGE_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY;
        const selectedModel = await resolveImageModel(gatewayBaseUrl, gatewayApiKey, options.imageGeneration?.model);

        if (!gatewayBaseUrl || !gatewayApiKey) {
          throw new Error('未配置 VIFORGE_AIGC_HUB_BASE_URL 或 VIFORGE_AIGC_HUB_API_KEY，无法通过 AIGC Hub 生成图片。');
        }

        const response = await requestAigcHubImages(gatewayBaseUrl, gatewayApiKey, {
          model: selectedModel || undefined,
          prompt,
          aspectRatio: resolvedAspectRatio,
          count: resolvedCount,
          traceId: options.traceId,
        });
        const generated: Array<{ path: string; mimeType: string; model?: string; revisedPrompt?: string }> = [];
        const attachments: ChatMessageAttachment[] = [];
        const now = new Date().toISOString();

        for (const [index, image] of (response.data ?? []).entries()) {
          const imageData = await imageDataFromAigcHubImage(image);
          if (!imageData) continue;

          const extension = extensionFromMimeType(imageData.mimeType) ?? 'png';
          const imagePath = buildOutputImagePath({
            outputDir,
            fileName,
            extension,
            now,
            index,
            total: (response.data ?? []).length,
          });
          const existed = await workspaceFileExists(store, projectId, imagePath);
          const entry = await store.createWorkspaceAsset(projectId, imagePath, Buffer.from(imageData.contentBase64, 'base64'), imageData.mimeType);
          publish({ type: 'file.changed', runId, emittedAt: emittedAt(), path: entry.path, change: existed ? 'modified' : 'created' });
          const attachment: ChatMessageAttachment = {
            id: `attachment-${randomId()}`,
            kind: 'generated-image',
            name: entry.name,
            path: entry.path,
            projectId,
            mimeType: imageData.mimeType,
            prompt,
            model: selectedModel || undefined,
            aspectRatio: resolvedAspectRatio,
            createdAt: now,
          };
          attachments.push(attachment);
          publish({ type: 'image.generated', runId, emittedAt: emittedAt(), attachment });
          generated.push({
            path: entry.path,
            mimeType: imageData.mimeType,
            model: selectedModel || undefined,
            revisedPrompt: typeof image.revised_prompt === 'string' ? image.revised_prompt : undefined,
          });
        }

        if (generated.length === 0) {
          throw new Error('AIGC Hub 未返回图片结果');
        }

        return { images: generated };
      },
    }),
    edit_project_image: createTool({
      id: 'edit_project_image',
      description: [
        '修改工作区中已有的图片。读取指定图片作为参考，结合文字描述生成修改后的新图片。',
        '当用户要求修改、调整、优化某张已有图片时使用（如"把这张图的角色换个表情"、"调整场景光线"）。',
        '缺省保存到 "生成图片/" 目录并以时间戳 + "-edit" 命名；可通过 outputDir / fileName 自定义保存位置和文件主名。',
        '不要猜测或填写模型名；工具会自动使用配置的图片模型。',
      ].join('\n'),
      inputSchema: z.object({
        imagePath: z.string().min(1).describe('工作区中待修改图片的路径，可通过 list_workspace_entries 查看'),
        prompt: z.string().min(1).describe('图片修改描述，说明需要如何修改原图'),
        aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).default('1:1'),
        count: z.number().int().min(1).max(4).default(1),
        outputDir: z
          .string()
          .optional()
          .describe('可选。图片保存的相对目录（相对项目工作区根目录）。缺省时为 "生成图片/"。'),
        fileName: z
          .string()
          .optional()
          .describe('可选。图片文件主名（不含扩展名）。缺省时使用时间戳 + "-edit" 后缀。'),
      }),
      execute: async ({ imagePath, prompt, aspectRatio, count, outputDir, fileName }) => {
        const resolvedAspectRatio = aspectRatio ?? '1:1';
        const resolvedCount = count ?? 1;
        const gatewayBaseUrl = process.env.VIFORGE_AIGC_HUB_BASE_URL ?? AIGC_HUB_BASE_URL;
        const gatewayApiKey = process.env.VIFORGE_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY;
        const selectedModel = await resolveImageModel(gatewayBaseUrl, gatewayApiKey, options.imageGeneration?.model);

        if (!gatewayBaseUrl || !gatewayApiKey) {
          throw new Error('未配置 VIFORGE_AIGC_HUB_BASE_URL 或 VIFORGE_AIGC_HUB_API_KEY，无法通过 AIGC Hub 编辑图片。');
        }

        const source = await store.readWorkspaceFileBytes(projectId, imagePath);
        if (!source.mimeType.startsWith('image/')) {
          throw new Error(`文件 ${imagePath} 不是图片（类型: ${source.mimeType}），无法编辑。`);
        }

        let response: AigcHubImageResponse;
        try {
          response = await requestAigcHubImageEdits(gatewayBaseUrl, gatewayApiKey, {
            model: selectedModel || undefined,
            image: source.bytes,
            imageMimeType: source.mimeType,
            imageName: source.path.split('/').pop() ?? 'source.png',
            prompt,
            aspectRatio: resolvedAspectRatio,
            count: resolvedCount,
            traceId: options.traceId,
          });
        } catch (error) {
          if (isEditsEndpointUnsupported(error)) {
            response = await requestAigcHubImages(gatewayBaseUrl, gatewayApiKey, {
              model: selectedModel || undefined,
              prompt: `${prompt}\n\n（基于已有图片修改，原图路径: ${imagePath}）`,
              aspectRatio: resolvedAspectRatio,
              count: resolvedCount,
              traceId: options.traceId,
            });
          } else {
            throw error;
          }
        }

        const generated: Array<{ path: string; mimeType: string; model?: string; revisedPrompt?: string }> = [];
        const attachments: ChatMessageAttachment[] = [];
        const now = new Date().toISOString();

        for (const [index, image] of (response.data ?? []).entries()) {
          const imageData = await imageDataFromAigcHubImage(image);
          if (!imageData) continue;

          const extension = extensionFromMimeType(imageData.mimeType) ?? 'png';
          const editedPath = buildOutputImagePath({
            outputDir,
            fileName,
            extension,
            now,
            index,
            total: (response.data ?? []).length,
            defaultFileNameSuffix: 'edit',
          });
          const existed = await workspaceFileExists(store, projectId, editedPath);
          const entry = await store.createWorkspaceAsset(projectId, editedPath, Buffer.from(imageData.contentBase64, 'base64'), imageData.mimeType);
          publish({ type: 'file.changed', runId, emittedAt: emittedAt(), path: entry.path, change: existed ? 'modified' : 'created' });
          const attachment: ChatMessageAttachment = {
            id: `attachment-${randomId()}`,
            kind: 'generated-image',
            name: entry.name,
            path: entry.path,
            projectId,
            mimeType: imageData.mimeType,
            prompt,
            model: selectedModel || undefined,
            aspectRatio: resolvedAspectRatio,
            createdAt: now,
          };
          attachments.push(attachment);
          publish({ type: 'image.generated', runId, emittedAt: emittedAt(), attachment });
          generated.push({
            path: entry.path,
            mimeType: imageData.mimeType,
            model: selectedModel || undefined,
            revisedPrompt: typeof image.revised_prompt === 'string' ? image.revised_prompt : undefined,
          });
        }

        if (generated.length === 0) {
          throw new Error('AIGC Hub 未返回图片结果');
        }

        return { images: generated, sourceImagePath: imagePath };
      },
    }),
  };

  if (options.wechat) {
    const wechat = options.wechat;
    tools.send_wechat_message = createTool({
      id: 'send_wechat_message',
      description: [
        '立即向已绑定的用户微信发送一条文本消息。',
        '只在本次运行中需要马上发送当前正文时使用，例如用户要求现在把摘要、通知或结果发到微信。',
        '本工具不会创建未来或周期性任务；如果用户要求定时、每天、每周或隔一段时间发送，必须使用 create_scheduled_task。',
        '由你根据当前上下文生成最终要发送的正文，再调用本工具发送；不要让外层系统替你发送。',
      ].join('\n'),
      inputSchema: z.object({
        message: z.string().min(1).describe('要发送到微信的最终文本正文'),
      }),
      execute: async ({ message }) => {
        await wechat.sendText({ text: message });
        return { sent: true, channel: 'wechat', textLength: message.length };
      },
    });

    tools.send_wechat_file = createTool({
      id: 'send_wechat_file',
      description: [
        '将项目工作区中的文件发送给用户微信。',
        '当用户说"把xxx发给我"、"发送文件给我"、"发一下这个文件"等要求发送工作区文件时使用。',
        '支持图片、PDF、文本、视频、音频等任意文件类型。',
      ].join('\n'),
      inputSchema: z.object({
        path: z.string().min(1).describe('工作区中的文件路径，可通过 list_workspace_entries 查看可用文件'),
      }),
      execute: async ({ path: filePath }) => {
        const asset = await store.readWorkspaceFileBytes(projectId, filePath);
        await wechat.sendFile({
          bytes: asset.bytes,
          name: asset.path.split('/').pop() ?? asset.path,
          mimeType: asset.mimeType,
        });
        publish({ type: 'wechat.file_sent', runId, emittedAt: emittedAt(), path: asset.path, mimeType: asset.mimeType });
        return { sent: true, path: asset.path, mimeType: asset.mimeType };
      },
    });
  }

  return tools;
}

type AigcHubImage = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
};

type AigcHubImageResponse = {
  data?: AigcHubImage[];
  error?: string | { message?: string };
};

async function requestAigcHubImages(
  gatewayBaseUrl: string,
  gatewayApiKey: string,
  input: { model?: string; prompt: string; aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9'; count: number; traceId?: string },
): Promise<AigcHubImageResponse> {
  const response = await fetch(`${trimTrailingSlashes(gatewayBaseUrl)}/images/generations`, {
    method: 'POST',
    headers: buildAigcHubHeaders({ apiKey: gatewayApiKey, contentType: 'application/json', traceId: input.traceId }),
    body: JSON.stringify({
      ...(input.model ? { model: input.model } : {}),
      prompt: input.prompt,
      size: imageSizeFromAspectRatio(input.aspectRatio),
      n: input.count,
      response_format: 'b64_json',
    }),
  });

  const body = await parseAigcHubJson(response);
  if (!response.ok) {
    throw new Error(errorMessageFromAigcHubBody(body) ?? `AIGC Hub 图片生成请求失败：${response.status}`);
  }
  return body;
}

async function requestAigcHubImageEdits(
  gatewayBaseUrl: string,
  gatewayApiKey: string,
  input: {
    model?: string;
    image: Buffer;
    imageMimeType: string;
    imageName: string;
    prompt: string;
    aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
    count: number;
    traceId?: string;
  },
): Promise<AigcHubImageResponse> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(input.image)], { type: input.imageMimeType }), input.imageName);
  form.append('prompt', input.prompt);
  form.append('size', imageSizeFromAspectRatio(input.aspectRatio));
  form.append('n', String(input.count));
  form.append('response_format', 'b64_json');
  if (input.model) form.append('model', input.model);

  const headers = buildAigcHubHeaders({ apiKey: gatewayApiKey, traceId: input.traceId });
  const response = await fetch(`${trimTrailingSlashes(gatewayBaseUrl)}/images/edits`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (response.status === 404 || response.status === 405) {
    throw Object.assign(new Error(`AIGC Hub images/edits endpoint unavailable: ${response.status}`), { status: response.status });
  }

  const body = await parseAigcHubJson(response);
  if (!response.ok) {
    throw new Error(errorMessageFromAigcHubBody(body) ?? `AIGC Hub 图片编辑请求失败：${response.status}`);
  }
  return body;
}

function isEditsEndpointUnsupported(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    return status === 404 || status === 405;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /images\/edits.*(?:not found|unavailable|404|405)/i.test(message);
}

async function resolveImageModel(gatewayBaseUrl: string, gatewayApiKey: string, configuredModel?: string): Promise<string> {
  const envModel = process.env.VIFORGE_AIGC_HUB_IMAGE_MODEL ?? AIGC_HUB_IMAGE_MODEL;

  if (configuredModel && configuredModel !== envModel) {
    const models = await requestAigcHubModels(gatewayBaseUrl, gatewayApiKey);
    const match = models.find((m) => m.id === configuredModel && modelSupportsImageGeneration(m));
    if (match) return match.id;
  }

  if (envModel) return envModel;

  const models = await requestAigcHubModels(gatewayBaseUrl, gatewayApiKey);
  const imageModel = models.find(modelSupportsImageGeneration);
  if (!imageModel) {
    throw new Error('未配置图片生成模型，且 AIGC Hub 模型列表中没有发现支持图片生成的模型。');
  }
  return imageModel.id;
}

async function requestAigcHubModels(gatewayBaseUrl: string, gatewayApiKey: string): Promise<AigcHubModelMetadata[]> {
  const adminResult = await requestModelList(aigcHubAdminModelsUrl(gatewayBaseUrl), gatewayApiKey);
  if (adminResult.length > 0) return adminResult;
  return requestModelList(aigcHubPublicModelsUrl(gatewayBaseUrl), gatewayApiKey);
}

async function requestModelList(url: string, apiKey: string): Promise<AigcHubModelMetadata[]> {
  const response = await fetch(url, { headers: buildAigcHubHeaders({ apiKey }) });
  const body = await parseUnknownJson(response);
  if (!response.ok) return [];
  return normalizeModels(body);
}

function aigcHubAdminModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? `${path.slice(0, -3)}/api/models` : `${path}/api/models`;
  url.search = '';
  return url.toString();
}

function aigcHubPublicModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? `${path}/models` : `${path}/v1/models`;
  url.search = '';
  return url.toString();
}

async function parseUnknownJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

type RawModel = Record<string, unknown>;

function normalizeModels(body: unknown): AigcHubModelMetadata[] {
  return rawModelArray(body).map(normalizeModel).filter((model): model is AigcHubModelMetadata => Boolean(model));
}

function rawModelArray(body: unknown): RawModel[] {
  if (Array.isArray(body)) return body.filter(isRawModel);
  if (!isRawModel(body)) return [];
  for (const key of ['models', 'data', 'items']) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isRawModel);
    const nested = rawModelArray(value);
    if (nested.length > 0) return nested;
  }
  return Object.entries(body)
    .filter(([, value]) => isRawModel(value))
    .map(([id, value]) => ({ id, ...(value as RawModel) }));
}

function normalizeModel(raw: RawModel): AigcHubModelMetadata | null {
  const id = stringField(raw, ['id', 'model', 'name', 'slug']);
  if (!id) return null;
  return {
    id,
    label: stringField(raw, ['label', 'displayName', 'title', 'name']) ?? id,
    provider: stringField(raw, ['provider', 'vendor', 'source']) ?? undefined,
    capabilities: normalizeCapabilities(raw),
  };
}

function normalizeCapabilities(raw: RawModel): string[] {
  const capabilities = new Set<string>();
  for (const key of ['capabilities', 'capability', 'features', 'modalities', 'supportedCapabilities']) {
    addCapabilityValue(capabilities, raw[key]);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (value === true && /chat|image|vision|embed|response|tool/i.test(key)) {
      capabilities.add(key.replace(/^(supports?|has|can)_?/i, '').toLowerCase());
    }
  }
  return [...capabilities].sort();
}

function addCapabilityValue(capabilities: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    capabilities.add(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => addCapabilityValue(capabilities, item));
    return;
  }
  if (isRawModel(value)) {
    Object.entries(value).forEach(([key, enabled]) => {
      if (enabled) capabilities.add(key.toLowerCase());
    });
  }
}

function modelSupportsImageGeneration(model: AigcHubModelMetadata): boolean {
  const id = model.id.toLowerCase();
  if (/image|dall[-_]?e|flux|sdxl|stable[-_]?diffusion|midjourney/.test(id)) {
    return !/embedding/.test(id);
  }
  const caps = model.capabilities.join(' ').toLowerCase();
  return /image[-_]?generation|text[-_]?to[-_]?image|图片生成/.test(caps);
}

function stringField(raw: RawModel, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function isRawModel(value: unknown): value is RawModel {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseAigcHubJson(response: Response): Promise<AigcHubImageResponse> {
  try {
    return await response.json() as AigcHubImageResponse;
  } catch {
    return {};
  }
}

function errorMessageFromAigcHubBody(body: AigcHubImageResponse): string | null {
  if (!body.error) return null;
  return typeof body.error === 'string' ? body.error : body.error.message ?? null;
}

async function imageDataFromAigcHubImage(image: AigcHubImage): Promise<{ contentBase64: string; mimeType: string } | null> {
  if (image.b64_json) {
    return { contentBase64: stripDataUrlPrefix(image.b64_json), mimeType: mimeTypeFromDataUrl(image.b64_json) ?? 'image/png' };
  }
  if (!image.url) return null;
  if (image.url.startsWith('data:')) {
    return { contentBase64: stripDataUrlPrefix(image.url), mimeType: mimeTypeFromDataUrl(image.url) ?? 'image/png' };
  }

  const response = await fetch(image.url);
  if (!response.ok) {
    throw new Error(`图片结果下载失败：${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    contentBase64: bytes.toString('base64'),
    mimeType: response.headers.get('content-type')?.split(';')[0] ?? 'image/png',
  };
}

function imageSizeFromAspectRatio(aspectRatio: GeminiImageAspectRatio): string {
  switch (aspectRatio) {
    case '16:9':
    case '4:3':
      return '1536x1024';
    case '9:16':
    case '3:4':
      return '1024x1536';
    case '1:1':
      return '1024x1024';
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function stripDataUrlPrefix(value: string): string {
  const commaIndex = value.indexOf(',');
  return value.startsWith('data:') && commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
}

function mimeTypeFromDataUrl(value: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(value);
  return match?.[1] ?? null;
}

function extensionFromMimeType(mimeType: string): string | null {
  if (/png/i.test(mimeType)) return 'png';
  if (/jpe?g/i.test(mimeType)) return 'jpg';
  if (/webp/i.test(mimeType)) return 'webp';
  return null;
}

function isTextMimeType(mimeType: string): boolean {
  return /^text\//.test(mimeType) || /json|yaml|xml|svg|markdown/.test(mimeType);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timestampForFileName(value: string): string {
  return value.replace(/[:.]/g, '-');
}

function buildOutputImagePath(params: {
  outputDir?: string;
  fileName?: string;
  extension: string;
  now: string;
  index: number;
  total: number;
  defaultFileNameSuffix?: string;
}): string {
  const dirRaw = (params.outputDir ?? '').trim();
  if (dirRaw.includes('..')) {
    throw new Error(`outputDir 不能包含 "..": ${dirRaw}`);
  }
  const dir = dirRaw
    ? dirRaw.split('/').filter(Boolean).join('/')
    : '生成图片';

  const baseNameRaw = (params.fileName ?? '').trim();
  if (baseNameRaw.includes('/') || baseNameRaw.includes('\\') || baseNameRaw.includes('..')) {
    throw new Error(`fileName 不能包含路径或 "..": ${baseNameRaw}`);
  }
  const baseName = baseNameRaw.replace(/\.(png|jpe?g|webp|gif)$/i, '');

  const extension = params.extension || 'png';
  const ts = timestampForFileName(params.now);
  const indexSuffix = params.total > 1 ? `-${String(params.index + 1).padStart(2, '0')}` : '';

  const stem = baseName
    ? `${baseName}${indexSuffix}`
    : params.defaultFileNameSuffix
      ? `${ts}-${params.defaultFileNameSuffix}${indexSuffix}`
      : `${ts}${indexSuffix}`;

  return `${dir}/${stem}.${extension}`;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function textFromMemoryMessage(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const record = content as { content?: unknown; parts?: Array<{ type?: string; text?: string }> };
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.parts)) {
    return record.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

function formatMemoryMessage(message: { id: string; role?: string; threadId?: string; createdAt?: Date | string; content?: unknown }) {
  const text = textFromMemoryMessage(message).trim();
  return {
    id: message.id,
    role: message.role,
    threadId: message.threadId,
    createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    text: text.length > 2000 ? `${text.slice(0, 2000)}...` : text,
  };
}

function formatFixtureMemoryRecord(record: MemoryRecord): string {
  return [
    `## ${record.memoryType} / ${record.scope}`,
    `- id: ${record.id}`,
    `- authority: ${record.authority}`,
    `- updateMode: ${record.updateMode}`,
    record.key ? `- key: ${record.key}` : '',
    '',
    record.content,
  ].filter(Boolean).join('\n');
}

function memoryRecordToFixtureMessage(record: MemoryRecord) {
  return {
    id: record.id,
    role: record.createdByAgent ?? 'fixture',
    threadId: record.namespace.join('/'),
    createdAt: record.createdAt,
    text: record.content.length > 2000 ? `${record.content.slice(0, 2000)}...` : record.content,
  };
}

function selectMemoryFixture(records: MemoryRecord[], query: string, topK: number): MemoryRecord[] {
  const normalizedQuery = normalizeSearchText(query);
  return records
    .filter((record) => !record.tombstonedAt)
    .map((record) => ({ record, score: memoryFixtureScore(record, normalizedQuery) }))
    .filter(({ score }) => score > 0 || normalizedQuery.length === 0)
    .sort((left, right) => right.score - left.score || left.record.updatedAt.localeCompare(right.record.updatedAt))
    .slice(0, topK)
    .map(({ record }) => record);
}

function memoryFixtureScore(record: MemoryRecord, query: string): number {
  const haystack = normalizeSearchText([
    record.content,
    record.key ?? '',
    record.scope,
    record.memoryType,
    record.authority,
  ].join(' '));
  return query.split(/\s+/).filter(Boolean).reduce((score, token) => score + (haystack.includes(token) ? 2 : 0), 0);
}

function selectKnowledgeFixture(entries: KnowledgeBaseEntry[], query: string, tags: string[], topK: number): KnowledgeBaseEntry[] {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedTags = tags.map(normalizeSearchText).filter(Boolean);
  return entries
    .map((entry) => ({ entry, score: knowledgeScore(entry, normalizedQuery, normalizedTags) }))
    .filter(({ score }) => score > 0 || normalizedQuery.length === 0)
    .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
    .slice(0, topK)
    .map(({ entry }) => entry);
}

function projectMemoryMessageToRecord(message: ProjectMemoryMessage, projectId: string): MemoryRecord {
  return {
    id: message.id,
    namespace: ['viforge', PRODUCT_PROFILE.id, 'workspaces', projectId, 'memories'],
    scope: 'workspace',
    memoryType: 'summary',
    authority: 'agent_inferred',
    updateMode: 'append',
    content: message.content,
    evidenceRefs: [],
    confidence: message.score,
    createdByAgent: message.role,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    tombstonedAt: null,
  };
}

function categoryToMemoryType(category: string): MemoryRecord['memoryType'] {
  switch (category) {
    case 'user_preference':
      return 'profile';
    case 'project_fact':
    case 'character':
    case 'continuity':
    case 'plot_thread':
      return 'constraint';
    case 'rejected_option':
    case 'quality_standard':
      return 'decision';
    default:
      return 'summary';
  }
}

async function retrieveKnowledgeCards(store: WorkspaceStore, query: string, tags: string[], topK: number): Promise<KnowledgeBaseEntry[]> {
  const indexed = await readKnowledgeIndex(store);
  const entries = indexed.length > 0 ? indexed : await scanKnowledgeMarkdown(store);
  const normalizedQuery = normalizeSearchText(query);
  const normalizedTags = tags.map(normalizeSearchText).filter(Boolean);
  return entries
    .map((entry) => ({ entry, score: knowledgeScore(entry, normalizedQuery, normalizedTags) }))
    .filter(({ score }) => score > 0 || normalizedQuery.length === 0)
    .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
    .slice(0, topK)
    .map(({ entry }) => entry);
}

async function readKnowledgeIndex(store: WorkspaceStore): Promise<KnowledgeBaseEntry[]> {
  try {
    const file = await store.readGlobalWorkspaceFile('知识库/index.yaml');
    return parseKnowledgeIndex(file.content);
  } catch {
    return [];
  }
}

async function scanKnowledgeMarkdown(store: WorkspaceStore): Promise<KnowledgeBaseEntry[]> {
  try {
    const entries = await store.listGlobalWorkspaceEntries();
    return entries
      .filter((entry) => entry.type === 'file' && entry.path.startsWith('知识库/') && /\.md$/i.test(entry.path))
      .filter((entry) => !entry.path.endsWith('/README.md'))
      .map((entry) => ({
        id: `kb-${entry.path.replace(/^知识库\//, '').replace(/\.md$/i, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-')}`,
        title: entry.name.replace(/\.md$/i, ''),
        path: entry.path.replace(/^知识库\//, ''),
        type: entry.path.includes('/inbox/') ? 'inbox' : entry.path.includes('/viewpoints/') ? 'viewpoint' : entry.path.includes('/jokes/') ? 'joke_pattern' : 'mechanism',
        tags: [],
        rightsRisk: 'medium',
        contentHash: entry.size !== undefined ? `size:${entry.size}` : undefined,
        updatedAt: entry.updatedAt ?? new Date(0).toISOString(),
      } satisfies KnowledgeBaseEntry));
  } catch {
    return [];
  }
}

function parseKnowledgeIndex(content: string): KnowledgeBaseEntry[] {
  const entriesBlock = content.split(/\nentries\s*:\s*\n/)[1] ?? '';
  const blocks = entriesBlock.split(/\n\s*-\s+/).map((block) => block.trim()).filter(Boolean);
  return blocks.map((block) => parseKnowledgeIndexBlock(block)).filter((entry): entry is KnowledgeBaseEntry => Boolean(entry));
}

function parseKnowledgeIndexBlock(block: string): KnowledgeBaseEntry | null {
  const normalized = block.replace(/^[- ]+/, '');
  const value = (key: string) => {
    const match = normalized.match(new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.+)`));
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  };
  const id = value('id');
  const title = value('title');
  const cardPath = value('path');
  if (!id || !title || !cardPath) return null;
  const type = parseKnowledgeType(value('type'));
  const rightsRisk = parseRightsRisk(value('rightsRisk'));
  return {
    id,
    title,
    path: cardPath,
    type,
    tags: parseInlineList(value('tags')),
    rightsRisk,
    source: value('source'),
    contentHash: value('contentHash'),
    updatedAt: value('updatedAt') ?? new Date(0).toISOString(),
  };
}

function parseInlineList(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [trimmed].filter(Boolean);
  return trimmed.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function parseKnowledgeType(value: string | undefined): KnowledgeBaseEntry['type'] {
  if (value === 'viewpoint' || value === 'joke_pattern' || value === 'source_note' || value === 'inbox') return value;
  return 'mechanism';
}

function parseRightsRisk(value: string | undefined): KnowledgeBaseEntry['rightsRisk'] {
  if (value === 'low' || value === 'high') return value;
  return 'medium';
}

function knowledgeScore(entry: KnowledgeBaseEntry, query: string, tags: string[]): number {
  const haystack = normalizeSearchText([entry.title, entry.path, entry.type, ...entry.tags].join(' '));
  const queryScore = query.split(/\s+/).filter(Boolean).reduce((score, token) => score + (haystack.includes(token) ? 2 : 0), 0);
  const tagScore = tags.reduce((score, tag) => score + (entry.tags.some((entryTag) => normalizeSearchText(entryTag).includes(tag)) ? 3 : 0), 0);
  return queryScore + tagScore;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').trim();
}

async function workspaceFileExists(store: WorkspaceStore, projectId: string, filePath: string): Promise<boolean> {
  try {
    await store.readWorkspaceFile(projectId, filePath);
    return true;
  } catch {
    return false;
  }
}

const TOOL_OUTPUT_SIZE_LIMIT = 30000;
const BASE64_PATTERN = /^[A-Za-z0-9+/=]{200,}$/;

function stripLargeStringsFromJson(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_OUTPUT_SIZE_LIMIT || BASE64_PATTERN.test(value)) return '[data removed]';
    return value;
  }
  if (Array.isArray(value)) return value.map(stripLargeStringsFromJson);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.attachments)) {
      const { attachments: _, ...rest } = obj;
      return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, stripLargeStringsFromJson(v)]));
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, stripLargeStringsFromJson(v)]));
  }
  return value;
}

function sanitizeToolOutputValue(output: unknown): { changed: boolean; output: unknown } {
  if (!output || typeof output !== 'object') return { changed: false, output };
  const o = output as Record<string, unknown>;
  const type = o.type as string | undefined;
  const value = o.value;

  if (type === 'text' && typeof value === 'string' && value.length > TOOL_OUTPUT_SIZE_LIMIT) {
    return { changed: true, output: { type: 'text', value: '[工具结果已省略]' } };
  }

  if (type === 'json') {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized.length > TOOL_OUTPUT_SIZE_LIMIT) {
      const cleaned = stripLargeStringsFromJson(value);
      const cleanedStr = JSON.stringify(cleaned);
      if (cleanedStr.length > TOOL_OUTPUT_SIZE_LIMIT) {
        return { changed: true, output: { type: 'json', value: { _summary: '工具结果过大已省略', keys: Object.keys(value as Record<string, unknown>) } } };
      }
      return { changed: true, output: { type: 'json', value: cleaned } };
    }
  }

  if (type === 'content' && Array.isArray(value)) {
    let changed = false;
    const sanitized = (value as Array<Record<string, unknown>>).map((part) => {
      if (part.type === 'media' && typeof part.data === 'string') {
        changed = true;
        return { ...part, data: '[binary data removed]' };
      }
      return part;
    });
    if (changed) return { changed: true, output: { type: 'content', value: sanitized } };
  }

  return { changed: false, output };
}

export async function createAgentRegistry(
  store: WorkspaceStore,
  options: {
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    connectionString?: string;
    traceId?: string;
    productProfile?: ProductProfile;
    layerConfig?: AgentLayerConfig;
  },
  tools: ReturnType<typeof createWorkspaceTools>,
): Promise<AgentRegistry> {
  const modelConfig = buildModelConfig(options);
  const { checkpointer, store: memoryStore } = await getLangGraphMemoryBackend();
  const layerSpecialists = options.layerConfig?.specialists.filter((specialist) => specialist.defaultEnabled) ?? [];
  const enabledAgentIds = new Set(
    layerSpecialists.length > 0
      ? layerSpecialists.map((specialist) => specialist.agentId)
      : options.productProfile?.defaultAgentSkillNames ?? AGENT_DEFS.map((def) => def.id),
  );

  const createAgentWithSkill = async (def: AgentDef): Promise<LangGraphAgentClient | null> => {
    if (!enabledAgentIds.has(def.id)) return null;

    const specialistConfig = layerSpecialists.find((specialist) => specialist.agentId === def.id);
    const fallbackInstructions = specialistConfig?.instructionOverride?.trim()
      || await loadSkillInstructions(store, def.id, options.productProfile);
    const skillPromptName = options.productProfile && options.productProfile.id !== PRODUCT_PROFILE.id
      ? `${options.productProfile.id}-${def.id}-skill`
      : `${def.id}-skill`;
    const [instructions] = await Promise.all([
      getPromptText(skillPromptName, fallbackInstructions),
      getPromptText(`${def.id}-working-memory`, def.workingMemoryTemplate),
    ]);
    if (!instructions) return null;

    const agentInstructions = [instructions, AGENT_MEMORY_TOOL_PROTOCOL].join('\n\n');
    return createLangGraphAgentClient({
      id: def.id,
      name: def.name,
      instructions: agentInstructions,
      model: modelConfig,
      tools,
      checkpointer,
      store: memoryStore,
    });
  };

  const [brainstorm, character, continuity, story, sourceAnalyst, adaptationPlanner, screenwriter, reviewer, outline, knowledgeSearch, knowledgeOrganizer] = await Promise.all(
    AGENT_DEFS.map(createAgentWithSkill),
  );

  const createSystemAgent = async (instructions: string, toolsOverride?: LangGraphToolset): Promise<LangGraphAgentClient> => {
    const configuredInstructions = options.layerConfig?.systemAgent.instructionOverride?.trim() || instructions;
    const agentInstructions = [configuredInstructions, AGENT_MEMORY_TOOL_PROTOCOL].join('\n\n');
    return createLangGraphAgentClient({
      id: 'viforge-system-agent',
      name: 'viforge 系统调度',
      instructions: agentInstructions,
      model: modelConfig,
      tools: toolsOverride ?? tools,
      checkpointer,
      store: memoryStore,
    });
  };

  return { brainstorm, character, continuity, story, sourceAnalyst, adaptationPlanner, screenwriter, reviewer, outline, knowledgeSearch, knowledgeOrganizer, systemAgent: createSystemAgent };
}

async function loadSkillInstructions(store: WorkspaceStore, agentId: string, productProfile?: ProductProfile): Promise<string> {
  if (productProfile && productProfile.id !== PRODUCT_PROFILE.id) {
    try {
      return stripYamlFrontmatter(await readProductSkillPrompt(productProfile, agentId));
    } catch {
      // Fall back to the global agent config below for custom or legacy setups.
    }
  }

  try {
    const raw = (await store.readGlobalWorkspaceFile(`Agent 配置/skills/${agentId}/SKILL.md`)).content;
    return stripYamlFrontmatter(raw);
  } catch {
    if (!productProfile) return '';
    try {
      return stripYamlFrontmatter(await readProductSkillPrompt(productProfile, agentId));
    } catch {
      return '';
    }
  }
}

function stripYamlFrontmatter(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;

  let end = 1;
  while (end < lines.length && lines[end]?.trim() !== '---') {
    end++;
  }
  return lines.slice(end + 1).join('\n').trim();
}

export function buildModelConfig(options: {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  traceId?: string;
}): { model: string; baseUrl: string; apiKey: string; headers: Record<string, string> } {
  const rawId = options.model
    || process.env.VIFORGE_AIGC_HUB_CHAT_MODEL
    || process.env.AIGC_HUB_CHAT_MODEL
    || process.env.VIFORGE_LANGGRAPH_MODEL
    || 'MiniMax-M3';

  const baseUrl = options.baseUrl
    || process.env.VIFORGE_AIGC_HUB_BASE_URL
    || process.env.AIGC_HUB_BASE_URL
    || process.env.VIFORGE_LANGGRAPH_BASE_URL
    || process.env.OPENAI_BASE_URL
    || 'https://api.openai.com/v1';

  const apiKey = options.apiKey
    || process.env.VIFORGE_AIGC_HUB_API_KEY
    || process.env.AIGC_HUB_API_KEY
    || process.env.VIFORGE_LANGGRAPH_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.CODEX_API_KEY
    || '';

  return {
    model: rawId,
    baseUrl,
    apiKey,
    headers: buildAigcHubHeaders({ traceId: options.traceId }),
  };
}

function createChatModel(config: ReturnType<typeof buildModelConfig>): ChatOpenAI {
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey || 'missing-api-key',
    configuration: {
      baseURL: trimTrailingSlashes(config.baseUrl),
      defaultHeaders: config.headers,
    },
  });
}

function createLangGraphAgentClient(input: {
  id: string;
  name: string;
  instructions: string;
  model: ReturnType<typeof buildModelConfig>;
  tools: LangGraphToolset;
  checkpointer: BaseCheckpointSaver;
  store: BaseStore;
}): LangGraphAgentClient {
  const createRunnable = (options: Record<string, unknown>) => {
    const source = typeof options.source === 'string' ? options.source : undefined;
    const isEvalRun = source === 'eval';
    return createReactAgent({
      llm: createChatModel(input.model),
      tools: Object.values(input.tools).filter(isLangGraphTool),
      prompt: input.instructions,
      checkpointer: isEvalRun ? undefined : input.checkpointer,
      store: isEvalRun ? undefined : input.store,
      name: input.id,
    });
  };

  return {
    id: input.id,
    name: input.name,
    async stream(prompt, options) {
      const config = langGraphRunnableConfig(input.id, options);
      const runnable = createRunnable(options);
      return { fullStream: toLangGraphStreamChunks(runnable.streamEvents({ messages: toLangGraphMessages(prompt) }, config), input.id) };
    },
    async generate(prompt, options) {
      const config = langGraphRunnableConfig(input.id, options);
      const runnable = createRunnable(options);
      const output = await runnable.invoke({ messages: toLangGraphMessages(prompt) }, config);
      return { text: textFromMessages(Array.isArray(output.messages) ? output.messages : []) };
    },
  };
}

function toLangGraphMessages(input: LangGraphAgentInput): BaseMessage[] {
  if (typeof input === 'string') return [new HumanMessage(input)];
  return input.map((message) => message.role === 'assistant' ? new AIMessage(message.content) : new HumanMessage(message.content));
}

function isLangGraphTool(value: unknown): value is StructuredToolInterface {
  return Boolean(value && typeof value === 'object' && 'name' in value && 'invoke' in value);
}

function langGraphRunnableConfig(agentId: string, options: Record<string, unknown>) {
  const memory = options.memory as { thread?: string; resource?: string } | undefined;
  const viforgeRunId = typeof options.runId === 'string' ? options.runId : undefined;
  const traceId = typeof options.traceId === 'string' ? options.traceId : viforgeRunId;
  const projectId = typeof memory?.resource === 'string' ? memory.resource : undefined;
  const productId = typeof options.productId === 'string' ? options.productId : undefined;
  const source = typeof options.source === 'string' ? options.source : undefined;
  const maxSteps = typeof options.maxSteps === 'number' ? options.maxSteps : 25;
  return {
    version: 'v2' as const,
    recursionLimit: maxSteps * 2,
    runName: agentId,
    tags: [agentId, 'viforge', 'langgraph', productId, source].filter((tag): tag is string => Boolean(tag)),
    metadata: {
      viforge_run_id: viforgeRunId,
      viforge_trace_id: traceId,
      viforge_agent_id: agentId,
      viforge_project_id: projectId,
      viforge_product_id: productId,
      viforge_source: source,
    },
    callbacks: [],
    configurable: {
      thread_id: memory?.thread ?? viforgeRunId ?? `${agentId}-${Date.now()}`,
      resource_id: memory?.resource,
    },
  };
}

async function* toLangGraphStreamChunks(events: AsyncIterable<unknown>, agentId: string): AsyncIterable<LangGraphStreamChunk> {
  const toolNamesByRunId = new Map<string, string>();
  for await (const event of events) {
    const record = event as Record<string, unknown>;
    const eventName = typeof record.event === 'string' ? record.event : '';
    const data = record.data as Record<string, unknown> | undefined;
    const runId = typeof record.run_id === 'string' ? record.run_id : randomId();

    if (eventName === 'on_chat_model_stream') {
      if (!isOwnAgentStreamEvent(record, agentId)) continue;
      const chunk = data?.chunk;
      const text = textFromMessageChunk(chunk);
      if (text) yield { type: 'text-delta', payload: { text } };
      for (const toolCall of toolCallChunksFromMessage(chunk)) {
        yield { type: 'tool-call-delta', payload: toolCall };
      }
      continue;
    }

    if (eventName === 'on_tool_start') {
      const toolName = typeof record.name === 'string' ? record.name : 'tool';
      toolNamesByRunId.set(runId, toolName);
      yield { type: 'tool-call', payload: { toolCallId: runId, toolName, args: data?.input } };
      continue;
    }

    if (eventName === 'on_tool_end') {
      const toolName = toolNamesByRunId.get(runId) ?? (typeof record.name === 'string' ? record.name : 'tool');
      yield { type: 'tool-result', payload: { toolCallId: runId, toolName, result: sanitizeToolResult(data?.output) } };
    }
  }
}

function isOwnAgentStreamEvent(record: Record<string, unknown>, agentId: string): boolean {
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  const langgraphNode = typeof metadata?.langgraph_node === 'string' ? metadata.langgraph_node : undefined;
  if (langgraphNode && langgraphNode !== agentId && langgraphNode !== 'agent') return false;

  const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const hasDifferentAgentTag = tags.some((tag) => tag.endsWith('-agent') && tag !== agentId);
  if (hasDifferentAgentTag) return false;

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function textFromMessageChunk(chunk: unknown): string {
  if (chunk instanceof AIMessageChunk || chunk instanceof AIMessage) return textFromContent(chunk.content);
  if (chunk && typeof chunk === 'object' && 'content' in chunk) return textFromContent((chunk as { content?: unknown }).content);
  return '';
}

function textFromMessages(messages: BaseMessage[]): string {
  const lastAi = messages.slice().reverse().find((message) => message instanceof AIMessage || message.getType?.() === 'ai');
  return lastAi ? textFromContent(lastAi.content) : '';
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
      return (part as { text: string }).text;
    }
    return '';
  }).join('');
}

function toolCallChunksFromMessage(chunk: unknown): Array<{ toolCallId: string; toolName: string; argsTextDelta: string }> {
  if (!chunk || typeof chunk !== 'object') return [];
  const chunks = (chunk as { tool_call_chunks?: unknown }).tool_call_chunks;
  if (!Array.isArray(chunks)) return [];
  return chunks.map((item, index) => {
    const record = item as Record<string, unknown>;
    return {
      toolCallId: typeof record.id === 'string' ? record.id : `tool_${index + 1}`,
      toolName: typeof record.name === 'string' ? record.name : 'tool',
      argsTextDelta: typeof record.args === 'string' ? record.args : '',
    };
  });
}

function sanitizeToolResult(output: unknown): unknown {
  if (output && typeof output === 'object' && 'content' in output) {
    return sanitizeToolOutputValue((output as { content?: unknown }).content).output;
  }
  return sanitizeToolOutputValue(output).output;
}

async function safeBrowserToolCall(execute: () => Promise<unknown>): Promise<unknown> {
  try {
    return await execute();
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      hint: '请确认已安装 Playwriter CLI、浏览器扩展已授权当前标签页，并已启动 playwriter serve。',
    };
  }
}
