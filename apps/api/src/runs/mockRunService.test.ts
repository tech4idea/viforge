import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceStore, type WorkspaceStore } from '../storage/workspaceStore';
import { createMockRunService } from './mockRunService';

let root: string;
let store: WorkspaceStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-mock-run-service-'));
  store = createWorkspaceStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('mock run service', () => {
  it('creates a successful web run with deterministic events and an output file', async () => {
    const project = await store.createProject({ name: 'Run Writers' });
    const prompt = 'Draft a cold open about quarterly planning.';

    const { run, events } = await createMockRunService(store).createRun({
      projectId: project.id,
      prompt,
      source: 'web',
    });

    expect(run).toMatchObject({
      id: expect.stringMatching(/^run_/),
      projectId: project.id,
      prompt,
      source: 'web',
      status: 'success',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(events.map((event) => event.type)).toEqual(['run.start', 'text.delta', 'tool.use', 'file.changed', 'run.end']);

    const output = await store.readWorkspaceFile(project.id, `06 产物/01 第一集/${run.id}.md`);
    expect(output).toEqual({ path: `06 产物/01 第一集/${run.id}.md`, content: expect.stringContaining(prompt) });
  });

  it('defaults direct service calls to web source', async () => {
    const project = await store.createProject({ name: 'Default Source Writers' });

    const { run } = await createMockRunService(store).createRun({
      projectId: project.id,
      prompt: 'Draft a scene without an explicit source.',
    });

    expect(run.source).toBe('web');
  });

  it('returns deterministic run ids, timestamps, and events for identical direct inputs', async () => {
    const project = await store.createProject({ name: 'Deterministic Writers' });
    const service = createMockRunService(store);
    const input = {
      projectId: project.id,
      prompt: 'Draft the same scene twice.',
    };

    const first = await service.createRun(input);
    const second = await service.createRun(input);

    expect(second.run.id).toBe(first.run.id);
    expect(second.run.createdAt).toBe(first.run.createdAt);
    expect(second.run.updatedAt).toBe(first.run.updatedAt);
    expect(second.events).toEqual(first.events);
  });

  it('does not create a workspace for missing projects', async () => {
    const missingProjectId = 'missing-project';

    await expect(
      createMockRunService(store).createRun({
        projectId: missingProjectId,
        prompt: 'Draft a scene for a missing project.',
      }),
    ).rejects.toThrow('Project not found');
    await expect(store.getProject(missingProjectId)).resolves.toBeUndefined();
    expect(existsSync(path.join(root, missingProjectId))).toBe(false);
  });
});
