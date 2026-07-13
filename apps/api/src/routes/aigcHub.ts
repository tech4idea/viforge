import { Hono } from 'hono';

import type { AigcHubModelListResponse, AigcHubModelMetadata } from '@viforge/shared';

import { buildAigcHubHeaders } from '../aigcHubHeaders';
import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL } from '../env';

type RawModel = Record<string, unknown>;

export function createAigcHubRoutes(): Hono {
  const routes = new Hono();

  routes.get('/aigc-hub/models', async (context) => {
    const providers = configuredModelProviders();
    if (providers.length === 0) {
      return context.json({ configured: false, models: [], error: '未配置模型 Base URL 或 API Key。' } satisfies AigcHubModelListResponse);
    }

    try {
      const models = new Map<string, AigcHubModelMetadata>();
      const errors: string[] = [];
      for (const provider of providers) {
        const adminResult = await requestModelList(aigcHubAdminModelsUrl(provider.baseUrl), provider.apiKey);
        const publicResult = adminResult.models.length > 0
          ? { models: [] as AigcHubModelMetadata[], error: undefined as string | undefined }
          : await requestModelList(aigcHubPublicModelsUrl(provider.baseUrl), provider.apiKey);
        for (const model of [...adminResult.models, ...publicResult.models]) {
          models.set(model.id, { ...models.get(model.id), ...model });
        }
        const error = publicResult.error ?? adminResult.error;
        if (error) errors.push(error);
      }

      return context.json({
        configured: true,
        models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
        ...(models.size === 0 ? { error: errors[0] ?? '模型服务没有返回可用模型。' } : {}),
      } satisfies AigcHubModelListResponse);
    } catch (error) {
      return context.json({
        configured: true,
        models: [],
        error: error instanceof Error ? error.message : '模型列表请求失败',
      } satisfies AigcHubModelListResponse, 502);
    }
  });

  return routes;
}

function configuredModelProviders(): Array<{ baseUrl: string; apiKey: string }> {
  const globalBaseUrl = process.env.VIFORGE_AIGC_HUB_BASE_URL || AIGC_HUB_BASE_URL;
  const globalApiKey = process.env.VIFORGE_AIGC_HUB_API_KEY || AIGC_HUB_API_KEY;
  const providers = [
    { baseUrl: globalBaseUrl, apiKey: globalApiKey },
    { baseUrl: process.env.VIFORGE_AIGC_HUB_CHAT_BASE_URL || globalBaseUrl, apiKey: process.env.VIFORGE_AIGC_HUB_CHAT_API_KEY || globalApiKey },
    { baseUrl: process.env.VIFORGE_AIGC_HUB_IMAGE_BASE_URL || globalBaseUrl, apiKey: process.env.VIFORGE_AIGC_HUB_IMAGE_API_KEY || globalApiKey },
    { baseUrl: process.env.VIFORGE_AIGC_HUB_EMBEDDING_BASE_URL || globalBaseUrl, apiKey: process.env.VIFORGE_AIGC_HUB_EMBEDDING_API_KEY || globalApiKey },
  ].filter((provider) => provider.baseUrl && provider.apiKey);

  const seen = new Set<string>();
  return providers.filter((provider) => {
    const key = provider.baseUrl.replace(/\/+$/, '') + '\u0000' + provider.apiKey;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function requestModelList(url: string, apiKey: string): Promise<{ models: AigcHubModelMetadata[]; error?: string }> {
  const response = await fetch(url, {
    headers: buildAigcHubHeaders({ apiKey }),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    return { models: [], error: errorMessageFromBody(body) ?? `AIGC Hub 模型列表请求失败：${response.status}` };
  }
  return { models: normalizeModels(body) };
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

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeModels(body: unknown): AigcHubModelMetadata[] {
  const rawModels = rawModelArray(body);
  return rawModels
    .map(normalizeModel)
    .filter((model): model is AigcHubModelMetadata => Boolean(model));
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

  const nestedArray = findModelArray(body);
  if (nestedArray.length > 0) return nestedArray;

  return Object.entries(body)
    .filter(([, value]) => isRawModel(value))
    .map(([id, value]) => ({ id, ...(value as RawModel) }));
}

function findModelArray(value: unknown): RawModel[] {
  if (Array.isArray(value)) {
    const models = value.filter(isRawModel).filter((item) => stringField(item, ['id', 'model', 'name', 'slug']));
    return models.length > 0 ? models : [];
  }
  if (!isRawModel(value)) return [];

  for (const child of Object.values(value)) {
    const models = findModelArray(child);
    if (models.length > 0) return models;
  }
  return [];
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

function errorMessageFromBody(body: unknown): string | null {
  if (!isRawModel(body)) return null;
  const error = body.error;
  if (typeof error === 'string') return error;
  if (isRawModel(error) && typeof error.message === 'string') return error.message;
  if (typeof body.message === 'string') return body.message;
  return null;
}

export const __aigcHubRoutesTest = { aigcHubAdminModelsUrl, aigcHubPublicModelsUrl, normalizeModels };
