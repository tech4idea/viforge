import { Agent } from '@mastra/core/agent';
import { TokenLimiterProcessor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { PostgresStore } from '@mastra/pg';
import { QdrantVector } from '@mastra/qdrant';
import { Memory } from '@mastra/memory';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { AigcHubModelMetadata, ChatMessageAttachment, GeminiImageAspectRatio, RunImageGenerationOptions, StreamEvent } from '@viwork/shared';

import { buildAigcHubHeaders } from '../aigcHubHeaders';
import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL, AIGC_HUB_IMAGE_MODEL, DATABASE_URL, EMBEDDING_MODEL, QDRANT_URL } from '../env';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { WechatSendContext } from './runService';

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
};

export type MastraToolset = ReturnType<typeof createWorkspaceTools> & Record<string, unknown>;

type AgentDef = {
  id: string;
  name: string;
  skillFile: string;
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
  systemAgent: (instructions: string, toolsOverride?: MastraToolset) => MastraAgentClient;
};

const AGENT_DEFS: AgentDef[] = [
  {
    id: 'brainstorm-agent',
    name: '脑暴助手',
    skillFile: 'Agent 配置/skills/brainstorm-agent/SKILL.md',
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
    skillFile: 'Agent 配置/skills/character-agent/SKILL.md',
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
    skillFile: 'Agent 配置/skills/continuity-agent/SKILL.md',
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
    skillFile: 'Agent 配置/skills/source-analyst-agent/SKILL.md',
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
    skillFile: 'Agent 配置/skills/adaptation-planner-agent/SKILL.md',
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
    skillFile: 'Agent 配置/skills/screenwriter-agent/SKILL.md',
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
    skillFile: 'Agent 配置/skills/reviewer-agent/SKILL.md',
    workingMemoryTemplate: [
      '# 审稿记忆',
      '- 高频问题模式：',
      '- 质量标准要点：',
      '- 已通过项：',
      '- 待修复项：',
    ].join('\n'),
  },
];

