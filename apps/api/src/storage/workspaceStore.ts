import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createDefaultWorkspaceFilesForProfile,
  resolveProductProfile,
  type ProductProfile,
  type Project,
  type WorkspaceEntry,
  type WorkspaceFile,
} from '@viwork/shared';

import { PRODUCT_PROFILE, WORKSPACES_ROOT } from '../env';
import { createDefaultGlobalWorkspaceFilesFromProfile } from '../productProfileDefaults';

const METADATA_FILE = 'project.json';
const GLOBAL_ROOT_NAME = '_global';
const GLOBAL_AGENT_CONFIG_DIR = 'Agent 配置';

export type CreateProjectInput = {
  name: string;
  description?: string;
};

export type WorkspaceStore = {
  createProject(input: CreateProjectInput): Promise<Project>;
  createTemporaryProject(): Promise<Project>;
  deleteProject(projectId: string): Promise<{ deleted: true }>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  getProjectRoot(projectId: string): string;
  getGlobalRoot(): string;
  listGlobalWorkspaceEntries(): Promise<WorkspaceEntry[]>;
  readGlobalWorkspaceFile(filePath: string): Promise<WorkspaceFile>;
  readGlobalWorkspaceFileBytes(filePath: string): Promise<{ path: string; bytes: Buffer; mimeType: string }>;
  writeGlobalWorkspaceFile(filePath: string, content: string): Promise<WorkspaceFile>;
  createGlobalWorkspaceFolder(folderPath: string): Promise<WorkspaceEntry>;
  createGlobalWorkspaceFile(filePath: string, content: string): Promise<WorkspaceFile>;
  createGlobalWorkspaceAsset(filePath: string, bytes: Buffer, mimeType?: string): Promise<WorkspaceEntry>;
  moveGlobalWorkspaceEntry(sourcePath: string, targetPath: string): Promise<WorkspaceEntry>;
  deleteGlobalWorkspaceEntry(entryPath: string): Promise<{ deleted: true }>;
  listWorkspaceEntries(projectId: string): Promise<WorkspaceEntry[]>;
  readWorkspaceFile(projectId: string, filePath: string): Promise<WorkspaceFile>;
  readWorkspaceFileBytes(projectId: string, filePath: string): Promise<{ path: string; bytes: Buffer; mimeType: string }>;
  writeWorkspaceFile(projectId: string, filePath: string, content: string): Promise<WorkspaceFile>;
  createWorkspaceFolder(projectId: string, folderPath: string): Promise<WorkspaceEntry>;
  createWorkspaceFile(projectId: string, filePath: string, content: string): Promise<WorkspaceFile>;
  createWorkspaceAsset(projectId: string, filePath: string, bytes: Buffer, mimeType?: string): Promise<WorkspaceEntry>;
  moveWorkspaceEntry(projectId: string, sourcePath: string, targetPath: string): Promise<WorkspaceEntry>;
  deleteWorkspaceEntry(projectId: string, entryPath: string): Promise<{ deleted: true }>;
};

