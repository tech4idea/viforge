import { Hono } from 'hono';
import { z } from 'zod';

import type { GlobalGitConfig, ProjectGitConfig } from '@viwork/shared';
import type { GitConfigStore } from '../storage/gitConfigStore';
import type { GitService } from '../storage/gitService';
import type { WorkspaceStore } from '../storage/workspaceStore';

const setGlobalGitConfigSchema = z.object({
  accessToken: z.string().min(1),
  defaultBranch: z.string().optional(),
});

const setProjectGitConfigSchema = z.object({
  remoteUrl: z.string().min(1),
  accessToken: z.string().optional(),
  branch: z.string().optional(),
});

const syncSchema = z.object({
  message: z.string().optional(),
});

export function createGitRoutes(
  gitService: GitService,
  gitConfigStore: GitConfigStore,
  workspaceStore: WorkspaceStore,
): Hono {
  const routes = new Hono();

  routes.get('/git/config', async (context) => {
    const config = await gitConfigStore.getGlobalGitConfig();
    if (!config) {
      return context.json(null);
    }
    return context.json({
      ...config,
      accessToken: maskToken(config.accessToken),
    });
  });

  routes.put('/git/config', async (context) => {
    const body = await parseJson(context.req.raw);
    const parsed = setGlobalGitConfigSchema.safeParse(body);

    if (!parsed.success) {
      return context.json({ error: 'Invalid git config' }, 400);
    }

    await gitConfigStore.setGlobalGitConfig({
      accessToken: parsed.data.accessToken,
      defaultBranch: parsed.data.defaultBranch,
    });

    return context.json({
      ...parsed.data,
      accessToken: maskToken(parsed.data.accessToken),
    });
  });

  routes.get('/projects/:projectId/git', async (context) => {
    const projectId = context.req.param('projectId');
    const project = await workspaceStore.getProject(projectId);

    if (!project) {
      return context.json({ error: 'Project not found' }, 404);
    }

    try {
      const projectRoot = workspaceStore.getProjectRoot(projectId);
      const status = await gitService.getStatus(projectRoot);

      return context.json({
        ...status,
        lastSyncAt: project.git?.lastSyncAt,
        remoteUrl: project.git?.remoteUrl,
        branch: project.git?.branch ?? status.branch ?? 'main',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git status';
      return context.json({ error: errorMessage }, 500);
    }
  });

  routes.put('/projects/:projectId/git', async (context) => {
    const projectId = context.req.param('projectId');
    const project = await workspaceStore.getProject(projectId);

    if (!project) {
      return context.json({ error: 'Project not found' }, 404);
    }

    const body = await parseJson(context.req.raw);
    const parsed = setProjectGitConfigSchema.safeParse(body);

    if (!parsed.success) {
      return context.json({ error: 'Invalid git config' }, 400);
    }

    const branch = parsed.data.branch ?? 'main';
    const projectRoot = workspaceStore.getProjectRoot(projectId);

    const globalConfig = await gitConfigStore.getGlobalGitConfig();
    const token = parsed.data.accessToken ?? globalConfig?.accessToken;

    if (!token) {
      return context.json({ error: 'No access token configured. Set a global token or provide a project-level token.' }, 400);
    }

    try {
      await gitService.initProjectRepo(projectRoot, branch);
      await gitService.ensureRemoteConfigured(projectRoot, parsed.data.remoteUrl);

      const gitConfig: ProjectGitConfig = {
        remoteUrl: parsed.data.remoteUrl,
        accessToken: parsed.data.accessToken,
        branch,
        lastSyncAt: project.git?.lastSyncAt,
        lastCommitHash: project.git?.lastCommitHash,
      };

      const updatedProject = await workspaceStore.updateProjectGitConfig(projectId, gitConfig);
      return context.json(updatedProject.git);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to configure git';
      return context.json({ error: errorMessage }, 500);
    }
  });

  routes.post('/projects/:projectId/git/sync', async (context) => {
    const projectId = context.req.param('projectId');
    const project = await workspaceStore.getProject(projectId);

    if (!project) {
      return context.json({ error: 'Project not found' }, 404);
    }

    if (!project.git?.remoteUrl) {
      return context.json({ error: 'No remote repository configured' }, 400);
    }

    const body = await parseJson(context.req.raw);
    const parsed = syncSchema.safeParse(body ?? {});
    const message = parsed.success && parsed.data.message
      ? parsed.data.message
      : `Sync ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    const token = resolveToken(project, await gitConfigStore.getGlobalGitConfig());
    if (!token) {
      return context.json({ error: 'No access token configured' }, 400);
    }

    const branch = project.git.branch ?? 'main';
    const projectRoot = workspaceStore.getProjectRoot(projectId);

    try {
      const result = await gitService.commitAndPush(projectRoot, message, project.git.remoteUrl, token, branch);

      if (result.success && result.commitHash) {
        await workspaceStore.updateProjectGitConfig(projectId, {
          ...project.git,
          lastSyncAt: new Date().toISOString(),
          lastCommitHash: result.commitHash,
        });
      }

      return context.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Sync failed';
      return context.json({ success: false, filesChanged: 0, message: errorMessage } as const, 500);
    }
  });

  routes.post('/projects/:projectId/git/pull', async (context) => {
    const projectId = context.req.param('projectId');
    const project = await workspaceStore.getProject(projectId);

    if (!project) {
      return context.json({ error: 'Project not found' }, 404);
    }

    if (!project.git?.remoteUrl) {
      return context.json({ error: 'No remote repository configured' }, 400);
    }

    const token = resolveToken(project, await gitConfigStore.getGlobalGitConfig());
    if (!token) {
      return context.json({ error: 'No access token configured' }, 400);
    }

    const branch = project.git.branch ?? 'main';
    const projectRoot = workspaceStore.getProjectRoot(projectId);

    try {
      const result = await gitService.pullFromRemote(projectRoot, project.git.remoteUrl, token, branch);

      if (result.success && result.commitHash) {
        await workspaceStore.updateProjectGitConfig(projectId, {
          ...project.git,
          lastSyncAt: new Date().toISOString(),
          lastCommitHash: result.commitHash,
        });
      }

      return context.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Pull failed';
      return context.json({ success: false, filesChanged: 0, message: errorMessage } as const, 500);
    }
  });

  routes.get('/projects/:projectId/git/log', async (context) => {
    const projectId = context.req.param('projectId');
    const project = await workspaceStore.getProject(projectId);

    if (!project) {
      return context.json({ error: 'Project not found' }, 404);
    }

    const projectRoot = workspaceStore.getProjectRoot(projectId);
    const maxCount = Number(context.req.query('maxCount') ?? '20');

    try {
      const log = await gitService.getLog(projectRoot, maxCount);
      return context.json(log);
    } catch {
      return context.json([]);
    }
  });

  return routes;
}

function resolveToken(
  project: { git?: { accessToken?: string } },
  globalConfig: GlobalGitConfig | null,
): string | null {
  return project.git?.accessToken ?? globalConfig?.accessToken ?? null;
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return '****';
  }
  return `${token.slice(0, 4)}${'*'.repeat(token.length - 8)}${token.slice(-4)}`;
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
