import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RuntimeConfig, RuntimeMemoryEmbeddingProfile, UpdateRuntimeConfigInput } from '@viforge/shared';

import { resetLangGraphMemoryBackend } from './runs/langGraphAgents';

import {
  AIGC_HUB_API_KEY,
  AIGC_HUB_BASE_URL,
  AIGC_HUB_CHAT_MODEL,
  AIGC_HUB_IMAGE_MODEL,
  DATABASE_URL,
  EMBEDDING_MODEL,
  WORKSPACES_ROOT,
} from './env';

type StoredRuntimeConfig = {
  modelProvider?: {
    baseUrl?: string;
    apiKey?: string;
    chatBaseUrl?: string;
    chatApiKey?: string;
    chatModel?: string;
    imageBaseUrl?: string;
    imageApiKey?: string;
    imageModel?: string;
    embeddingBaseUrl?: string;
    embeddingApiKey?: string;
    embeddingModel?: string;
    embeddingDims?: number;
  };
  database?: {
    mode?: RuntimeConfig['database']['mode'];
    connectionString?: string;
    customAdapter?: string;
    vectorStore?: RuntimeConfig['database']['vectorStore'];
  };
  memory?: {
    embeddingProfile?: RuntimeMemoryEmbeddingProfile;
    reindexRequired?: boolean;
    lastReindexedAt?: string;
  };
};

const DEFAULT_DATABASE_PORT = 15432;
const DEFAULT_MODEL_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CHAT_MODEL = 'gpt-5.5';

export type RuntimeConfigStore = {
  getConfig(): Promise<RuntimeConfig>;
  updateConfig(input: UpdateRuntimeConfigInput): Promise<RuntimeConfig>;
  markMemoryEmbeddingReindexed(input?: { reindexedAt?: string }): Promise<RuntimeConfig>;
};

const CONFIG_PATH = path.resolve(WORKSPACES_ROOT, '..', 'runtime-config.json');

export function createRuntimeConfigStore(configPath = CONFIG_PATH): RuntimeConfigStore {
  async function readStored(): Promise<StoredRuntimeConfig> {
    try {
      return JSON.parse(await readFile(configPath, 'utf8')) as StoredRuntimeConfig;
    } catch (error) {
      if (isNotFoundError(error)) return {};
      throw error;
    }
  }

  async function writeStored(config: StoredRuntimeConfig): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  return {
    async getConfig() {
      return toRuntimeConfig(await readStored());
    },
    async updateConfig(input) {
      const current = await readStored();
      const previousEmbeddingProfile = effectiveEmbeddingProfile(current);
      const next: StoredRuntimeConfig = {
        modelProvider: {
          ...current.modelProvider,
          ...cleanModelProviderInput(input.modelProvider),
        },
        database: {
          ...current.database,
          ...cleanDatabaseInput(input.database),
        },
        memory: current.memory,
      };
      const nextEmbeddingProfile = effectiveEmbeddingProfile(next);
      const embeddingChanged = !sameEmbeddingProfile(previousEmbeddingProfile, nextEmbeddingProfile);
      if (embeddingChanged) {
        next.memory = {
          ...current.memory,
          reindexRequired: true,
        };
      }

      if (process.env.VIFORGE_DESKTOP === '1') {
        next.database = { mode: 'embedded-postgres', vectorStore: 'pgvector' };
      } else if (next.database?.mode && next.database.mode !== 'external-postgres') {
        next.database.connectionString = '';
      }

      await writeStored(next);
      applyRuntimeConfigToEnv(next);
      if (embeddingChanged) resetLangGraphMemoryBackend();
      return toRuntimeConfig(next, true);
    },
    async markMemoryEmbeddingReindexed(input = {}) {
      const current = await readStored();
      const next: StoredRuntimeConfig = {
        ...current,
        memory: {
          ...current.memory,
          embeddingProfile: effectiveEmbeddingProfile(current),
          reindexRequired: false,
          lastReindexedAt: input.reindexedAt ?? new Date().toISOString(),
        },
      };
      await writeStored(next);
      applyRuntimeConfigToEnv(next);
      resetLangGraphMemoryBackend();
      return toRuntimeConfig(next);
    },
  };
}

export async function loadRuntimeConfigIntoEnv(): Promise<RuntimeConfig> {
  const store = createRuntimeConfigStore();
  const stored = await readStoredConfig(CONFIG_PATH);
  applyRuntimeConfigToEnv(stored);
  return store.getConfig();
}

