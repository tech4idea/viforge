import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockRunService } from '../runs/mockRunService';
import { createWorkspaceStore, type WorkspaceStore } from '../storage/workspaceStore';
import { createRunsRoutes } from './runs';

let root: string;
let app: Hono;
let store: WorkspaceStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-run-routes-'));
  store = createWorkspaceStore(root);
  app = new Hono().route('/api', createRunsRoutes(createMockRunService(store)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runs routes', () => {
  it('creates a mock web run and returns file change events', async () => {
    const project = await store.createProject({ name: 'Run Route Writers' });

    const response = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '  Outline episode beats.  ' }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.run).toMatchObject({
      id: expect.stringMatching(/^run_/),
      projectId: project.id,
      prompt: 'Outline episode beats.',
      source: 'web',
      referencedFiles: [],
      status: 'success',
    });
    expect(body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.step.start', agentId: 'adaptation-planner-agent' }),
      expect.objectContaining({ type: 'agent.workflow.end', outputPath: '02 改编方案/01 第一集/单集改编方案.md' }),
      expect.objectContaining({ type: 'file.changed' }),
    ]));
  });

  it('accepts referenced files and returns them on the run', async () => {
    const project = await store.createProject({ name: 'Reference Route Writers' });

    const response = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        prompt: '根据设定写对白',
        referencedFiles: [{ path: 'characters.md', label: 'characters.md' }],
        referencedSnippets: [{
          id: 'snippet-1',
          messageId: 'message-1',
          role: 'assistant',
          label: '创作助手片段',
          text: '商场失物招领处',
          createdAt: '2026-05-18T00:00:00.000Z',
        }],
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.run.referencedFiles).toEqual([{ path: 'characters.md', label: 'characters.md' }]);
    expect(body.run.referencedSnippets).toEqual([expect.objectContaining({ text: '商场失物招领处' })]);
    expect(body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text.delta', text: expect.stringContaining('参考文件：characters.md') }),
      ]),
    );
  });

  it('rejects missing or blank project ids and prompts', async () => {
    for (const body of [
      { prompt: 'Write a scene.' },
      { projectId: 'project-id' },
      { projectId: '   ', prompt: 'Write a scene.' },
      { projectId: 'project-id', prompt: '   ' },
    ]) {
      const response = await app.request('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    }
  });

  it('returns 400 for invalid project ids and 404 for missing projects without creating phantom workspaces', async () => {
    const invalidResponse = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: '../outside', prompt: 'Write a scene.' }),
    });

    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toEqual({ error: 'Invalid project' });

    const missingProjectId = 'missing-project';
    const missingResponse = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: missingProjectId, prompt: 'Write a scene.' }),
    });

    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({ error: 'Project not found' });
    await expect(store.getProject(missingProjectId)).resolves.toBeUndefined();
    expect(existsSync(path.join(root, missingProjectId))).toBe(false);
  });
});
