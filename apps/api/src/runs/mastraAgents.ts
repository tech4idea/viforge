import { exec } from 'node:child_process';

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { TokenLimiterProcessor, type Processor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { PostgresStore } from '@mastra/pg';
import { QdrantVector } from '@mastra/qdrant';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { LangfuseExporter } from '@mastra/langfuse';
import { SpanType } from '@mastra/core/observability';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { AigcHubModelMetadata, ChatMessageAttachment, GeminiImageAspectRatio, RunImageGenerationOptions, StreamEvent } from '@viwork/shared';

import { buildAigcHubHeaders } from '../aigcHubHeaders';
import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL, AIGC_HUB_IMAGE_MODEL, DATABASE_URL, EMBEDDING_MODEL, LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, QDRANT_URL } from '../env';
import type { GitService } from '../storage/gitService';
import type { GitConfigStore } from '../storage/gitConfigStore';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { WechatSendContext } from './runService';
import { getPromptText } from './langfusePromptStore';

export type MastraStreamChunk = {
  type: string;
  payload?: Record<string, unknown>;
  object?: unknown;
};

export type MastraStreamOutput = {
  fullStream: ReadableStream<MastraStreamChunk> | AsyncIterable<MastraStreamChunk>;
};

export type MastraAgentClient = {
  id?: string;
  name?: string;
  stream(messages: string, options: Record<string, unknown>): Promise<MastraStreamOutput>;
  generate(messages: string, options: Record<string, unknown>): Promise<{ text: string }>;
};

export type MastraToolset = ReturnType<typeof createWorkspaceTools> & Record<string, unknown>;

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
  brainstorm: MastraAgentClient | null;
  character: MastraAgentClient | null;
  continuity: MastraAgentClient | null;
  sourceAnalyst: MastraAgentClient | null;
  adaptationPlanner: MastraAgentClient | null;
  screenwriter: MastraAgentClient | null;
  reviewer: MastraAgentClient | null;
  systemAgent: (instructions: string, toolsOverride?: MastraToolset) => Promise<MastraAgentClient>;
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
];

function createProjectMemoryStore(options: { traceId?: string } = {}): Memory {
  const connectionString = DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for project memory tools.');
  const qdrantUrl = QDRANT_URL;
  const storage = new PostgresStore({ id: 'viwork-project-memory', connectionString });
  const vector = qdrantUrl ? new QdrantVector({ id: 'viwork-project-memory-qdrant', url: qdrantUrl }) : undefined;
  const embedder = vector ? buildEmbedder(options) : undefined;
  return new Memory({
    storage,
    ...(vector ? { vector } : {}),
    ...(embedder ? { embedder } : {}),
    options: {
      lastMessages: 0,
      semanticRecall: false,
      workingMemory: { enabled: true, scope: 'resource' as const },
    },
  });
}