export function applyRuntimeConfigToEnv(config: StoredRuntimeConfig): void {
  const model = config.modelProvider;
  if (model?.baseUrl !== undefined) process.env.VIFORGE_AIGC_HUB_BASE_URL = model.baseUrl;
  if (model?.apiKey !== undefined) process.env.VIFORGE_AIGC_HUB_API_KEY = model.apiKey;
  if (model?.chatBaseUrl !== undefined) process.env.VIFORGE_AIGC_HUB_CHAT_BASE_URL = model.chatBaseUrl;
  if (model?.chatApiKey !== undefined) process.env.VIFORGE_AIGC_HUB_CHAT_API_KEY = model.chatApiKey;
  if (model?.chatModel !== undefined) process.env.VIFORGE_AIGC_HUB_CHAT_MODEL = model.chatModel;
  if (model?.imageBaseUrl !== undefined) process.env.VIFORGE_AIGC_HUB_IMAGE_BASE_URL = model.imageBaseUrl;
  if (model?.imageApiKey !== undefined) process.env.VIFORGE_AIGC_HUB_IMAGE_API_KEY = model.imageApiKey;
  if (model?.imageModel !== undefined) process.env.VIFORGE_AIGC_HUB_IMAGE_MODEL = model.imageModel;
  if (model?.embeddingBaseUrl !== undefined) process.env.VIFORGE_AIGC_HUB_EMBEDDING_BASE_URL = model.embeddingBaseUrl;
  if (model?.embeddingApiKey !== undefined) process.env.VIFORGE_AIGC_HUB_EMBEDDING_API_KEY = model.embeddingApiKey;
  if (model?.embeddingModel !== undefined) process.env.VIFORGE_AIGC_HUB_EMBEDDING_MODEL = model.embeddingModel;
  if (model?.embeddingDims !== undefined) process.env.VIFORGE_LANGGRAPH_STORE_EMBEDDING_DIMS = String(model.embeddingDims);
  if (config.memory?.reindexRequired) process.env.VIFORGE_MEMORY_EMBEDDING_REINDEX_REQUIRED = '1';
  else delete process.env.VIFORGE_MEMORY_EMBEDDING_REINDEX_REQUIRED;

  const database = effectiveDatabaseConfig(config.database);
  if (database?.mode !== undefined) process.env.VIFORGE_DATABASE_MODE = database.mode;
  if (database?.mode === 'external-postgres') {
    if (database.connectionString) {
      process.env.DATABASE_URL = database.connectionString;
    } else {
      delete process.env.DATABASE_URL;
    }
  } else if (database?.mode === 'embedded-postgres') {
    if (process.env.VIFORGE_DESKTOP === '1') {
      delete process.env.DATABASE_URL;
    } else if (!process.env.DATABASE_URL) {
      delete process.env.DATABASE_URL;
    }
  } else if (database?.mode === 'custom') {
    delete process.env.DATABASE_URL;
  }
}

