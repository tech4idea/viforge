import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import type {
  ChatMessage,
  ChatMessageAttachment,
  GeminiImageAspectRatio,
  GeminiImageModel,
  GeminiImageThinkingLevel,
  ImageGenerationResponse,
} from '@viforge/shared';

import type { ChatSessionStore } from '../chat/chatSessionStore';
import { buildAigcHubHeaders, gatewayTraceIdFromResponse, traceIdFromRequest } from '../aigcHubHeaders';
import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL, AIGC_HUB_IMAGE_MODEL } from '../env';
import { appendJsonLog } from '../logger';
import type { WorkspaceStore } from '../storage/workspaceStore';

const imageModels = ['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'] as const;
const aspectRatios = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
const thinkingLevels = ['minimal', 'low', 'medium', 'high'] as const;

const referenceImageSchema = z.object({
  name: z.string().trim().min(1),
  mimeType: z.string().trim().regex(/^image\/(png|jpe?g|webp)$/i),
  contentBase64: z.string().min(1),
});

const imageGenerationSchema = z.object({
  sessionId: z.string().min(1).optional(),
  productId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  aspectRatio: z.enum(aspectRatios),
  thinkingLevel: z.enum(thinkingLevels).optional(),
  count: z.number().int().min(1).max(4),
  referenceImages: z.array(referenceImageSchema).max(6).default([]),
});

type AigcHubImage = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
};

type AigcHubImageResponse = {
  data?: AigcHubImage[];
  error?: string | { message?: string };
};

type GeneratedImageResult = ImageGenerationResponse & {
  gatewayTraceId: string;
};

export function createImageGenerationRoutes(chatStore: ChatSessionStore, workspaceStore: WorkspaceStore): Hono {
  const routes = new Hono();

  routes.post('/image-generations', async (context) => {
    const traceId = traceIdFromRequest(context.req.raw);
    const parsed = imageGenerationSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid image generation request' }, 400);
    }

    const gatewayBaseUrl = process.env.VIFORGE_AIGC_HUB_BASE_URL ?? AIGC_HUB_BASE_URL;
    const gatewayApiKey = process.env.VIFORGE_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY;
    const defaultModel = process.env.VIFORGE_AIGC_HUB_IMAGE_MODEL ?? AIGC_HUB_IMAGE_MODEL;
    if (!gatewayBaseUrl || !gatewayApiKey) {
      return context.json({ error: '未配置 VIFORGE_AIGC_HUB_BASE_URL 或 VIFORGE_AIGC_HUB_API_KEY，无法通过 AIGC Hub 生成图片。' }, 400);
    }

    const selectedModel = parsed.data.model || defaultModel || undefined;

    try {
      const response = await generateImages({
        ...parsed.data,
        model: selectedModel,
        gatewayBaseUrl,
        gatewayApiKey,
        traceId,
        chatStore,
        workspaceStore,
      });
      context.header('traceid', response.gatewayTraceId);
      return context.json(response, 201);
    } catch (error) {
      console.error('[image-generation] request failed', {
        sessionId: parsed.data.sessionId ?? null,
        model: selectedModel ?? null,
        aspectRatio: parsed.data.aspectRatio,
        thinkingLevel: parsed.data.thinkingLevel ?? null,
        referenceImageCount: parsed.data.referenceImages.length,
      }, error);
      return context.json({ error: errorToMessage(error) }, 500);
    }
  });

  return routes;
}

