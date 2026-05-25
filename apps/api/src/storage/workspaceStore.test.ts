import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_DIRECTORIES, DEFAULT_GLOBAL_FILES, DEFAULT_GLOBAL_DIRECTORIES, DEFAULT_SITCOM_FILES } from '@viwork/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceStore } from './workspaceStore';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-workspaces-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workspaceStore', () => {
  it('creates a project with metadata, default files, and default directories', async () => {
    const store = createWorkspaceStore(root);

    const project = await store.createProject({
      name: 'Office Misfits',
      description: 'A short workplace comedy',
    });

    expect(project.id).toEqual(expect.any(String));
    expect(project.name).toBe('Office Misfits');
    expect(project.description).toBe('A short workplace comedy');
    expect(project.createdAt).toEqual(expect.any(String));
    expect(project.updatedAt).toBe(project.createdAt);

    await expect(store.getProject(project.id)).resolves.toEqual(project);

    const entries = await store.listWorkspaceEntries(project.id);
    expect(entries.map((entry) => entry.path).sort()).toEqual(
      [...DEFAULT_DIRECTORIES, ...DEFAULT_SITCOM_FILES.map((file) => file.path)].sort(),
    );
    expect(entries).not.toContainEqual(expect.objectContaining({ path: 'project.json' }));

    for (const directory of DEFAULT_DIRECTORIES) {
      expect(entries).toContainEqual({
        path: directory,
        name: path.basename(directory),
        type: 'directory',
      });
    }

    const brief = await store.readWorkspaceFile(project.id, '01 基本设定/项目简介.md');
    expect(brief).toEqual({
      path: '01 基本设定/项目简介.md',
      content: expect.stringContaining('Office Misfits'),
    });
  });

  it('lists projects sorted by metadata creation time and id', async () => {
    const store = createWorkspaceStore(root);
    const first = await store.createProject({ name: 'First' });
    const second = await store.createProject({ name: 'Second' });

    const firstMetadataPath = path.join(root, first.id, 'project.json');
    const firstMetadata = JSON.parse(await readFile(firstMetadataPath, 'utf8'));
    firstMetadata.createdAt = '2026-01-02T00:00:00.000Z';
    await writeFile(firstMetadataPath, JSON.stringify(firstMetadata, null, 2), 'utf8');

    const secondMetadataPath = path.join(root, second.id, 'project.json');
    const secondMetadata = JSON.parse(await readFile(secondMetadataPath, 'utf8'));
    secondMetadata.createdAt = '2026-01-01T00:00:00.000Z';
    await writeFile(secondMetadataPath, JSON.stringify(secondMetadata, null, 2), 'utf8');

    await expect(store.listProjects()).resolves.toEqual([
      { ...second, createdAt: '2026-01-01T00:00:00.000Z' },
      { ...first, createdAt: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  it('creates temporary project workspaces without listing them as projects', async () => {
    const store = createWorkspaceStore(root);

    const temporaryProject = await store.createTemporaryProject();

    expect(temporaryProject).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^temp-/),
      name: '临时对话工作区',
      temporary: true,
    }));
    await expect(store.getProject(temporaryProject.id)).resolves.toEqual(temporaryProject);
    await expect(store.listProjects()).resolves.toEqual([]);
    await expect(store.listWorkspaceEntries(temporaryProject.id)).resolves.toEqual([]);
  });

  it('initializes and reads the global workspace from the filesystem', async () => {
    const store = createWorkspaceStore(root);

    const entries = await store.listGlobalWorkspaceEntries();

    expect(entries.map((entry) => entry.path).sort()).toEqual(
      [...DEFAULT_GLOBAL_DIRECTORIES, ...DEFAULT_GLOBAL_FILES.map((file) => file.path)].sort(),
    );

    const globalFile = await store.readGlobalWorkspaceFile('Agent 配置/AGENTS.md');
    expect(globalFile).toEqual({
      path: 'Agent 配置/AGENTS.md',
      content: expect.stringContaining('情景剧创作'),
    });
  });

  it('migrates legacy global agent files into the Agent 配置 directory', async () => {
    await mkdir(path.join(root, '_global', 'skills', '旧技能'), { recursive: true });
    await writeFile(path.join(root, '_global', 'AGENTS.md'), '# Legacy Agent', 'utf8');
    await writeFile(path.join(root, '_global', 'auth.json'), '{"token":"legacy"}', 'utf8');
    await writeFile(path.join(root, '_global', 'installation_id'), 'legacy-installation', 'utf8');
    await writeFile(path.join(root, '_global', 'skills', '旧技能', 'SKILL.md'), '# 旧技能', 'utf8');

    const store = createWorkspaceStore(root);
    const entries = await store.listGlobalWorkspaceEntries();

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Agent 配置/AGENTS.md', type: 'file' }),
      expect.objectContaining({ path: 'Agent 配置/auth.json', type: 'file' }),
      expect.objectContaining({ path: 'Agent 配置/installation_id', type: 'file' }),
      expect.objectContaining({ path: 'Agent 配置/skills/旧技能/SKILL.md', type: 'file' }),
    ]));
    await expect(readFile(path.join(root, '_global', 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, '_global', 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, '_global', 'installation_id'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes and reads workspace files and returns file metadata in entries', async () => {
    const store = createWorkspaceStore(root);
    const project = await store.createProject({ name: 'Food Truck Friends' });

    const written = await store.writeWorkspaceFile(project.id, 'episodes/episode-1.md', 'Cold open');

    expect(written).toEqual({ path: 'episodes/episode-1.md', content: 'Cold open' });
    await expect(store.readWorkspaceFile(project.id, 'episodes/episode-1.md')).resolves.toEqual(written);

    const entries = await store.listWorkspaceEntries(project.id);
    expect(entries).toContainEqual({ path: 'episodes', name: 'episodes', type: 'directory' });
    expect(entries).toContainEqual(
      expect.objectContaining({
        path: 'episodes/episode-1.md',
        name: 'episode-1.md',
        type: 'file',
        size: Buffer.byteLength('Cold open'),
        updatedAt: expect.any(String),
      }),
    );
  });

  it('returns undefined for missing projects', async () => {
    const store = createWorkspaceStore(root);

    await expect(store.getProject('missing')).resolves.toBeUndefined();
  });

  it('prevents reading or writing files outside a project workspace', async () => {
    const store = createWorkspaceStore(root);
    const project = await store.createProject({ name: 'Safe Project' });

    await expect(store.writeWorkspaceFile(project.id, '../escape.md', 'nope')).rejects.toThrow(/Invalid workspace path/);
    await expect(store.readWorkspaceFile(project.id, '../escape.md')).rejects.toThrow(/Invalid workspace path/);
    await expect(store.writeWorkspaceFile(project.id, '/absolute.md', 'nope')).rejects.toThrow(/Invalid workspace path/);
  });

  it('prevents project ids from escaping or collapsing to the workspaces root', async () => {
    const store = createWorkspaceStore(root);

    for (const invalidProjectId of ['../escape', '.', 'foo/..']) {
      await expect(store.getProject(invalidProjectId)).rejects.toThrow(/Invalid project id/);
      await expect(store.listWorkspaceEntries(invalidProjectId)).rejects.toThrow(/Invalid project id/);
      await expect(store.readWorkspaceFile(invalidProjectId, '01 基本设定/项目简介.md')).rejects.toThrow(/Invalid project id/);
      await expect(store.writeWorkspaceFile(invalidProjectId, '01 基本设定/项目简介.md', 'nope')).rejects.toThrow(/Invalid project id/);
    }
  });
});