export function createWorkspaceTools(
  store: WorkspaceStore,
  projectId: string,
  publish: (event: StreamEvent) => void,
  runId: string,
  emittedAt: () => string,
  options: { imageGeneration?: RunImageGenerationOptions; traceId?: string; wechat?: WechatSendContext; gitService?: GitService; gitConfigStore?: GitConfigStore } = {},
) {
  const projectMemory = createProjectMemoryStore({ traceId: options.traceId });
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
    read_project_memory: createTool({
      id: 'read_project_memory',
      description: [
        '读取当前项目的结构化长期记忆。',
        '当需要确认用户偏好、项目长期设定、角色关系、伏笔、质量标准等稳定信息时使用。',
        '不要把它当作普通聊天历史；普通短期上下文已经由系统保留。',
      ].join('\n'),
      inputSchema: z.object({}),
      execute: async () => {
        const memoryThreadId = await ensureProjectMemoryThread({ memory: projectMemory, resourceId: resource });
        const workingMemory = await projectMemory.getWorkingMemory({ threadId: memoryThreadId, resourceId: resource, memoryConfig: MEMORY_TOOL_CONFIG });
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
        const memoryThreadId = await ensureProjectMemoryThread({ memory: projectMemory, resourceId: resource });
        await projectMemory.updateWorkingMemory({ threadId: memoryThreadId, resourceId: resource, workingMemory: content, memoryConfig: MEMORY_TOOL_CONFIG });
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
        const memoryThreadId = await ensureProjectMemoryThread({ memory: projectMemory, resourceId: resource });
        const result = await projectMemory.recall({
          threadId: memoryThreadId,
          resourceId: resource,
          perPage: 0,
          threadConfig: {
            ...MEMORY_TOOL_CONFIG,
            semanticRecall: { ...AGENT_CONTROLLED_SEMANTIC_RECALL, topK },
          },
          vectorSearchString: query,
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
        const memoryThreadId = await ensureProjectMemoryThread({ memory: projectMemory, resourceId: resource });
        const content = [
          '# 精选长期记忆',
          `- category: ${category}`,
          `- reason: ${reason}`,
          '',
          memoryText,
        ].join('\n');
        const message = {
          id: `memory-${randomId()}-${Date.now()}`,
          type: 'text' as const,
          role: 'assistant' as const,
          content: { parts: [{ type: 'text' as const, text: content }], format: 2 as const },
          createdAt: new Date(),
          threadId: memoryThreadId,
          resourceId: resource,
        };
        const result = await projectMemory.saveMessages({ messages: [message], memoryConfig: MEMORY_TOOL_CONFIG });
        return { remembered: true, category, messageId: message.id, usage: result.usage };
      },
    }),
    generate_project_image: createTool({
      id: 'generate_project_image',
      description: [
        '通过 AIGC Hub 生成图片，并保存到当前项目工作区的”生成图片/”目录。',
        '当用户明确要求生成、绘制、出图、生成角色图/场景图/剧照/分镜图/海报时使用。',
        '普通视觉描述或提示词整理不需要调用此工具。',
        '缺省以时间戳命名；可通过 outputDir / fileName 自定义保存目录和文件主名（扩展名自动追加）。',
        '不要猜测或填写模型名；工具会自动使用前端/微信会话配置的图片模型，未配置时使用 VIWORK_AIGC_HUB_IMAGE_MODEL。',
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
        const gatewayBaseUrl = process.env.VIWORK_AIGC_HUB_BASE_URL ?? AIGC_HUB_BASE_URL;
        const gatewayApiKey = process.env.VIWORK_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY;
        const selectedModel = await resolveImageModel(gatewayBaseUrl, gatewayApiKey, options.imageGeneration?.model);

        if (!gatewayBaseUrl || !gatewayApiKey) {
          throw new Error('未配置 VIWORK_AIGC_HUB_BASE_URL 或 VIWORK_AIGC_HUB_API_KEY，无法通过 AIGC Hub 生成图片。');
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
        const gatewayBaseUrl = process.env.VIWORK_AIGC_HUB_BASE_URL ?? AIGC_HUB_BASE_URL;
        const gatewayApiKey = process.env.VIWORK_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY;
        const selectedModel = await resolveImageModel(gatewayBaseUrl, gatewayApiKey, options.imageGeneration?.model);

        if (!gatewayBaseUrl || !gatewayApiKey) {
          throw new Error('未配置 VIWORK_AIGC_HUB_BASE_URL 或 VIWORK_AIGC_HUB_API_KEY，无法通过 AIGC Hub 编辑图片。');
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
    const { ilinkClient, userId, contextToken } = options.wechat;
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
        await ilinkClient.sendFile({
          to: userId,
          bytes: asset.bytes,
          name: asset.path.split('/').pop() ?? asset.path,
          mimeType: asset.mimeType,
          contextToken,
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
  const envModel = process.env.VIWORK_AIGC_HUB_IMAGE_MODEL ?? AIGC_HUB_IMAGE_MODEL;

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

function projectMemoryThreadId(resourceId: string): string {
  return `${resourceId}::project-memory`;
}

async function ensureProjectMemoryThread(input: { memory: Memory; resourceId: string }): Promise<string> {
  const threadId = projectMemoryThreadId(input.resourceId);
  const existing = await input.memory.getThreadById({ threadId, resourceId: input.resourceId });
  if (!existing) {
    await input.memory.createThread({
      threadId,
      resourceId: input.resourceId,
      title: 'Project semantic memory',
      metadata: { kind: 'project-semantic-memory' },
      memoryConfig: MEMORY_TOOL_CONFIG,
    });
  }
  return threadId;
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

class BinaryDataSanitizer implements Processor<'binary-data-sanitizer'> {
  readonly id = 'binary-data-sanitizer' as const;
  readonly name = 'Binary Data Sanitizer';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processLLMRequest(args: any): any {
    const prompt = args.prompt as Array<{ role: string; content: unknown }>;
    if (!Array.isArray(prompt)) return undefined;
    let modified = false;

    for (const message of prompt) {
      if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
      const content = message.content as Array<{ type: string; output?: unknown }>;
      for (const part of content) {
        if (part.type !== 'tool-result' || !part.output) continue;
        const result = sanitizeToolOutputValue(part.output);
        if (result.changed) {
          part.output = result.output;
          modified = true;
        }
      }
    }

    if (!modified) return undefined;
    return { prompt };
  }
}

export function createObservabilityMastra(): Mastra | null {
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY || !LANGFUSE_BASE_URL) {
    return null;
  }

  return new Mastra({
    observability: new Observability({
      configs: {
        langfuse: {
          serviceName: 'viwork',
          exporters: [
            new LangfuseExporter({
              publicKey: LANGFUSE_PUBLIC_KEY,
              secretKey: LANGFUSE_SECRET_KEY,
              baseUrl: LANGFUSE_BASE_URL,
              realtime: true,
            }),
          ],
          excludeSpanTypes: [SpanType.MODEL_CHUNK],
        },
      },
    }),
  });
}

export async function createAgentRegistry(
  store: WorkspaceStore,
  options: {
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    connectionString?: string;
    qdrantUrl?: string;
    traceId?: string;
    observabilityMastra?: Mastra | null;
  },
  tools: ReturnType<typeof createWorkspaceTools>,
): Promise<AgentRegistry> {
  const connectionString = options.connectionString ?? DATABASE_URL;
  const qdrantUrl = options.qdrantUrl ?? QDRANT_URL;
  const obsMastra = options.observabilityMastra ?? null;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required for Mastra agent memory storage.');
  }

  const modelConfig = buildModelConfig(options);

  const vector = qdrantUrl ? new QdrantVector({ id: 'viwork-qdrant', url: qdrantUrl }) : undefined;
  const embedder = vector ? buildEmbedder(options) : undefined;
  const createAgentWithSkill = async (def: AgentDef): Promise<MastraAgentClient | null> => {
    const fallbackInstructions = await loadSkillInstructions(store, def.id);
    const [instructions, workingMemoryTemplate] = await Promise.all([
      getPromptText(`${def.id}-skill`, fallbackInstructions),
      getPromptText(`${def.id}-working-memory`, def.workingMemoryTemplate),
    ]);
    if (!instructions) return null;

    const agentInstructions = [instructions, AGENT_MEMORY_TOOL_PROTOCOL].join('\n\n');

    const storage = new PostgresStore({ id: `viwork-${def.id}`, connectionString });
    const memory = new Memory({
      storage,
      ...(vector ? { vector } : {}),
      ...(embedder ? { embedder } : {}),
      options: {
        lastMessages: 8,
        semanticRecall: false,
        workingMemory: { enabled: false, scope: 'resource', template: workingMemoryTemplate },
      },
    });

    const agent = new Agent({
      id: def.id,
      name: def.name,
      instructions: agentInstructions,
      model: modelConfig,
      tools,
      memory,
      inputProcessors: [new BinaryDataSanitizer(), new TokenLimiterProcessor({ limit: 500_000, strategy: 'truncate' })],
    });
    if (obsMastra) obsMastra.addAgent(agent);
    return agent as unknown as MastraAgentClient;
  };

  const [brainstorm, character, continuity, sourceAnalyst, adaptationPlanner, screenwriter, reviewer] = await Promise.all(
    AGENT_DEFS.map(createAgentWithSkill),
  );

  const createSystemAgent = async (instructions: string, toolsOverride?: MastraToolset): Promise<MastraAgentClient> => {
    const agentInstructions = [instructions, AGENT_MEMORY_TOOL_PROTOCOL].join('\n\n');
    const storage = new PostgresStore({ id: 'viwork-system-agent', connectionString });
    const memory = new Memory({
      storage,
      ...(vector ? { vector } : {}),
      ...(embedder ? { embedder } : {}),
      options: {
        lastMessages: 20,
        semanticRecall: false,
        workingMemory: { enabled: false, scope: 'resource' },
      },
    });

    const sysAgent = new Agent({
      id: 'viwork-system-agent',
      name: 'viwork 系统调度',
      instructions: agentInstructions,
      model: modelConfig,
      tools: toolsOverride ?? tools,
      memory,
      inputProcessors: [new BinaryDataSanitizer(), new TokenLimiterProcessor({ limit: 800_000, strategy: 'truncate' })],
    });
    if (obsMastra) obsMastra.addAgent(sysAgent);
    return sysAgent as unknown as MastraAgentClient;
  };

  return { brainstorm, character, continuity, sourceAnalyst, adaptationPlanner, screenwriter, reviewer, systemAgent: createSystemAgent };
}

function buildEmbedder(options: { baseUrl?: string; apiKey?: string; traceId?: string }) {
  const baseUrl = options.baseUrl
    || process.env.VIWORK_AIGC_HUB_BASE_URL
    || process.env.AIGC_HUB_BASE_URL
    || 'https://api.yukeon.top/v1';
  const apiKey = options.apiKey
    || process.env.VIWORK_AIGC_HUB_API_KEY
    || process.env.AIGC_HUB_API_KEY
    || '';

  const openai = createOpenAI({
    baseURL: trimTrailingSlashes(baseUrl),
    apiKey,
    headers: buildAigcHubHeaders({ traceId: options.traceId }),
  });

  return openai.embedding(EMBEDDING_MODEL);
}

async function loadSkillInstructions(store: WorkspaceStore, agentId: string): Promise<string> {
  try {
    const raw = (await store.readGlobalWorkspaceFile(`Agent 配置/skills/${agentId}/SKILL.md`)).content;
    return stripYamlFrontmatter(raw);
  } catch {
    return '';
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
}): OpenAICompatibleConfig {
  const rawId = options.model
    || process.env.VIWORK_AIGC_HUB_CHAT_MODEL
    || process.env.AIGC_HUB_CHAT_MODEL
    || process.env.VIWORK_MASTRA_MODEL
    || 'ds/deepseek-v4-pro';
  // Mastra parses id as provider/model and only sends model to the API.
  // Prepend openai/ so the gateway receives the full model path (e.g. gemini/gemini-3.1-pro-preview).
  const id = (`openai/${rawId}`) as `${string}/${string}`;

  const baseUrl = options.baseUrl
    || process.env.VIWORK_AIGC_HUB_BASE_URL
    || process.env.AIGC_HUB_BASE_URL
    || process.env.VIWORK_MASTRA_BASE_URL
    || process.env.OPENAI_BASE_URL
    || 'https://api.yukeon.top/v1';

  const apiKey = options.apiKey
    || process.env.VIWORK_AIGC_HUB_API_KEY
    || process.env.AIGC_HUB_API_KEY
    || process.env.VIWORK_MASTRA_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.CODEX_API_KEY
    || '';

  return {
    id: id as `${string}/${string}`,
    url: baseUrl,
    apiKey,
    headers: buildAigcHubHeaders({ traceId: options.traceId }),
  };
}
