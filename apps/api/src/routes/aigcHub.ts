import { Hono } from 'hono';

import type { AigcHubModelListResponse, AigcHubModelMetadata } from '@viwork/shared';

import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL } from '../env';

type RawModel = Record<string, unknown>;

export function createAigcHubRoutes(): Hono {
  const routes = new Hono();

  routes.get('/aigc-hub/models', async (context) => {
    const gatewayBaseUrl = process.env.VIWORK_AIGC_HUB_BASE_URL ?? AIGC_HUB_BASE_URL;
    const gatewayApiKey = process.env.VIWORK_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY;
    if (!gatewayBaseUrl || !gatewayApiKey) {
      return context.json({ configured: false, models: [], error: '未配置 VIWORK_AIGC_HUB_BASE_URL 或 VIWORK_AIGC_HUB_API_KEY。' } satisfies AigcHubModelListResponse);
    }

    try {
      const adminResult = await requestModelList(aigcHubAdminModelsUrl(gatewayBaseUrl), gatewayApiKey);
      if (adminResult.models.length > 0) {
        return context.json({ configured: true, models: adminResult.models } satisfies AigcHubModelListResponse);
      }

      const publicResult = await requestModelList(aigcHubPublicModelsUrl(gatewayBaseUrl), gatewayApiKey);
      if (publicResult.models.length > 0) {
        return context.json({ configured: true, models: publicResult.models } satisfies AigcHubModelListResponse);
      }

      return context.json({
        configured: true,
        models: [],
        error: publicResult.error ?? adminResult.error ?? 'AIGC Hub 没有返回可用模型。',
      } satisfies AigcHubModelListResponse);
    } catch (error) {
      return context.json({
        configured: true,
        models: [],
        error: error instanceof Error ? error.message : 'AIGC Hub 模型列表请求失败',
      } satisfies AigcHubModelListResponse, 502);
    }
  });

  return routes;
}

async function requestModelList(url: string, apiKey: string): Promise<{ models: AigcHubModelMetadata[]; error?: string }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
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