export function createWorkspaceTools(
  store: WorkspaceStore,
  projectId: string,
  publish: (event: StreamEvent) => void,
  runId: string,
  emittedAt: () => string,
  options: { imageGeneration?: RunImageGenerationOptions; traceId?: string; wechat?: WechatSendContext } = {},
) {
  const tools: Record<string, ReturnType<typeof createTool>> = {
    list_workspace_entries: createTool({
      id: 'list_workspace_entries',
      description: '列出当前项目工作区中的所有文件和目录',
      inputSchema: z.object({}),
      execute: async () => ({ entries: await store.listWorkspaceEntries(projectId) }),
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
    read_global_file: createTool({
      id: 'read_global_file',
      description: '读取全局工作区中的 UTF-8 文本文件，如知识库、模板或 Agent 配置。',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: filePath }) => store.readGlobalWorkspaceFile(filePath),
    }),
    generate_project_image: createTool({
      id: 'generate_project_image',
      description: [
        '通过 AIGC Hub 生成图片，并保存到当前项目工作区的“生成图片/”目录。',
        '当用户明确要求生成、绘制、出图、生成角色图/场景图/剧照/分镜图/海报时使用。',
        '普通视觉描述或提示词整理不需要调用此工具。',
        '不要猜测或填写模型名；工具会自动使用前端/微信会话配置的图片模型，未配置时使用 VIWORK_AIGC_HUB_IMAGE_MODEL。',
      ].join('\n'),
      inputSchema: z.object({
        prompt: z.string().min(1),
        aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).default('1:1'),
        count: z.number().int().min(1).max(4).default(1),
      }),
      execute: async ({ prompt, aspectRatio, count }) => {
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
          const imagePath = `生成图片/${timestampForFileName(now)}-${String(index + 1).padStart(2, '0')}.${extension}`;
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

        return { images: generated, attachments };
      },
    }),
    edit_project_image: createTool({
      id: 'edit_project_image',
      description: [
        '修改工作区中已有的图片。读取指定图片作为参考，结合文字描述生成修改后的新图片。',
        '当用户要求修改、调整、优化某张已有图片时使用（如"把这张图的角色换个表情"、"调整场景光线"）。',
        '不要猜测或填写模型名；工具会自动使用配置的图片模型。',
      ].join('\n'),
      inputSchema: z.object({
        imagePath: z.string().min(1).describe('工作区中待修改图片的路径，可通过 list_workspace_entries 查看'),
        prompt: z.string().min(1).describe('图片修改描述，说明需要如何修改原图'),
        aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).default('1:1'),
        count: z.number().int().min(1).max(4).default(1),
      }),
      execute: async ({ imagePath, prompt, aspectRatio, count }) => {
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
          const editedPath = `生成图片/${timestampForFileName(now)}-edit-${String(index + 1).padStart(2, '0')}.${extension}`;
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

        return { images: generated, sourceImagePath: imagePath, attachments };
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

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function workspaceFileExists(store: WorkspaceStore, projectId: string, filePath: string): Promise<boolean> {
  try {
    await store.readWorkspaceFile(projectId, filePath);
    return true;
  } catch {
    return false;
  }
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
  },
  tools: ReturnType<typeof createWorkspaceTools>,
): Promise<AgentRegistry> {
  const connectionString = options.connectionString ?? DATABASE_URL;
  const qdrantUrl = options.qdrantUrl ?? QDRANT_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required for Mastra agent memory storage.');
  }

  const modelConfig = buildModelConfig(options);

  const vector = qdrantUrl ? new QdrantVector({ id: 'viwork-qdrant', url: qdrantUrl }) : undefined;
  const embedder = vector ? buildEmbedder(options) : undefined;
  const semanticRecallEnabled = Boolean(vector && embedder);

  const loadSkillInstructions = async (skillFile: string): Promise<string> => {
    try {
      const raw = (await store.readGlobalWorkspaceFile(skillFile)).content;
      return stripYamlFrontmatter(raw);
    } catch {
      return '';
    }
  };

  const createAgentWithSkill = async (def: AgentDef): Promise<MastraAgentClient | null> => {
    const instructions = await loadSkillInstructions(def.skillFile);
    if (!instructions) return null;

    const storage = new PostgresStore({ id: `viwork-${def.id}`, connectionString });
    const memory = new Memory({
      storage,
      ...(vector ? { vector } : {}),
      ...(embedder ? { embedder } : {}),
      options: {
        lastMessages: 8,
        semanticRecall: semanticRecallEnabled,
        workingMemory: { enabled: true, scope: 'resource', template: def.workingMemoryTemplate },
      },
    });

    return new Agent({
      id: def.id,
      name: def.name,
      instructions,
      model: modelConfig,
      tools,
      memory,
      inputProcessors: [new TokenLimiterProcessor({ limit: 500_000, strategy: 'truncate' })],
    }) as unknown as MastraAgentClient;
  };

  const [brainstorm, character, continuity, sourceAnalyst, adaptationPlanner, screenwriter, reviewer] = await Promise.all(
    AGENT_DEFS.map(createAgentWithSkill),
  );

  const createSystemAgent = (instructions: string, toolsOverride?: MastraToolset): MastraAgentClient => {
    const storage = new PostgresStore({ id: 'viwork-system-agent', connectionString });
    const memory = new Memory({
      storage,
      ...(vector ? { vector } : {}),
      ...(embedder ? { embedder } : {}),
      options: {
        lastMessages: 20,
        semanticRecall: semanticRecallEnabled,
        workingMemory: {
          enabled: true,
          scope: 'resource',
          template: [
            '# viwork 项目记忆',
            '- 用户偏好：',
            '- 项目长期设定：',
            '- 角色与关系：',
            '- 待回收伏笔：',
            '- 专家协作摘要：',
          ].join('\n'),
        },
      },
    });

    return new Agent({
      id: 'viwork-system-agent',
      name: 'viwork 系统调度',
      instructions,
      model: modelConfig,
      tools: toolsOverride ?? tools,
      memory,
      inputProcessors: [new TokenLimiterProcessor({ limit: 800_000, strategy: 'truncate' })],
    }) as unknown as MastraAgentClient;
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
