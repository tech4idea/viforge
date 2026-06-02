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

    const brief = await store.readWorkspaceFile(project.id, '01 原著资料/项目简介.md');
    expect(brief).toEqual({
      path: '01 原著资料/项目简介.md',
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
      content: expect.stringContaining('小说改编剧本'),
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

  it('updates the legacy default system agent without overwriting custom instructions', async () => {
    const legacyAgent = '# 情景剧创作工作区\n\n## 工作目标\n\n围绕角色、故事、剧本、分镜和视频生成推进情景剧创作。\n';
    await mkdir(path.join(root, '_global', 'Agent 配置'), { recursive: true });
    await writeFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), legacyAgent, 'utf8');

    const store = createWorkspaceStore(root);
    await store.listGlobalWorkspaceEntries();

    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toContain('viwork system agent');

    await writeFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), '# Custom\n', 'utf8');
    await store.listGlobalWorkspaceEntries();

    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toBe('# Custom\n');
  });

  it('updates the outdated default viwork system agent trace schema', async () => {
    const outdatedAgent = [
      '# viwork system agent',
      '',
      '1. 用户只是在探索想法时，使用 brainstorm-agent，结果仅在聊天中展示。',
      '',
      '你必须在关键节点输出独立 JSON block，供系统解析并展示 timeline。格式如下：',
      '',
      '```json',
      '{"type":"agent.step.start","agentId":"story-agent","phase":"故事创作","iteration":1}',
      '```',
    ].join('\n');
    await mkdir(path.join(root, '_global', 'Agent 配置'), { recursive: true });
    await writeFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), outdatedAgent, 'utf8');

    const store = createWorkspaceStore(root);
    await store.listGlobalWorkspaceEntries();

    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toContain('"maxIterations":5');
    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toContain('脑暴不调用 reviewer-agent');
    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toContain('同一次回复里直接给出对应 agent 的实质内容');
    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toContain('小说改编剧本工作台');
  });

  it('updates the outdated default viwork system agent when it still allows routing-only replies', async () => {
    const outdatedAgent = [
      '# viwork system agent',
      '',
      '1. 用户只是在探索想法时，使用 brainstorm-agent 正常对话，结果仅在聊天中展示；脑暴不调用 reviewer-agent，不输出轮次，不进入质量闭环。',
      '',
      '正式故事/剧本创作和审稿时，你必须在关键节点输出独立 JSON block，供系统解析并展示 timeline。脑暴对话不需要输出 trace JSON。格式如下：',
      '',
      '```json',
      '{"type":"agent.step.start","agentId":"story-agent","phase":"故事创作","iteration":1,"maxIterations":5}',
      '```',
      '',
      '允许的 agentId：system、brainstorm-agent、story-agent、screenwriter-agent、reviewer-agent。',
    ].join('\n');
    await mkdir(path.join(root, '_global', 'Agent 配置'), { recursive: true });
    await writeFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), outdatedAgent, 'utf8');

    const store = createWorkspaceStore(root);
    await store.listGlobalWorkspaceEntries();

    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toContain('同一次回复里直接给出对应 agent 的实质内容');
    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'AGENTS.md'), 'utf8')).resolves.toContain('小说改编剧本工作台');
  });

  it('removes legacy default agent skills without deleting custom skill content', async () => {
    const legacySkillRoot = path.join(root, '_global', 'Agent 配置', 'skills', '故事大纲技能');
    const customSkillRoot = path.join(root, '_global', 'Agent 配置', 'skills', '人物设定技能');
    await mkdir(legacySkillRoot, { recursive: true });
    await mkdir(customSkillRoot, { recursive: true });
    await writeFile(path.join(legacySkillRoot, 'SKILL.md'), '# 故事大纲技能\n\n围绕单集主题输出 A/B 故事与结尾反转。\n', 'utf8');
    await writeFile(path.join(customSkillRoot, 'SKILL.md'), '# Custom Character Skill\n', 'utf8');

    const store = createWorkspaceStore(root);
    const entries = await store.listGlobalWorkspaceEntries();

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Agent 配置/skills/source-analyst-agent/SKILL.md' }),
      expect.objectContaining({ path: 'Agent 配置/skills/人物设定技能/SKILL.md' }),
    ]));
    expect(entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Agent 配置/skills/故事大纲技能/SKILL.md' }),
    ]));
  });

  it('updates outdated default skills and preserves custom skill bodies while adding required frontmatter', async () => {
    const brainstormSkillRoot = path.join(root, '_global', 'Agent 配置', 'skills', 'brainstorm-agent');
    const customSkillRoot = path.join(root, '_global', 'Agent 配置', 'skills', 'source-analyst-agent');
    await mkdir(brainstormSkillRoot, { recursive: true });
    await mkdir(customSkillRoot, { recursive: true });
    await writeFile(
      path.join(brainstormSkillRoot, 'SKILL.md'),
      '# brainstorm-agent\n\n你是情景剧脑暴 agent，只负责探索故事种子，不负责写入正式项目文件。\n',
      'utf8',
    );
    await writeFile(path.join(customSkillRoot, 'SKILL.md'), '# Custom Story Agent\n', 'utf8');

    const store = createWorkspaceStore(root);
    await store.listGlobalWorkspaceEntries();

    await expect(readFile(path.join(brainstormSkillRoot, 'SKILL.md'), 'utf8')).resolves.toContain('不调用 reviewer-agent');
    await expect(readFile(path.join(brainstormSkillRoot, 'SKILL.md'), 'utf8')).resolves.toContain('name: "brainstorm-agent"');
    const customSkill = await readFile(path.join(customSkillRoot, 'SKILL.md'), 'utf8');
    expect(customSkill).toContain('name: "source-analyst-agent"');
    expect(customSkill).toContain('# Custom Story Agent');
  });

  it('adds the viwork agent runtime config without overwriting existing Codex config', async () => {
    await mkdir(path.join(root, '_global', 'Agent 配置'), { recursive: true });
    await writeFile(path.join(root, '_global', 'Agent 配置', 'config.toml'), 'model = "gpt-5"\n', 'utf8');

    const store = createWorkspaceStore(root);
    await store.listGlobalWorkspaceEntries();

    await expect(readFile(path.join(root, '_global', 'Agent 配置', 'config.toml'), 'utf8')).resolves.toBe(
      'model = "gpt-5"\n\n[viwork]\nmax_revision_rounds = 5\n',
    );
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