export function createWorkspaceStore(root = WORKSPACES_ROOT, options: { productProfile?: ProductProfile } = {}): WorkspaceStore {
  const workspacesRoot = path.resolve(root);
  const productProfile = options.productProfile ?? PRODUCT_PROFILE ?? resolveProductProfile();

  function projectRoot(projectId: string): string {
    const rootPath = path.resolve(workspacesRoot, projectId);
    const relativeToRoot = path.relative(workspacesRoot, rootPath);

    if (
      !projectId ||
      projectId.includes('/') ||
      projectId.includes('\\') ||
      projectId === GLOBAL_ROOT_NAME ||
      relativeToRoot === '' ||
      relativeToRoot.startsWith('..') ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new Error('Invalid project id');
    }

    return rootPath;
  }

  function globalRoot(): string {
    return path.resolve(workspacesRoot, GLOBAL_ROOT_NAME);
  }

  function metadataPath(projectId: string): string {
    return path.join(projectRoot(projectId), METADATA_FILE);
  }

  function assertSafePath(rootPath: string, filePath: string): { relativePath: string; absolutePath: string } {
    if (path.isAbsolute(filePath)) {
      throw new Error('Invalid workspace path');
    }

    const relativePath = normalizeWorkspacePath(filePath);
    if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Invalid workspace path');
    }

    const absolutePath = path.resolve(rootPath, relativePath);
    const relativeToRoot = path.relative(rootPath, absolutePath);

    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error('Invalid workspace path');
    }

    return { relativePath, absolutePath };
  }

  function assertSafeWorkspacePath(projectId: string, filePath: string) {
    return assertSafePath(projectRoot(projectId), filePath);
  }

  function assertSafeGlobalWorkspacePath(filePath: string) {
    return assertSafePath(globalRoot(), filePath);
  }

  async function readProject(projectId: string): Promise<Project | undefined> {
    try {
      return JSON.parse(await readFile(metadataPath(projectId), 'utf8')) as Project;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async function ensureGlobalWorkspace(): Promise<string> {
    const rootPath = globalRoot();
    const defaultGlobalFiles = await createDefaultGlobalWorkspaceFilesFromProfile(productProfile);
    await mkdir(rootPath, { recursive: true });
    await migrateGlobalAgentConfig(rootPath);
    await Promise.all(productProfile.globalDirectories.map((directory) => mkdir(path.join(rootPath, directory), { recursive: true })));
    await updateLegacyDefaultSystemAgent(rootPath);
    await removeLegacyDefaultAgentSkills(rootPath);
    await updateOutdatedDefaultAgentSkills(rootPath);
    await ensureAgentSkillFrontmatter(rootPath);
    await ensureViworkAgentConfig(rootPath);
    await Promise.all(
      defaultGlobalFiles.map(async (file) => {
        const { absolutePath } = assertSafeGlobalWorkspacePath(file.path);
        try {
          await stat(absolutePath);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, file.content, 'utf8');
        }
      }),
    );
    return rootPath;
  }

  async function migrateGlobalAgentConfig(rootPath: string): Promise<void> {
    await migrateGlobalEntry(rootPath, 'AGENTS.md', `${GLOBAL_AGENT_CONFIG_DIR}/AGENTS.md`);
    await migrateGlobalEntry(rootPath, 'config.toml', `${GLOBAL_AGENT_CONFIG_DIR}/config.toml`);
    await migrateGlobalEntry(rootPath, 'auth.json', `${GLOBAL_AGENT_CONFIG_DIR}/auth.json`);
    await migrateGlobalEntry(rootPath, 'installation_id', `${GLOBAL_AGENT_CONFIG_DIR}/installation_id`);
    await migrateGlobalEntry(rootPath, 'skills', `${GLOBAL_AGENT_CONFIG_DIR}/skills`);
    await migrateGlobalEntry(rootPath, 'plugins', `${GLOBAL_AGENT_CONFIG_DIR}/plugins`);
  }

  async function updateLegacyDefaultSystemAgent(rootPath: string): Promise<void> {
    const agentsPath = path.join(rootPath, GLOBAL_AGENT_CONFIG_DIR, 'AGENTS.md');
    try {
      const currentContent = await readFile(agentsPath, 'utf8');
      if (!isLegacyDefaultSystemAgent(currentContent) && !isOutdatedDefaultViworkSystemAgent(currentContent)) {
        return;
      }
      const defaultAgent = (await createDefaultGlobalWorkspaceFilesFromProfile(productProfile)).find((file) => file.path === `${GLOBAL_AGENT_CONFIG_DIR}/AGENTS.md`);
      if (defaultAgent) {
        await writeFile(agentsPath, defaultAgent.content, 'utf8');
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  function isLegacyDefaultSystemAgent(content: string): boolean {
    return (
      content.includes('# 情景剧创作工作区') &&
      content.includes('## 工作目标') &&
      content.includes('围绕角色、故事、剧本、分镜和视频生成推进情景剧创作。')
    );
  }

  function isOutdatedDefaultViworkSystemAgent(content: string): boolean {
    const looksLikeKnownDefaultViworkAgent = (
      content.includes('# viwork system agent') &&
      (
        content.includes('你必须在关键节点输出独立 JSON block') ||
        content.includes('正式故事/剧本创作和审稿时，你必须在关键节点输出独立 JSON block')
      ) &&
      (
        content.includes('1. 用户只是在探索想法时') ||
        content.includes('允许的 agentId：system、brainstorm-agent、story-agent、screenwriter-agent、reviewer-agent。') ||
        content.includes('允许的 agentId：system、brainstorm-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent、reviewer-agent。')
      )
    );
    return (
      looksLikeKnownDefaultViworkAgent &&
      (
        !content.includes('小说改编剧本工作台') ||
        !content.includes('"maxIterations"') ||
        !content.includes('脑暴不调用 reviewer-agent') ||
        !content.includes('同一次回复里直接给出对应 agent 的实质内容') ||
        !content.includes('不要调用 `update_plan`')
      )
    );
  }

  async function removeLegacyDefaultAgentSkills(rootPath: string): Promise<void> {
    const legacySkillNames = ['人物设定技能', '故事大纲技能', '剧本改写技能', '分镜拆解技能', '视频生成提示词技能', 'story-agent'];
    await Promise.all(
      legacySkillNames.map(async (skillName) => {
        const skillRoot = path.join(rootPath, GLOBAL_AGENT_CONFIG_DIR, 'skills', skillName);
        const skillPath = path.join(skillRoot, 'SKILL.md');
        try {
          const content = await readFile(skillPath, 'utf8');
          if (!isLegacyDefaultSkill(skillName, content)) {
            return;
          }
          await rm(skillRoot, { recursive: true, force: true });
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      }),
    );
  }

  function isLegacyDefaultSkill(skillName: string, content: string): boolean {
    const defaultFragments: Record<string, string> = {
      人物设定技能: '根据项目设定补全人物身份、缺点、欲望和喜剧来源。',
      故事大纲技能: '围绕单集主题输出 A/B 故事与结尾反转。',
      剧本改写技能: '对现有剧本做节奏、冲突和对白上的局部改写。',
      分镜拆解技能: '把剧本文本拆成镜头清单和逐镜头描述。',
      视频生成提示词技能: '根据分镜脚本整理视频模型可用的提示词。',
      'story-agent': '你是情景剧故事创作 agent。你的目标是根据人类给出的方向或想法，创作一个符合单元剧设定的好故事。',
    };
    return content.includes(defaultFragments[skillName] ?? '__never__');
  }

  async function updateOutdatedDefaultAgentSkills(rootPath: string): Promise<void> {
    await Promise.all(
      ['brainstorm-agent', 'source-analyst-agent', 'adaptation-planner-agent', 'screenwriter-agent', 'reviewer-agent'].map((skillName) =>
        updateOutdatedDefaultSkill(
          rootPath,
          skillName,
          (content) => isKnownDefaultViworkSkill(skillName, content) && !hasAgentSkillFrontmatter(content),
        ),
      ),
    );
    await updateOutdatedDefaultSkill(
      rootPath,
      'brainstorm-agent',
      (content) =>
        isKnownDefaultViworkSkill('brainstorm-agent', content) &&
        (!content.includes('不调用 reviewer-agent') || !content.includes('小说改编脑暴 agent')),
    );
  }

  async function updateOutdatedDefaultSkill(
    rootPath: string,
    skillName: string,
    isOutdated: (content: string) => boolean,
  ): Promise<void> {
    const skillPath = path.join(rootPath, GLOBAL_AGENT_CONFIG_DIR, 'skills', skillName, 'SKILL.md');
    try {
      const content = await readFile(skillPath, 'utf8');
      if (!isOutdated(content)) {
        return;
      }
      const defaultSkill = (await createDefaultGlobalWorkspaceFilesFromProfile(productProfile)).find(
        (file) => file.path === `${GLOBAL_AGENT_CONFIG_DIR}/skills/${skillName}/SKILL.md`,
      );
      if (defaultSkill) {
        await writeFile(skillPath, defaultSkill.content, 'utf8');
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async function ensureAgentSkillFrontmatter(rootPath: string): Promise<void> {
    const skillsRoot = path.join(rootPath, GLOBAL_AGENT_CONFIG_DIR, 'skills');
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }

    await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
        try {
          const content = await readFile(skillPath, 'utf8');
          if (hasAgentSkillFrontmatter(content)) {
            return;
          }
          await writeFile(skillPath, `${customSkillFrontmatter(entry.name)}${content}`, 'utf8');
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      }),
    );
  }

  function isKnownDefaultViworkSkill(skillName: string, content: string): boolean {
    const fragments: Record<string, string[]> = {
      'brainstorm-agent': ['# brainstorm-agent'],
      'source-analyst-agent': ['# source-analyst-agent', '你是小说原著分析 agent', '## 好原著分析标准'],
      'adaptation-planner-agent': ['# adaptation-planner-agent', '你是小说改编方案 agent', '## 好改编方案标准'],
      'screenwriter-agent': ['# screenwriter-agent', '## 好剧本标准'],
      'reviewer-agent': ['# reviewer-agent', '结论：通过 / 打回'],
    };
    return (fragments[skillName] ?? []).every((fragment) => content.includes(fragment));
  }

  function hasAgentSkillFrontmatter(content: string): boolean {
    return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(content);
  }

  function customSkillFrontmatter(skillName: string): string {
    return [
      '---',
      `name: ${yamlString(skillName)}`,
      `description: ${yamlString(`Custom viwork agent skill: ${skillName}. Use when explicitly requested or when the skill body matches the task.`)}`,
      '---',
      '',
    ].join('\n');
  }

  function yamlString(value: string): string {
    return JSON.stringify(value);
  }

  async function ensureViworkAgentConfig(rootPath: string): Promise<void> {
    const configPath = path.join(rootPath, GLOBAL_AGENT_CONFIG_DIR, 'config.toml');
    const defaultConfig = '# viwork agent runtime\n[viwork]\nmax_revision_rounds = 5\n';
    try {
      const content = await readFile(configPath, 'utf8');
      if (/\[viwork\][\s\S]*max_revision_rounds\s*=/.test(content)) {
        return;
      }
      const separator = content.endsWith('\n') ? '\n' : '\n\n';
      await writeFile(configPath, `${content}${separator}[viwork]\nmax_revision_rounds = 5\n`, 'utf8');
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, defaultConfig, 'utf8');
    }
  }

  async function migrateGlobalEntry(rootPath: string, sourcePath: string, targetPath: string): Promise<void> {
    const source = path.join(rootPath, sourcePath);
    const target = path.join(rootPath, targetPath);

    try {
      await stat(source);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }

    try {
      await stat(target);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
  }

  async function listEntriesForRoot(rootPath: string): Promise<WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];

    async function walk(directory: string): Promise<void> {
      const directoryEntries = await readdir(directory, { withFileTypes: true });

      for (const directoryEntry of directoryEntries) {
        if (directory === rootPath && directoryEntry.name === METADATA_FILE) {
          continue;
        }

        const absolutePath = path.join(directory, directoryEntry.name);
        const relativePath = normalizeWorkspacePath(path.relative(rootPath, absolutePath));

        if (directoryEntry.isDirectory()) {
          entries.push({ path: relativePath, name: directoryEntry.name, type: 'directory' });
          await walk(absolutePath);
          continue;
        }

        if (directoryEntry.isFile()) {
          const fileStat = await stat(absolutePath);
          entries.push({
            path: relativePath,
            name: directoryEntry.name,
            type: 'file',
            size: fileStat.size,
            updatedAt: fileStat.mtime.toISOString(),
            mimeType: inferMimeType(relativePath),
          });
        }
      }
    }

    await walk(rootPath);
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async function writeTextFile(absolutePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }

  async function createAssetFile(absolutePath: string, bytes: Buffer): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
  }

  return {
    async createProject(input) {
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        createdAt: now,
        updatedAt: now,
      };

      const rootPath = projectRoot(project.id);
      await mkdir(rootPath, { recursive: true });
      await Promise.all(productProfile.projectDirectories.map((directory) => mkdir(path.join(rootPath, directory), { recursive: true })));
      await Promise.all(
        createDefaultWorkspaceFilesForProfile(productProfile, input.name).map(async (file) => {
          const { absolutePath } = assertSafeWorkspacePath(project.id, file.path);
          await writeTextFile(absolutePath, file.content);
        }),
      );
      await writeFile(metadataPath(project.id), JSON.stringify(project, null, 2), 'utf8');

      return project;
    },

    async createTemporaryProject() {
      const now = new Date().toISOString();
      const project: Project = {
        id: `temp-${randomUUID()}`,
        name: '临时对话工作区',
        description: '未绑定项目的创作助手临时工作目录。',
        createdAt: now,
        updatedAt: now,
        temporary: true,
      };

      await mkdir(projectRoot(project.id), { recursive: true });
      await writeFile(metadataPath(project.id), JSON.stringify(project, null, 2), 'utf8');

      return project;
    },

    async deleteProject(projectId) {
      const project = await readProject(projectId);
      if (!project || project.temporary) {
        throw new Error('Project not found');
      }
      await rm(projectRoot(projectId), { recursive: true, force: false });
      return { deleted: true };
    },

    async listProjects() {
      try {
        const entries = await readdir(workspacesRoot, { withFileTypes: true });
        const projects = await Promise.all(
          entries
            .filter((entry) => entry.isDirectory() && entry.name !== GLOBAL_ROOT_NAME)
            .map((entry) => readProject(entry.name)),
        );

        return projects
          .filter((project): project is Project => project !== undefined && !project.temporary)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      } catch (error) {
        if (isNotFoundError(error)) {
          return [];
        }
        throw error;
      }
    },

    getProject(projectId) {
      return readProject(projectId);
    },

    getProjectRoot(projectId) {
      return projectRoot(projectId);
    },

    getGlobalRoot() {
      return globalRoot();
    },

    async listGlobalWorkspaceEntries() {
      return listEntriesForRoot(await ensureGlobalWorkspace());
    },

    async readGlobalWorkspaceFile(filePath) {
      await ensureGlobalWorkspace();
      const { relativePath, absolutePath } = assertSafeGlobalWorkspacePath(filePath);
      return { path: relativePath, content: await readFile(absolutePath, 'utf8') };
    },

    async readGlobalWorkspaceFileBytes(filePath) {
      await ensureGlobalWorkspace();
      const { relativePath, absolutePath } = assertSafeGlobalWorkspacePath(filePath);
      return {
        path: relativePath,
        bytes: await readFile(absolutePath),
        mimeType: inferMimeType(relativePath),
      };
    },

    async writeGlobalWorkspaceFile(filePath, content) {
      await ensureGlobalWorkspace();
      const { relativePath, absolutePath } = assertSafeGlobalWorkspacePath(filePath);
      await writeTextFile(absolutePath, content);
      return { path: relativePath, content };
    },

    async createGlobalWorkspaceFolder(folderPath) {
      await ensureGlobalWorkspace();
      const { relativePath, absolutePath } = assertSafeGlobalWorkspacePath(folderPath);
      await mkdir(absolutePath, { recursive: true });
      return { path: relativePath, name: path.posix.basename(relativePath), type: 'directory' };
    },

    async createGlobalWorkspaceFile(filePath, content) {
      return this.writeGlobalWorkspaceFile(filePath, content);
    },

    async createGlobalWorkspaceAsset(filePath, bytes, mimeType) {
      await ensureGlobalWorkspace();
      const { relativePath, absolutePath } = assertSafeGlobalWorkspacePath(filePath);
      await createAssetFile(absolutePath, bytes);
      const fileStat = await stat(absolutePath);
      return {
        path: relativePath,
        name: path.posix.basename(relativePath),
        type: 'file',
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
        mimeType: mimeType || inferMimeType(relativePath),
      };
    },

    async moveGlobalWorkspaceEntry(sourcePath, targetPath) {
      await ensureGlobalWorkspace();
      const source = assertSafeGlobalWorkspacePath(sourcePath);
      const target = assertSafeGlobalWorkspacePath(targetPath);
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await rename(source.absolutePath, target.absolutePath);
      const movedStat = await stat(target.absolutePath);
      return {
        path: target.relativePath,
        name: path.posix.basename(target.relativePath),
        type: movedStat.isDirectory() ? 'directory' : 'file',
        ...(movedStat.isFile()
          ? { size: movedStat.size, updatedAt: movedStat.mtime.toISOString(), mimeType: inferMimeType(target.relativePath) }
          : {}),
      };
    },

    async deleteGlobalWorkspaceEntry(entryPath) {
      await ensureGlobalWorkspace();
      const { absolutePath } = assertSafeGlobalWorkspacePath(entryPath);
      await rm(absolutePath, { recursive: true, force: false });
      return { deleted: true };
    },

    async listWorkspaceEntries(projectId) {
      return listEntriesForRoot(projectRoot(projectId));
    },

    async readWorkspaceFile(projectId, filePath) {
      const { relativePath, absolutePath } = assertSafeWorkspacePath(projectId, filePath);
      return { path: relativePath, content: await readFile(absolutePath, 'utf8') };
    },

    async readWorkspaceFileBytes(projectId, filePath) {
      const { relativePath, absolutePath } = assertSafeWorkspacePath(projectId, filePath);
      return {
        path: relativePath,
        bytes: await readFile(absolutePath),
        mimeType: inferMimeType(relativePath),
      };
    },

    async writeWorkspaceFile(projectId, filePath, content) {
      const { relativePath, absolutePath } = assertSafeWorkspacePath(projectId, filePath);
      await writeTextFile(absolutePath, content);
      return { path: relativePath, content };
    },

    async createWorkspaceFolder(projectId, folderPath) {
      const { relativePath, absolutePath } = assertSafeWorkspacePath(projectId, folderPath);
      await mkdir(absolutePath, { recursive: true });
      return { path: relativePath, name: path.posix.basename(relativePath), type: 'directory' };
    },

    async createWorkspaceFile(projectId, filePath, content) {
      return this.writeWorkspaceFile(projectId, filePath, content);
    },

    async createWorkspaceAsset(projectId, filePath, bytes, mimeType) {
      const { relativePath, absolutePath } = assertSafeWorkspacePath(projectId, filePath);
      await createAssetFile(absolutePath, bytes);
      const fileStat = await stat(absolutePath);
      return {
        path: relativePath,
        name: path.posix.basename(relativePath),
        type: 'file',
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
        mimeType: mimeType || inferMimeType(relativePath),
      };
    },

    async moveWorkspaceEntry(projectId, sourcePath, targetPath) {
      const source = assertSafeWorkspacePath(projectId, sourcePath);
      const target = assertSafeWorkspacePath(projectId, targetPath);
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await rename(source.absolutePath, target.absolutePath);
      const movedStat = await stat(target.absolutePath);
      return {
        path: target.relativePath,
        name: path.posix.basename(target.relativePath),
        type: movedStat.isDirectory() ? 'directory' : 'file',
        ...(movedStat.isFile()
          ? { size: movedStat.size, updatedAt: movedStat.mtime.toISOString(), mimeType: inferMimeType(target.relativePath) }
          : {}),
      };
    },

    async deleteWorkspaceEntry(projectId, entryPath) {
      const { absolutePath } = assertSafeWorkspacePath(projectId, entryPath);
      await rm(absolutePath, { recursive: true, force: false });
      return { deleted: true };
    },
  };
}

function normalizeWorkspacePath(filePath: string): string {
  return path.normalize(filePath).replaceAll(path.sep, '/');
}

function inferMimeType(filePath: string): string {
  if (/\.md$/i.test(filePath)) return 'text/markdown; charset=utf-8';
  if (/\.txt$/i.test(filePath)) return 'text/plain; charset=utf-8';
  if (/\.toml$/i.test(filePath)) return 'text/plain; charset=utf-8';
  if (/\.json$/i.test(filePath)) return 'application/json; charset=utf-8';
  if (/\.csv$/i.test(filePath)) return 'text/csv; charset=utf-8';
  if (/\.ya?ml$/i.test(filePath)) return 'application/yaml; charset=utf-8';
  if (/\.html?$/i.test(filePath)) return 'text/html; charset=utf-8';
  if (/\.pdf$/i.test(filePath)) return 'application/pdf';
  if (/\.png$/i.test(filePath)) return 'image/png';
  if (/\.jpe?g$/i.test(filePath)) return 'image/jpeg';
  if (/\.gif$/i.test(filePath)) return 'image/gif';
  if (/\.webp$/i.test(filePath)) return 'image/webp';
  if (/\.svg$/i.test(filePath)) return 'image/svg+xml';
  return 'application/octet-stream';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export const workspaceStore = createWorkspaceStore();
