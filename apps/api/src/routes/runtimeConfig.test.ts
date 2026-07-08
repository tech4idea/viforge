import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { createRuntimeConfigRoutes } from './runtimeConfig';
import { applyRuntimeConfigToEnv, createRuntimeConfigStore } from '../runtimeConfigStore';

const tempDirs: string[] = [];
const originalDesktop = process.env.VIWORK_DESKTOP;
const originalDatabaseMode = process.env.VIWORK_DATABASE_MODE;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(async () => {
  restoreEnv('VIWORK_DESKTOP', originalDesktop);
  restoreEnv('VIWORK_DATABASE_MODE', originalDatabaseMode);
  restoreEnv('DATABASE_URL', originalDatabaseUrl);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime config routes', () => {
  it('returns desktop-friendly default OpenAI-compatible model values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viwork-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    const response = await app.request('/runtime-config');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      modelProvider: {
        baseUrl: 'https://api.yukeon.top/v1',
        chatModel: 'MiniMax-M3',
      },
    });
  });

  it('forces embedded PostgreSQL in desktop mode even when legacy config points to an external database', async () => {
    process.env.VIWORK_DESKTOP = '1';
    process.env.DATABASE_URL = 'postgresql://legacy:password@db.example.test:5432/viwork';

    applyRuntimeConfigToEnv({
      database: {
        mode: 'external-postgres',
        connectionString: 'postgresql://writer:password@db.example.test:5432/viwork',
        vectorStore: 'pgvector',
      },
    });

    expect(process.env.VIWORK_DATABASE_MODE).toBe('embedded-postgres');
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
  it('validates model test requests without requiring network when the API key is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viwork-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    const response = await app.request('/runtime-config/test-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelProvider: { baseUrl: 'https://api.yukeon.top/v1', apiKey: '', chatModel: 'MiniMax-M3' } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      message: '请先填写 API Key 后再测试。',
    });
  });

  it('persists OpenAI-compatible model and database configuration without returning secrets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viwork-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    const saveResponse = await app.request('/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelProvider: {
          baseUrl: 'https://models.example.test/v1',
          apiKey: 'secret-key',
          chatModel: 'gpt-compatible-chat',
          embeddingModel: 'embedding-compatible',
          embeddingDims: 1536,
        },
        database: {
          mode: 'external-postgres',
          connectionString: 'postgresql://writer:password@db.example.test:5432/viwork',
          vectorStore: 'pgvector',
        },
      }),
    });

    expect(saveResponse.status).toBe(200);
    const saved = await saveResponse.json();
    expect(saved.modelProvider).toMatchObject({
      baseUrl: 'https://models.example.test/v1',
      apiKeyConfigured: true,
      chatModel: 'gpt-compatible-chat',
      embeddingModel: 'embedding-compatible',
      embeddingDims: 1536,
    });
    expect(saved.database).toMatchObject({
      mode: 'external-postgres',
      connectionStringConfigured: true,
      connectionString: 'postgresql://writer:***@db.example.test:5432/viwork',
      vectorStore: 'pgvector',
    });

    const readResponse = await app.request('/runtime-config');
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      modelProvider: { apiKeyConfigured: true },
      database: { mode: 'external-postgres', connectionStringConfigured: true },
    });
  });

  it('does not carry an external connection string into embedded PostgreSQL mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'viwork-runtime-config-'));
    tempDirs.push(root);
    const app = createRuntimeConfigRoutes(createRuntimeConfigStore(path.join(root, 'runtime-config.json')));

    await app.request('/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        database: {
          mode: 'external-postgres',
          connectionString: 'postgresql://writer:password@db.example.test:5432/viwork',
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
        connectionString: 'postgresql://127.0.0.1:15432/viwork',
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
