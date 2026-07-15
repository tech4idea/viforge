import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { createRuntimeConfigRoutes } from './runtimeConfig';
import { applyRuntimeConfigToEnv, createRuntimeConfigStore } from '../runtimeConfigStore';

const tempDirs: string[] = [];
const originalDesktop = process.env.VIFORGE_DESKTOP;
const originalDatabaseMode = process.env.VIFORGE_DATABASE_MODE;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalChatBaseUrl = process.env.VIFORGE_AIGC_HUB_CHAT_BASE_URL;
const originalChatApiKey = process.env.VIFORGE_AIGC_HUB_CHAT_API_KEY;
const originalImageBaseUrl = process.env.VIFORGE_AIGC_HUB_IMAGE_BASE_URL;
const originalImageApiKey = process.env.VIFORGE_AIGC_HUB_IMAGE_API_KEY;
const originalEmbeddingBaseUrl = process.env.VIFORGE_AIGC_HUB_EMBEDDING_BASE_URL;
const originalEmbeddingApiKey = process.env.VIFORGE_AIGC_HUB_EMBEDDING_API_KEY;
const originalGlobalApiKey = process.env.VIFORGE_AIGC_HUB_API_KEY;
const originalLegacyApiKey = process.env.AIGC_HUB_API_KEY;
const originalPgvectorAvailable = process.env.VIFORGE_PGVECTOR_AVAILABLE;
const originalMemoryReindexRequired = process.env.VIFORGE_MEMORY_EMBEDDING_REINDEX_REQUIRED;

