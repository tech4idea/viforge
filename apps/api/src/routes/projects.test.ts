import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceStore } from '../storage/workspaceStore';
import { createProjectsRoutes } from './projects';

let root: string;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viforge-api-routes-'));
  app = new Hono().route('/api', createProjectsRoutes(createWorkspaceStore(root)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('projects routes', () => {
  it('exposes the active product profile', async () => {
    const response = await app.request('/api/product-profile');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'novel-adaptation',
      documentTitle: 'ViForge 小说改编剧本工作台',
      defaultProjectName: '长夜改编计划',
      workspaceSections: {
        project: expect.objectContaining({ title: '创作项目区域' }),
      },
      defaultAgentSkillNames: expect.arrayContaining(['brainstorm-agent', 'reviewer-agent']),
      artifactPaths: expect.objectContaining({ script: '03 剧本/01 第一集/剧本.md' }),
    });
  });

  it('lists and reads global workspace files', async () => {
    const listResponse = await app.request('/api/global/files');

    expect(listResponse.status).toBe(200);
    const files = await listResponse.json();
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Agent 配置/config.toml', name: 'config.toml', type: 'file' }),
      expect.objectContaining({ path: '模板库/剧本文档模板.md', name: '剧本文档模板.md', type: 'file' }),
    ]));

    const readResponse = await app.request(`/api/global/files/${encodePath('Agent 配置/config.toml')}`);
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toEqual({
      path: 'Agent 配置/config.toml',
      content: expect.stringContaining('max_revision_rounds'),
    });
  });

  it('creates a project and lists it', async () => {
    const createResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Office Misfits  ', description: 'A workplace comedy' }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created).toMatchObject({
      id: expect.any(String),
      productId: 'novel-adaptation',
      name: 'Office Misfits',
      description: 'A workplace comedy',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const listResponse = await app.request('/api/projects');

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([created]);
  });

  it('creates projects with the selected product profile', async () => {
    const createResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Studio Sitcom', productId: 'sitcom' }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created).toMatchObject({ productId: 'sitcom' });

    const filesResponse = await app.request(`/api/projects/${created.id}/files`);
    const files = await filesResponse.json();
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '01 基本设定/项目简介.md' }),
      expect.objectContaining({ path: '02 故事/01 第一集/单集大纲.md' }),
    ]));
    expect(files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '01 原著资料/项目简介.md' }),
    ]));
  });

  it('deletes a project and its workspace', async () => {
    const project = await createProject('Deleted Project');

    const deleteResponse = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ deleted: true });
    await expect(app.request(`/api/projects/${project.id}`)).resolves.toMatchObject({ status: 404 });
    await expect(app.request(`/api/projects/${project.id}/files`)).resolves.toMatchObject({ status: 404 });
  });

  it('rejects missing or blank project names', async () => {
    for (const body of [{}, { name: '   ' }]) {
      const response = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    }
  });

  it('returns 404 for missing projects', async () => {
    const response = await app.request('/api/projects/missing-project');

    expect(response.status).toBe(404);
  });

  it('lists template files for a project', async () => {
    const project = await createProject('Template Files');

    const response = await app.request(`/api/projects/${project.id}/files`);

    expect(response.status).toBe(200);
    const files = await response.json();
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '01 原著资料/项目简介.md', name: '项目简介.md', type: 'file' }),
      expect.objectContaining({ path: '02 改编方案/01 第一集/单集改编方案.md', name: '单集改编方案.md', type: 'file' }),
      expect.objectContaining({ path: '03 剧本/01 第一集/剧本.md', name: '剧本.md', type: 'file' }),
    ]));
    expect(files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining('04 分镜脚本') }),
      expect.objectContaining({ path: expect.stringContaining('05 视频') }),
      expect.objectContaining({ path: expect.stringContaining('06 产物') }),
    ]));
  });

  it('reads a project file', async () => {
    const project = await createProject('Brief Readers');

    const response = await app.request(`/api/projects/${project.id}/files/${encodePath('01 原著资料/项目简介.md')}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: '01 原著资料/项目简介.md',
      content: expect.stringContaining('Brief Readers'),
    });
  });

  it('writes project file content', async () => {
    const project = await createProject('Script Writers');

    const response = await app.request(`/api/projects/${project.id}/files/${encodePath('03 剧本/01 第一集/剧本.md')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'INT. OFFICE - DAY' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path: '03 剧本/01 第一集/剧本.md', content: 'INT. OFFICE - DAY' });

    const readResponse = await app.request(`/api/projects/${project.id}/files/${encodePath('03 剧本/01 第一集/剧本.md')}`);
    await expect(readResponse.json()).resolves.toEqual({ path: '03 剧本/01 第一集/剧本.md', content: 'INT. OFFICE - DAY' });
  });

  it('rejects missing or non-string file content', async () => {
    const project = await createProject('Content Validators');

    for (const body of [{}, { content: 42 }]) {
      const response = await app.request(`/api/projects/${project.id}/files/${encodePath('03 剧本/01 第一集/剧本.md')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    }
  });

  it('returns 404 for a missing file in an existing project', async () => {
    const project = await createProject('Missing File Readers');

    const response = await app.request(`/api/projects/${project.id}/files/missing.md`);

    expect(response.status).toBe(404);
  });

  it('does not return 500 for invalid or malformed file paths', async () => {
    const project = await createProject('Path Validators');

    for (const filePath of ['..%2Foutside.md', '%E0%A4%A']) {
      const response = await app.request(`/api/projects/${project.id}/files/${filePath}`);

      expect(response.status).toBe(400);
    }
  });

  it('writes and reads nested project file paths', async () => {
    const project = await createProject('Nested Writers');

    const response = await app.request(`/api/projects/${project.id}/files/episodes/episode-1.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Episode 1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path: 'episodes/episode-1.md', content: '# Episode 1' });

    const readResponse = await app.request(`/api/projects/${project.id}/files/episodes/episode-1.md`);

    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toEqual({ path: 'episodes/episode-1.md', content: '# Episode 1' });
  });

  it('creates theater folders and documents', async () => {
    const project = await createProject('Episode Asset Managers');

    const folderResponse = await app.request(`/api/projects/${project.id}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'episodes/episode-02' }),
    });

    expect(folderResponse.status).toBe(201);
    await expect(folderResponse.json()).resolves.toMatchObject({
      path: 'episodes/episode-02',
      name: 'episode-02',
      type: 'directory',
    });

    const fileResponse = await app.request(`/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'episodes/episode-02/script.md',
        content: '# 第 2 集剧本\n\n## 场景 1',
      }),
    });

    expect(fileResponse.status).toBe(201);
    await expect(fileResponse.json()).resolves.toEqual({
      path: 'episodes/episode-02/script.md',
      content: '# 第 2 集剧本\n\n## 场景 1',
    });

    const listResponse = await app.request(`/api/projects/${project.id}/files`);
    const entries = await listResponse.json();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'episodes/episode-02', type: 'directory' }),
      expect.objectContaining({ path: 'episodes/episode-02/script.md', type: 'file' }),
    ]));
  });

  it('moves and deletes theater workspace assets', async () => {
    const project = await createProject('Storyboard Movers');
    await app.request(`/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'storyboards/draft.md', content: '# 分镜草稿' }),
    });

    const moveResponse = await app.request(`/api/projects/${project.id}/files/storyboards/draft.md/move`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetPath: 'episodes/episode-01/storyboard.md' }),
    });

    expect(moveResponse.status).toBe(200);
    await expect(moveResponse.json()).resolves.toMatchObject({
      path: 'episodes/episode-01/storyboard.md',
      name: 'storyboard.md',
      type: 'file',
    });

    const oldReadResponse = await app.request(`/api/projects/${project.id}/files/storyboards/draft.md`);
    expect(oldReadResponse.status).toBe(404);

    const deleteResponse = await app.request(`/api/projects/${project.id}/files/episodes/episode-01/storyboard.md`, {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ deleted: true });

    const deletedReadResponse = await app.request(`/api/projects/${project.id}/files/episodes/episode-01/storyboard.md`);
    expect(deletedReadResponse.status).toBe(404);
  });

  it('uploads binary theater reference assets and serves raw bytes', async () => {
    const project = await createProject('Reference Uploaders');

    const uploadResponse = await app.request(`/api/projects/${project.id}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'assets/location.png',
        contentBase64: Buffer.from('fake-image-bytes').toString('base64'),
        mimeType: 'image/png',
      }),
    });

    expect(uploadResponse.status).toBe(201);
    await expect(uploadResponse.json()).resolves.toMatchObject({
      path: 'assets/location.png',
      name: 'location.png',
      type: 'file',
      mimeType: 'image/png',
    });

    const rawResponse = await app.request(`/api/projects/${project.id}/raw/assets/location.png`);

    expect(rawResponse.status).toBe(200);
    expect(rawResponse.headers.get('content-type')).toBe('image/png');
    expect(await rawResponse.text()).toBe('fake-image-bytes');
  });
});

async function createProject(name: string) {
  const response = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

function encodePath(value: string): string {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}