function toRuntimeConfig(config: StoredRuntimeConfig, restartRequired = false): RuntimeConfig {
  const model = config.modelProvider ?? {};
  const database = effectiveDatabaseConfig(config.database);
  const databaseMode = database.mode ?? process.env.VIFORGE_DATABASE_MODE as RuntimeConfig['database']['mode'] | undefined ?? (process.env.VIFORGE_DESKTOP === '1' ? 'embedded-postgres' : 'external-postgres');
  const configuredConnectionString = databaseMode === 'external-postgres'
    ? database.connectionString ?? process.env.DATABASE_URL ?? DATABASE_URL
    : databaseMode === 'embedded-postgres'
      ? process.env.VIFORGE_DESKTOP === '1' ? process.env.DATABASE_URL ?? DATABASE_URL : ''
      : database.connectionString ?? '';
  const connectionStringConfigured = databaseMode === 'embedded-postgres' || Boolean(configuredConnectionString);
  const displayConnectionString = configuredConnectionString || defaultConnectionStringForDisplay(databaseMode);

  const globalBaseUrl = model.baseUrl || process.env.VIFORGE_AIGC_HUB_BASE_URL || AIGC_HUB_BASE_URL || DEFAULT_MODEL_BASE_URL;
  const globalApiKeyConfigured = Boolean(model.apiKey ?? process.env.VIFORGE_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY);
  const chatBaseUrl = model.chatBaseUrl || process.env.VIFORGE_AIGC_HUB_CHAT_BASE_URL || globalBaseUrl;
  const imageBaseUrl = model.imageBaseUrl || process.env.VIFORGE_AIGC_HUB_IMAGE_BASE_URL || globalBaseUrl;
  const embeddingBaseUrl = model.embeddingBaseUrl || process.env.VIFORGE_AIGC_HUB_EMBEDDING_BASE_URL || globalBaseUrl;
  const chatApiKeyConfigured = Boolean(model.chatApiKey ?? process.env.VIFORGE_AIGC_HUB_CHAT_API_KEY) || globalApiKeyConfigured;
  const imageApiKeyConfigured = Boolean(model.imageApiKey ?? process.env.VIFORGE_AIGC_HUB_IMAGE_API_KEY) || globalApiKeyConfigured;
  const embeddingApiKeyConfigured = Boolean(model.embeddingApiKey ?? process.env.VIFORGE_AIGC_HUB_EMBEDDING_API_KEY) || globalApiKeyConfigured;
  const embeddingProfile = effectiveEmbeddingProfile(config);
  const indexedEmbeddingProfile = config.memory?.embeddingProfile;
  const reindexRequired = Boolean(config.memory?.reindexRequired || (indexedEmbeddingProfile && !sameEmbeddingProfile(indexedEmbeddingProfile, embeddingProfile)));

  return {
    modelProvider: {
      baseUrl: globalBaseUrl,
      apiKeyConfigured: globalApiKeyConfigured,
      chatBaseUrl,
      chatApiKeyConfigured,
      chatUsesGlobalConfig: !model.chatBaseUrl && !process.env.VIFORGE_AIGC_HUB_CHAT_BASE_URL && !model.chatApiKey && !process.env.VIFORGE_AIGC_HUB_CHAT_API_KEY,
      chatModel: model.chatModel || process.env.VIFORGE_AIGC_HUB_CHAT_MODEL || AIGC_HUB_CHAT_MODEL || DEFAULT_CHAT_MODEL,
      imageBaseUrl,
      imageApiKeyConfigured,
      imageUsesGlobalConfig: !model.imageBaseUrl && !process.env.VIFORGE_AIGC_HUB_IMAGE_BASE_URL && !model.imageApiKey && !process.env.VIFORGE_AIGC_HUB_IMAGE_API_KEY,
      imageModel: model.imageModel ?? process.env.VIFORGE_AIGC_HUB_IMAGE_MODEL ?? AIGC_HUB_IMAGE_MODEL,
      embeddingBaseUrl,
      embeddingApiKeyConfigured,
      embeddingUsesGlobalConfig: !model.embeddingBaseUrl && !process.env.VIFORGE_AIGC_HUB_EMBEDDING_BASE_URL && !model.embeddingApiKey && !process.env.VIFORGE_AIGC_HUB_EMBEDDING_API_KEY,
      embeddingModel: model.embeddingModel ?? process.env.VIFORGE_AIGC_HUB_EMBEDDING_MODEL ?? EMBEDDING_MODEL,
      embeddingDims: model.embeddingDims ?? Number(process.env.VIFORGE_LANGGRAPH_STORE_EMBEDDING_DIMS ?? '3072'),
    },
    database: {
      mode: databaseMode,
      connectionStringConfigured,
      connectionString: maskConnectionString(displayConnectionString),
      customAdapter: database.customAdapter,
      vectorStore: database.vectorStore ?? 'pgvector',
      status: databaseMode === 'embedded-postgres' ? embeddedDatabaseStatus() : configuredConnectionString ? 'ready' : 'unknown',
      statusMessage: databaseStatusMessage(databaseMode, configuredConnectionString),
    },
    desktop: {
      enabled: process.env.VIFORGE_DESKTOP === '1',
      dataRoot: process.env.VIFORGE_DESKTOP_DATA_ROOT,
    },
    memory: {
      embeddingProfile,
      indexedEmbeddingProfile,
      reindexRequired,
      statusMessage: reindexRequired
        ? 'Embedding 配置已变化，长期记忆向量索引需要重建后才能继续检索和写入。'
        : '长期记忆向量索引与当前 Embedding 配置一致。',
      lastReindexedAt: config.memory?.lastReindexedAt,
    },
    restartRequired,
  };
}

function effectiveEmbeddingProfile(config: StoredRuntimeConfig): RuntimeMemoryEmbeddingProfile {
  const model = config.modelProvider ?? {};
  const globalBaseUrl = model.baseUrl || process.env.VIFORGE_AIGC_HUB_BASE_URL || AIGC_HUB_BASE_URL || DEFAULT_MODEL_BASE_URL;
  return {
    baseUrl: model.embeddingBaseUrl || process.env.VIFORGE_AIGC_HUB_EMBEDDING_BASE_URL || globalBaseUrl,
    model: model.embeddingModel || process.env.VIFORGE_AIGC_HUB_EMBEDDING_MODEL || EMBEDDING_MODEL || 'text-embedding-3-large',
    dims: model.embeddingDims ?? Number(process.env.VIFORGE_LANGGRAPH_STORE_EMBEDDING_DIMS ?? '3072'),
  };
}

