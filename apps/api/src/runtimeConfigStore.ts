import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RuntimeConfig, UpdateRuntimeConfigInput } from '@viwork/shared';

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
    chatModel?: string;
    imageModel?: string;
    embeddingModel?: string;
    embeddingDims?: number;
  };
  database?: {
    mode?: RuntimeConfig['database']['mode'];
    connectionString?: string;
    customAdapter?: string;
    vectorStore?: RuntimeConfig['database']['vectorStore'];
  };
};

const DEFAULT_DATABASE_PORT = 15432;

export type RuntimeConfigStore = {
  getConfig(): Promise<RuntimeConfig>;
  updateConfig(input: UpdateRuntimeConfigInput): Promise<RuntimeConfig>;
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
      const next: StoredRuntimeConfig = {
        modelProvider: {
          ...current.modelProvider,
          ...cleanModelProviderInput(input.modelProvider),
        },
        database: {
          ...current.database,
          ...cleanDatabaseInput(input.database),
        },
      };

      if (next.database?.mode && next.database.mode !== 'external-postgres') {
        next.database.connectionString = '';
      }

      await writeStored(next);
      applyRuntimeConfigToEnv(next);
      return toRuntimeConfig(next, true);
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
  if (model?.baseUrl !== undefined) process.env.VIWORK_AIGC_HUB_BASE_URL = model.baseUrl;
  if (model?.apiKey !== undefined) process.env.VIWORK_AIGC_HUB_API_KEY = model.apiKey;
  if (model?.chatModel !== undefined) process.env.VIWORK_AIGC_HUB_CHAT_MODEL = model.chatModel;
  if (model?.imageModel !== undefined) process.env.VIWORK_AIGC_HUB_IMAGE_MODEL = model.imageModel;
  if (model?.embeddingModel !== undefined) process.env.VIWORK_AIGC_HUB_EMBEDDING_MODEL = model.embeddingModel;
  if (model?.embeddingDims !== undefined) process.env.VIWORK_LANGGRAPH_STORE_EMBEDDING_DIMS = String(model.embeddingDims);

  const database = config.database;
  if (database?.mode !== undefined) process.env.VIWORK_DATABASE_MODE = database.mode;
  if (database?.mode === 'external-postgres') {
    if (database.connectionString) {
      process.env.DATABASE_URL = database.connectionString;
    } else {
      delete process.env.DATABASE_URL;
    }
  } else if (database?.mode === 'embedded-postgres') {
    if (process.env.VIWORK_DESKTOP !== '1') delete process.env.DATABASE_URL;
  } else if (database?.mode === 'custom') {
    delete process.env.DATABASE_URL;
  }
}

function toRuntimeConfig(config: StoredRuntimeConfig, restartRequired = false): RuntimeConfig {
  const model = config.modelProvider ?? {};
  const database = config.database ?? {};
  const databaseMode = database.mode ?? process.env.VIWORK_DATABASE_MODE as RuntimeConfig['database']['mode'] | undefined ?? (process.env.VIWORK_DESKTOP === '1' ? 'embedded-postgres' : 'external-postgres');
  const configuredConnectionString = databaseMode === 'external-postgres'
    ? database.connectionString ?? process.env.DATABASE_URL ?? DATABASE_URL
    : databaseMode === 'embedded-postgres'
      ? process.env.VIWORK_DESKTOP === '1' ? process.env.DATABASE_URL ?? DATABASE_URL : ''
      : database.connectionString ?? '';
  const connectionStringConfigured = databaseMode === 'embedded-postgres' || Boolean(configuredConnectionString);
  const displayConnectionString = configuredConnectionString || defaultConnectionStringForDisplay(databaseMode);

  return {
    modelProvider: {
      baseUrl: model.baseUrl ?? process.env.VIWORK_AIGC_HUB_BASE_URL ?? AIGC_HUB_BASE_URL,
      apiKeyConfigured: Boolean(model.apiKey ?? process.env.VIWORK_AIGC_HUB_API_KEY ?? AIGC_HUB_API_KEY),
      chatModel: model.chatModel ?? process.env.VIWORK_AIGC_HUB_CHAT_MODEL ?? AIGC_HUB_CHAT_MODEL,
      imageModel: model.imageModel ?? process.env.VIWORK_AIGC_HUB_IMAGE_MODEL ?? AIGC_HUB_IMAGE_MODEL,
      embeddingModel: model.embeddingModel ?? process.env.VIWORK_AIGC_HUB_EMBEDDING_MODEL ?? EMBEDDING_MODEL,
      embeddingDims: model.embeddingDims ?? Number(process.env.VIWORK_LANGGRAPH_STORE_EMBEDDING_DIMS ?? '1024'),
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
      enabled: process.env.VIWORK_DESKTOP === '1',
      dataRoot: process.env.VIWORK_DESKTOP_DATA_ROOT,
    },
    restartRequired,
  };
}

function databaseStatusMessage(mode: RuntimeConfig['database']['mode'], connectionString: string): string {
  if (mode === 'embedded-postgres' && connectionString) return '内置 PostgreSQL 已启动，LangGraph memory 使用本地 pgvector。';
  if (mode === 'embedded-postgres') return '桌面模式启动时会拉起内置 PostgreSQL，LangGraph memory 使用本地 pgvector。';
  if (mode === 'external-postgres' && connectionString) return 'LangGraph memory uses the configured external PostgreSQL database.';
  if (mode === 'custom') return '自定义适配器配置已保存，需等对应 LangGraph adapter 接入后生效。';
  return 'Database is not configured yet.';
}

function defaultConnectionStringForDisplay(mode: RuntimeConfig['database']['mode']): string {
  if (mode !== 'embedded-postgres') return '';
  const port = Number(process.env.VIWORK_EMBEDDED_POSTGRES_PORT ?? DEFAULT_DATABASE_PORT);
  return `postgresql://127.0.0.1:${port}/viwork`;
}

function embeddedDatabaseStatus(): RuntimeConfig['database']['status'] {
  return process.env.DATABASE_URL || process.env.VIWORK_DESKTOP !== '1' ? 'ready' : 'starting';
}

function cleanModelProviderInput(input: UpdateRuntimeConfigInput['modelProvider']): StoredRuntimeConfig['modelProvider'] {
  if (!input) return undefined;
  return {
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey.trim() } : {}),
    ...(input.chatModel !== undefined ? { chatModel: input.chatModel.trim() } : {}),
    ...(input.imageModel !== undefined ? { imageModel: input.imageModel.trim() } : {}),
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