async function generateImages(input: {
  gatewayBaseUrl: string;
  gatewayApiKey: string;
  traceId: string;
  chatStore: ChatSessionStore;
  workspaceStore: WorkspaceStore;
  sessionId?: string;
  productId?: string;
  prompt: string;
  model?: string;
  aspectRatio: GeminiImageAspectRatio;
  thinkingLevel?: GeminiImageThinkingLevel;
  count: number;
  referenceImages: Array<{ name: string; mimeType: string; contentBase64: string }>;
}): Promise<GeneratedImageResult> {
  const now = new Date().toISOString();
  const session = input.sessionId
    ? await input.chatStore.getSession(input.sessionId)
    : await createImageSession(input.chatStore, input.workspaceStore, input.productId);

  if (!session) {
    throw new Error('图片会话不存在');
  }
  if (hasRunningAssistantMessage(session.messages)) {
    throw new Error('当前会话正在运行，请等待完成或停止后再发送。');
  }
  if (input.model && isLegacyGeminiImageModel(input.model)) {
    assertSupportedThinkingLevel(input.model, input.thinkingLevel);
  }

  const referenceAttachments = await Promise.all(
    input.referenceImages.map((image, index) =>
      saveReferenceImage(input.workspaceStore, session.projectId, image, input.prompt, input.model, input.aspectRatio, input.thinkingLevel, index, now),
    ),
  );
  const userMessage = createChatMessage('user', input.prompt, {
    attachments: referenceAttachments,
  });
  await input.chatStore.appendMessage(session.id, userMessage);

  const generatedAttachments: ChatMessageAttachment[] = [];
  const textParts: string[] = [];
  let gatewayTraceId = input.traceId;

  try {
    const response = await requestAigcHubImages(input.gatewayBaseUrl, input.gatewayApiKey, {
      model: input.model,
      prompt: buildImagePrompt(input.prompt, input.referenceImages.length),
      aspectRatio: input.aspectRatio,
      count: input.count,
      traceId: input.traceId,
    });
    gatewayTraceId = response.gatewayTraceId;

    for (const image of response.data ?? []) {
      if (typeof image.revised_prompt === 'string' && image.revised_prompt.trim()) {
        textParts.push(image.revised_prompt.trim());
      }

      const imageData = await imageDataFromAigcHubImage(image);
      if (imageData) {
        const attachment = await saveGeneratedImage(
          input.workspaceStore,
          session.projectId,
          imageData.contentBase64,
          imageData.mimeType,
          input.prompt,
          input.model,
          input.aspectRatio,
          input.thinkingLevel,
          generatedAttachments.length,
          now,
        );
        generatedAttachments.push(attachment);
      }
    }

    if (generatedAttachments.length === 0) {
      throw new Error(textParts[0] || 'AIGC Hub 未返回图片结果');
    }
  } catch (error) {
    await input.chatStore.appendMessage(session.id, createChatMessage('assistant', `图片生成失败：${errorToMessage(error)}`, { status: 'error' }));
    throw error;
  }

  const assistantMessage = createChatMessage('assistant', buildAssistantContent(generatedAttachments, textParts), {
    attachments: generatedAttachments,
    status: 'success',
  });

  const updatedSession = await input.chatStore.appendMessage(session.id, assistantMessage);
  if (!updatedSession) {
    throw new Error('图片会话写入失败');
  }

  appendJsonLog('api-image-generations.jsonl', {
    event: 'image-generation.success',
    traceId: gatewayTraceId,
    sessionId: session.id,
    projectId: session.projectId,
    model: input.model ?? null,
    aspectRatio: input.aspectRatio,
    thinkingLevel: input.thinkingLevel ?? null,
    requestedCount: input.count,
    generatedCount: generatedAttachments.length,
    referenceImageCount: referenceAttachments.length,
  });

  return { session: updatedSession, userMessage, assistantMessage, gatewayTraceId };
}

function hasRunningAssistantMessage(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' && message.status === 'running');
}

async function createImageSession(chatStore: ChatSessionStore, workspaceStore: WorkspaceStore, productId?: string) {
  const project = await workspaceStore.createTemporaryProject({ productId });
  return chatStore.createSession(project.id, { kind: 'image', title: '图片生成' });
}

async function requestAigcHubImages(
  gatewayBaseUrl: string,
  gatewayApiKey: string,
  input: { model?: string; prompt: string; aspectRatio: GeminiImageAspectRatio; count: number; traceId: string },
): Promise<AigcHubImageResponse & { gatewayTraceId: string }> {
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
  return { ...body, gatewayTraceId: gatewayTraceIdFromResponse(response, input.traceId) };
}

async function parseAigcHubJson(response: Response): Promise<AigcHubImageResponse> {
  try {
    return await response.json() as AigcHubImageResponse;
  } catch {
    return {};
  }
}

function errorMessageFromAigcHubBody(body: AigcHubImageResponse): string | null {
  if (!body.error) {
    return null;
  }
  return typeof body.error === 'string' ? body.error : body.error.message ?? null;
}