function sameEmbeddingProfile(a: RuntimeMemoryEmbeddingProfile | undefined, b: RuntimeMemoryEmbeddingProfile | undefined): boolean {
  return Boolean(a && b && a.baseUrl === b.baseUrl && a.model === b.model && a.dims === b.dims);
}
function effectiveDatabaseConfig(database: StoredRuntimeConfig['database']): NonNullable<StoredRuntimeConfig['database']> {
  if (process.env.VIFORGE_DESKTOP === '1') {
    return { mode: 'embedded-postgres', vectorStore: 'pgvector' };
  }
  return database ?? {};
}

function databaseStatusMessage(mode: RuntimeConfig['database']['mode'], connectionString: string): string {
  if (mode === 'embedded-postgres' && process.env.VIFORGE_EMBEDDED_POSTGRES_STATUS === 'error') {
    return process.env.VIFORGE_EMBEDDED_POSTGRES_ERROR || '内置 PostgreSQL 启动失败，请检查数据路径和日志。';
  }
  if (mode === 'embedded-postgres' && connectionString) return '内置 PostgreSQL 已启动，LangGraph memory 使用本地 pgvector。';
  if (mode === 'embedded-postgres') return '桌面模式启动时会拉起内置 PostgreSQL，LangGraph memory 使用本地 pgvector。';
  if (mode === 'external-postgres' && connectionString) return 'LangGraph memory uses the configured external PostgreSQL database.';
  if (mode === 'custom') return '自定义适配器配置已保存，需等对应 LangGraph adapter 接入后生效。';
  return 'Database is not configured yet.';
}

function defaultConnectionStringForDisplay(mode: RuntimeConfig['database']['mode']): string {
  if (mode !== 'embedded-postgres') return '';
  const port = Number(process.env.VIFORGE_EMBEDDED_POSTGRES_PORT ?? DEFAULT_DATABASE_PORT);
  return `postgresql://127.0.0.1:${port}/viforge`;
}

function embeddedDatabaseStatus(): RuntimeConfig['database']['status'] {
  if (process.env.VIFORGE_EMBEDDED_POSTGRES_STATUS === 'error') return 'error';
  return process.env.DATABASE_URL || process.env.VIFORGE_DESKTOP !== '1' ? 'ready' : 'starting';
}

function cleanModelProviderInput(input: UpdateRuntimeConfigInput['modelProvider']): StoredRuntimeConfig['modelProvider'] {
  if (!input) return undefined;
  return {
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey.trim() } : {}),
    ...(input.chatBaseUrl !== undefined ? { chatBaseUrl: input.chatBaseUrl.trim() } : {}),
    ...(input.chatApiKey !== undefined ? { chatApiKey: input.chatApiKey.trim() } : {}),
    ...(input.chatModel !== undefined ? { chatModel: input.chatModel.trim() } : {}),
    ...(input.imageBaseUrl !== undefined ? { imageBaseUrl: input.imageBaseUrl.trim() } : {}),
    ...(input.imageApiKey !== undefined ? { imageApiKey: input.imageApiKey.trim() } : {}),
    ...(input.imageModel !== undefined ? { imageModel: input.imageModel.trim() } : {}),
    ...(input.embeddingBaseUrl !== undefined ? { embeddingBaseUrl: input.embeddingBaseUrl.trim() } : {}),
    ...(input.embeddingApiKey !== undefined ? { embeddingApiKey: input.embeddingApiKey.trim() } : {}),
    ...(input.embeddingModel !== undefined ? { embeddingModel: input.embeddingModel.trim() } : {}),
    ...(input.embeddingDims !== undefined ? { embeddingDims: input.embeddingDims } : {}),
  };
}

function cleanDatabaseInput(input: UpdateRuntimeConfigInput['database']): StoredRuntimeConfig['database'] {
  if (!input) return undefined;
  return {
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.connectionString !== undefined ? { connectionString: input.connectionString.trim() } : {}),
    ...(input.customAdapter !== undefined ? { customAdapter: input.customAdapter.trim() } : {}),
    ...(input.vectorStore !== undefined ? { vectorStore: input.vectorStore } : {}),
  };
}

async function readStoredConfig(configPath: string): Promise<StoredRuntimeConfig> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as StoredRuntimeConfig;
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }
}

function maskConnectionString(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username ? `${url.username}` : '';
    return url.toString();
  } catch {
    return value.replace(/:[^:@/]+@/, ':***@');
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