afterEach(async () => {
  restoreEnv('VIFORGE_DESKTOP', originalDesktop);
  restoreEnv('VIFORGE_DATABASE_MODE', originalDatabaseMode);
  restoreEnv('DATABASE_URL', originalDatabaseUrl);
  restoreEnv('VIFORGE_AIGC_HUB_CHAT_BASE_URL', originalChatBaseUrl);
  restoreEnv('VIFORGE_AIGC_HUB_CHAT_API_KEY', originalChatApiKey);
  restoreEnv('VIFORGE_AIGC_HUB_IMAGE_BASE_URL', originalImageBaseUrl);
  restoreEnv('VIFORGE_AIGC_HUB_IMAGE_API_KEY', originalImageApiKey);
  restoreEnv('VIFORGE_AIGC_HUB_EMBEDDING_BASE_URL', originalEmbeddingBaseUrl);
  restoreEnv('VIFORGE_AIGC_HUB_EMBEDDING_API_KEY', originalEmbeddingApiKey);
  restoreEnv('VIFORGE_AIGC_HUB_API_KEY', originalGlobalApiKey);
  restoreEnv('AIGC_HUB_API_KEY', originalLegacyApiKey);
  restoreEnv('VIFORGE_PGVECTOR_AVAILABLE', originalPgvectorAvailable);
  restoreEnv('VIFORGE_MEMORY_EMBEDDING_REINDEX_REQUIRED', originalMemoryReindexRequired);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime config routes', () => {
  it('returns desktop-friendly default OpenAI-compatible model values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viforge-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    const response = await app.request('/runtime-config');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      modelProvider: {
        baseUrl: 'https://api.openai.com/v1',
        chatModel: 'gpt-5.5',
      },
    });
  });

  it('forces embedded PostgreSQL in desktop mode even when legacy config points to an external database', async () => {
    process.env.VIFORGE_DESKTOP = '1';
    process.env.DATABASE_URL = 'postgresql://legacy:password@db.example.test:5432/viforge';

    applyRuntimeConfigToEnv({
      database: {
        mode: 'external-postgres',
        connectionString: 'postgresql://writer:password@db.example.test:5432/viforge',
        vectorStore: 'pgvector',
      },
    });

    expect(process.env.VIFORGE_DATABASE_MODE).toBe('embedded-postgres');
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
  it('validates model test requests without requiring network when the API key is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viforge-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    const response = await app.request('/runtime-config/test-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelProvider: { baseUrl: 'https://api.openai.com/v1', apiKey: '', chatModel: 'gpt-5.5' } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      message: '请先填写 API Key 后再测试。',
    });
  });

  it('persists OpenAI-compatible model and database configuration without returning secrets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viforge-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    const saveResponse = await app.request('/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelProvider: {
          baseUrl: 'https://models.example.test/v1',
          apiKey: 'secret-key',
          chatBaseUrl: 'https://chat.example.test/v1',
          chatApiKey: 'chat-secret-key',
          chatModel: 'gpt-compatible-chat',
          imageBaseUrl: 'https://image.example.test/v1',
          imageApiKey: 'image-secret-key',
          imageModel: 'image-compatible',
          embeddingBaseUrl: 'https://embedding.example.test/v1',
          embeddingApiKey: 'embedding-secret-key',
          embeddingModel: 'embedding-compatible',
          embeddingDims: 1536,
        },
        database: {
          mode: 'external-postgres',
          connectionString: 'postgresql://writer:password@db.example.test:5432/viforge',
          vectorStore: 'pgvector',
        },
      }),
    });

    expect(saveResponse.status).toBe(200);
    const saved = await saveResponse.json();
    expect(saved.modelProvider).toMatchObject({
      baseUrl: 'https://models.example.test/v1',
      apiKeyConfigured: true,
      chatBaseUrl: 'https://chat.example.test/v1',
      chatApiKeyConfigured: true,
      chatUsesGlobalConfig: false,
      chatModel: 'gpt-compatible-chat',
      imageBaseUrl: 'https://image.example.test/v1',
      imageApiKeyConfigured: true,
      imageUsesGlobalConfig: false,
      imageModel: 'image-compatible',
      embeddingBaseUrl: 'https://embedding.example.test/v1',
      embeddingApiKeyConfigured: true,
      embeddingUsesGlobalConfig: false,
      embeddingModel: 'embedding-compatible',
      embeddingDims: 1536,
    });
    expect(saved.database).toMatchObject({
      mode: 'external-postgres',
      connectionStringConfigured: true,
      connectionString: 'postgresql://writer:***@db.example.test:5432/viforge',
      vectorStore: 'pgvector',
    });

    const readResponse = await app.request('/runtime-config');
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      modelProvider: {
        apiKeyConfigured: true,
        chatBaseUrl: 'https://chat.example.test/v1',
        chatApiKeyConfigured: true,
        imageBaseUrl: 'https://image.example.test/v1',
        imageApiKeyConfigured: true,
        embeddingBaseUrl: 'https://embedding.example.test/v1',
        embeddingApiKeyConfigured: true,
      },
      database: { mode: 'external-postgres', connectionStringConfigured: true },
    });
  });


  it('marks long-term memory reindex required when embedding config changes and clears it after rebuild', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viforge-runtime-config-'));
    tempDirs.push(root);
    const store = createRuntimeConfigStore(path.join(root, 'runtime-config.json'));
    const app = createRuntimeConfigRoutes(store);

    const response = await app.request('/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelProvider: {
          embeddingBaseUrl: 'https://embedding.example.test/v1',
          embeddingModel: 'embedding-compatible-v2',
          embeddingDims: 1536,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      memory: {
        reindexRequired: true,
        embeddingProfile: {
          baseUrl: 'https://embedding.example.test/v1',
          model: 'embedding-compatible-v2',
          dims: 1536,
        },
      },
    });
    expect(process.env.VIFORGE_MEMORY_EMBEDDING_REINDEX_REQUIRED).toBe('1');

    const rebuilt = await store.markMemoryEmbeddingReindexed({ reindexedAt: '2026-07-13T00:00:00.000Z' });

    expect(rebuilt.memory).toMatchObject({
      reindexRequired: false,
      indexedEmbeddingProfile: {
        baseUrl: 'https://embedding.example.test/v1',
        model: 'embedding-compatible-v2',
        dims: 1536,
      },
      lastReindexedAt: '2026-07-13T00:00:00.000Z',
    });
    expect(process.env.VIFORGE_MEMORY_EMBEDDING_REINDEX_REQUIRED).toBeUndefined();
  });

  it('does not clear memory reindex state when embedding index backend is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viforge-runtime-config-'));
    tempDirs.push(root);
    const store = createRuntimeConfigStore(path.join(root, 'runtime-config.json'));
    const workspaceStore = {
      async listProjects() {
        return [{ id: 'project-1', name: 'Project', description: '', createdAt: '', updatedAt: '' }];
      },
    };
    const app = createRuntimeConfigRoutes(store, workspaceStore as never);

    await app.request('/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelProvider: {
          embeddingBaseUrl: 'https://embedding.example.test/v1',
          embeddingModel: 'embedding-compatible-v2',
          embeddingDims: 1536,
        },
      }),
    });

    process.env.DATABASE_URL = 'postgresql://writer:password@127.0.0.1:5432/viforge';
    delete process.env.VIFORGE_AIGC_HUB_API_KEY;
    delete process.env.AIGC_HUB_API_KEY;
    delete process.env.VIFORGE_AIGC_HUB_EMBEDDING_API_KEY;
    delete process.env.VIFORGE_PGVECTOR_AVAILABLE;

    const rebuildResponse = await app.request('/runtime-config/rebuild-memory-index', { method: 'POST' });

    expect(rebuildResponse.status).toBe(409);
    expect(await rebuildResponse.json()).toMatchObject({ error: expect.stringContaining('Embedding 模型或 API Key 未配置') });

    const configResponse = await app.request('/runtime-config');
    const configBody = await configResponse.json() as { memory: { reindexRequired: boolean; indexedEmbeddingProfile?: unknown } };
    expect(configBody.memory.reindexRequired).toBe(true);
    expect(configBody.memory.indexedEmbeddingProfile).toBeUndefined();
    expect(process.env.VIFORGE_MEMORY_EMBEDDING_REINDEX_REQUIRED).toBe('1');
  });
  it('does not carry an external connection string into embedded PostgreSQL mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viforge-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    await app.request('/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        database: {
          mode: 'external-postgres',
          connectionString: 'postgresql://writer:password@db.example.test:5432/viforge',
          vectorStore: 'pgvector',
        },
      }),
    });

    const embeddedResponse = await app.request('/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ database: { mode: 'embedded-postgres', vectorStore: 'pgvector' } }),
    });

    expect(embeddedResponse.status).toBe(200);
    expect(await embeddedResponse.json()).toMatchObject({
      database: {
        mode: 'embedded-postgres',
        connectionString: 'postgresql://127.0.0.1:15432/viforge',
        vectorStore: 'pgvector',
      },
    });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