async function imageDataFromAigcHubImage(image: AigcHubImage): Promise<{ contentBase64: string; mimeType: string } | null> {
  if (image.b64_json) {
    return { contentBase64: stripDataUrlPrefix(image.b64_json), mimeType: mimeTypeFromDataUrl(image.b64_json) ?? 'image/png' };
  }
  if (!image.url) {
    return null;
  }
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

function buildImagePrompt(prompt: string, referenceImageCount: number): string {
  if (referenceImageCount === 0) {
    return prompt;
  }
  return `${prompt}\n\n用户同时上传了 ${referenceImageCount} 张参考图。当前 AIGC Hub 图片生成接口不接收参考图内容，请尽量根据文字需求生成。`;
}

function imageSizeFromAspectRatio(aspectRatio: GeminiImageAspectRatio): string {
  switch (aspectRatio) {
    case '16:9':
      return '1536x1024';
    case '9:16':
      return '1024x1536';
    case '4:3':
      return '1536x1024';
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

function assertSupportedThinkingLevel(model: GeminiImageModel, thinkingLevel?: GeminiImageThinkingLevel): void {
  if (!thinkingLevel) {
    return;
  }

  if (model === 'gemini-3-pro-image-preview' && thinkingLevel !== 'low' && thinkingLevel !== 'high') {
    throw new Error('gemini-3-pro-image-preview 的思考强度只支持 low 或 high');
  }
}

function isLegacyGeminiImageModel(model: string): model is GeminiImageModel {
  return (imageModels as readonly string[]).includes(model);
}

async function saveReferenceImage(
  workspaceStore: WorkspaceStore,
  projectId: string,
  image: { name: string; mimeType: string; contentBase64: string },
  prompt: string,
  model: string | undefined,
  aspectRatio: GeminiImageAspectRatio,
  thinkingLevel: GeminiImageThinkingLevel | undefined,
  index: number,
  createdAt: string,
): Promise<ChatMessageAttachment> {
  const extension = extensionFromMimeType(image.mimeType) ?? extensionFromName(image.name) ?? 'png';
  const path = `参考图片/${timestampForFileName(createdAt)}-${String(index + 1).padStart(2, '0')}-${safeFileName(image.name, extension)}`;
  const entry = await workspaceStore.createWorkspaceAsset(projectId, path, Buffer.from(image.contentBase64, 'base64'), image.mimeType);
  return {
    id: `attachment-${randomUUID()}`,
    kind: 'reference-image',
    name: entry.name,
    path: entry.path,
    projectId,
    mimeType: image.mimeType,
    prompt,
    model,
    aspectRatio,
    thinkingLevel,
    createdAt,
  };
}

async function saveGeneratedImage(
  workspaceStore: WorkspaceStore,
  projectId: string,
  contentBase64: string,
  mimeType: string,
  prompt: string,
  model: string | undefined,
  aspectRatio: GeminiImageAspectRatio,
  thinkingLevel: GeminiImageThinkingLevel | undefined,
  index: number,
  createdAt: string,
): Promise<ChatMessageAttachment> {
  const extension = extensionFromMimeType(mimeType) ?? 'png';
  const path = `生成图片/${timestampForFileName(createdAt)}-${String(index + 1).padStart(2, '0')}.${extension}`;
  const entry = await workspaceStore.createWorkspaceAsset(projectId, path, Buffer.from(contentBase64, 'base64'), mimeType);
  return {
    id: `attachment-${randomUUID()}`,
    kind: 'generated-image',
    name: entry.name,
    path: entry.path,
    projectId,
    mimeType,
    prompt,
    model,
    aspectRatio,
    thinkingLevel,
    createdAt,
  };
}

function createChatMessage(
  role: ChatMessage['role'],
  content: string,
  options: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    attachments: options.attachments ?? [],
    referencedFiles: [],
    referencedSnippets: [],
    streamEvents: [],
    status: options.status,
  };
}

function buildAssistantContent(attachments: ChatMessageAttachment[], textParts: string[]): string {
  const summary = `已生成 ${attachments.length} 张图片。`;
  const text = Array.from(new Set(textParts)).join('\n\n').trim();
  return text ? `${summary}\n\n${text}` : summary;
}

function safeFileName(name: string, fallbackExtension: string): string {
  const extension = extensionFromName(name) ?? fallbackExtension;
  const baseName = name
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'reference';
  return `${baseName}.${extension}`;
}

function extensionFromName(name: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : null;
}

function extensionFromMimeType(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  return null;
}

function timestampForFileName(value: string): string {
  return value.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : '图片生成失败';
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
