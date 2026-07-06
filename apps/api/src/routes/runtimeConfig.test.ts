import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { createRuntimeConfigRoutes } from './runtimeConfig';
import { createRuntimeConfigStore } from '../runtimeConfigStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime config routes', () => {
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
