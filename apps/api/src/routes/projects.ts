import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import type { WorkspaceStore } from '../storage/workspaceStore';
import { PRODUCT_PROFILE } from '../env';

const createProjectSchema = z.object({
  name: z.string().transform((name) => name.trim()).pipe(z.string().min(1)),
  description: z.string().optional(),
});

const updateProjectSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1))
      .optional(),
    description: z.string().optional(),
  })
  .strict();

const writeFileSchema = z.object({
  content: z.string(),
});

const createFolderSchema = z.object({
  path: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
});

const createFileSchema = z.object({
  path: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  content: z.string().default(''),
});

const createAssetSchema = z.object({
  path: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  contentBase64: z.string().min(1),
  mimeType: z.string().optional(),
});

const moveEntrySchema = z.object({
  targetPath: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
});

export function createProjectsRoutes(store: WorkspaceStore): Hono {
  const routes = new Hono();

  routes.get('/product-profile', (context) => context.json(PRODUCT_PROFILE));

  routes.get('/global/files', async (context) => {
    try {
      return context.json(await store.listGlobalWorkspaceEntries());
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.post('/global/folders', async (context) => {
    try {
      const parsed = createFolderSchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid folder' }, 400);
      }

      return context.json(await store.createGlobalWorkspaceFolder(parsed.data.path), 201);
    } catch (error) {
      return handleKnownError(context, error, 'Folder not found');
    }
  });

  routes.post('/global/files', async (context) => {
    try {
      const parsed = createFileSchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid file' }, 400);
      }

      return context.json(await store.createGlobalWorkspaceFile(parsed.data.path, parsed.data.content), 201);
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.post('/global/assets', async (context) => {
    try {
      const parsed = createAssetSchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid asset' }, 400);
      }

      const base64 = parsed.data.contentBase64.replace(/^data:[^;]+;base64,/, '');
      const asset = await store.createGlobalWorkspaceAsset(
        parsed.data.path,
        Buffer.from(base64, 'base64'),
        parsed.data.mimeType,
      );
      return context.json(asset, 201);
    } catch (error) {
      return handleKnownError(context, error, 'Asset not found');
    }
  });

  routes.get('/global/raw/*', async (context) => {
    try {
      const file = await store.readGlobalWorkspaceFileBytes(globalRawPathFromRequest(context.req.raw));
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          'content-type': file.mimeType,
          'content-length': String(file.bytes.length),
        },
      });
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.patch('/global/files/*', async (context, next) => {
    if (!new URL(context.req.raw.url).pathname.endsWith('/move')) {
      return next();
    }

    try {
      const parsed = moveEntrySchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid target path' }, 400);
      }

      const sourcePath = globalMoveSourcePathFromRequest(context.req.raw);
      return context.json(await store.moveGlobalWorkspaceEntry(sourcePath, parsed.data.targetPath));
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.get('/global/files/*', async (context) => {
    try {
      return context.json(await store.readGlobalWorkspaceFile(globalFilePathFromRequest(context.req.raw)));
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.put('/global/files/*', async (context) => {
    try {
      const body = await parseJson(context.req.raw);
      const parsed = writeFileSchema.safeParse(body);

      if (!parsed.success) {
        return context.json({ error: 'Invalid file content' }, 400);
      }

      const filePath = globalFilePathFromRequest(context.req.raw);
      const file = await store.writeGlobalWorkspaceFile(filePath, parsed.data.content);

      return context.json(file);
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.delete('/global/files/*', async (context) => {
    try {
      return context.json(await store.deleteGlobalWorkspaceEntry(globalFilePathFromRequest(context.req.raw)));
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.get('/projects', async (context) => {
    return context.json(await store.listProjects());
  });

  routes.post('/projects', async (context) => {
    const body = await parseJson(context.req.raw);
    const parsed = createProjectSchema.safeParse(body);

    if (!parsed.success) {
      return context.json({ error: 'Invalid project' }, 400);
    }

    const project = await store.createProject(parsed.data);
    return context.json(project, 201);
  });

  routes.get('/projects/:projectId', async (context) => {
    try {
      const project = await store.getProject(context.req.param('projectId'));

      if (!project) {
        return context.json({ error: 'Project not found' }, 404);
      }

      return context.json(project);
    } catch (error) {
      return handleKnownError(context, error, 'Project not found');
    }
  });

  routes.delete('/projects/:projectId', async (context) => {
    try {
      return context.json(await store.deleteProject(context.req.param('projectId')));
    } catch (error) {
      return handleKnownError(context, error, 'Project not found');
    }
  });

  routes.patch('/projects/:projectId', async (context) => {
    const body = await parseJson(context.req.raw);
    const parsed = updateProjectSchema.safeParse(body);

    if (!parsed.success) {
      return context.json({ error: 'Invalid project update' }, 400);
    }

    if (parsed.data.name === undefined && parsed.data.description === undefined) {
      return context.json({ error: 'No fields to update' }, 400);
    }

    try {
      const project = await store.updateProject(context.req.param('projectId'), parsed.data);
      return context.json(project);
    } catch (error) {
      return handleKnownError(context, error, 'Project not found');
    }
  });

  routes.get('/projects/:projectId/files', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      if (!(await store.getProject(projectId))) {
        return context.json({ error: 'Project not found' }, 404);
      }

      return context.json(await store.listWorkspaceEntries(projectId, { query: '' }));
    } catch (error) {
      return handleKnownError(context, error, 'Project not found');
    }
  });

  routes.post('/projects/:projectId/folders', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      const parsed = createFolderSchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid folder' }, 400);
      }

      return context.json(await store.createWorkspaceFolder(projectId, parsed.data.path), 201);
    } catch (error) {
      return handleKnownError(context, error, 'Folder not found');
    }
  });

  routes.post('/projects/:projectId/files', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      const parsed = createFileSchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid file' }, 400);
      }

      return context.json(await store.createWorkspaceFile(projectId, parsed.data.path, parsed.data.content), 201);
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.post('/projects/:projectId/assets', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      const parsed = createAssetSchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid asset' }, 400);
      }

      const base64 = parsed.data.contentBase64.replace(/^data:[^;]+;base64,/, '');
      const asset = await store.createWorkspaceAsset(
        projectId,
        parsed.data.path,
        Buffer.from(base64, 'base64'),
        parsed.data.mimeType,
      );
      return context.json(asset, 201);
    } catch (error) {
      return handleKnownError(context, error, 'Asset not found');
    }
  });

  routes.get('/projects/:projectId/raw/*', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      const file = await store.readWorkspaceFileBytes(projectId, rawPathFromRequest(context.req.raw, projectId));
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          'content-type': file.mimeType,
          'content-length': String(file.bytes.length),
        },
      });
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.patch('/projects/:projectId/files/*', async (context, next) => {
    if (!new URL(context.req.raw.url).pathname.endsWith('/move')) {
      return next();
    }

    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      const parsed = moveEntrySchema.safeParse(await parseJson(context.req.raw));

      if (!parsed.success) {
        return context.json({ error: 'Invalid target path' }, 400);
      }

      const sourcePath = moveSourcePathFromRequest(context.req.raw, projectId);
      return context.json(await store.moveWorkspaceEntry(projectId, sourcePath, parsed.data.targetPath));
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.get('/projects/:projectId/files/*', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      return context.json(await store.readWorkspaceFile(projectId, filePathFromRequest(context.req.raw, projectId)));
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.put('/projects/:projectId/files/*', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      const body = await parseJson(context.req.raw);
      const parsed = writeFileSchema.safeParse(body);

      if (!parsed.success) {
        return context.json({ error: 'Invalid file content' }, 400);
      }

      const filePath = filePathFromRequest(context.req.raw, projectId);
      const file = await store.writeWorkspaceFile(projectId, filePath, parsed.data.content);

      return context.json(file);
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  routes.delete('/projects/:projectId/files/*', async (context) => {
    const projectId = context.req.param('projectId');

    try {
      const missingProject = await ensureProjectExists(context, store, projectId);

      if (missingProject) {
        return missingProject;
      }

      return context.json(await store.deleteWorkspaceEntry(projectId, filePathFromRequest(context.req.raw, projectId)));
    } catch (error) {
      return handleKnownError(context, error, 'File not found');
    }
  });

  return routes;
}

function globalRawPathFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const pathPrefix = '/global/raw/';
  const pathStart = pathname.indexOf(pathPrefix);

  try {
    return decodeURIComponent(pathname.slice(pathStart + pathPrefix.length));
  } catch {
    throw new Error('Invalid workspace path');
  }
}

function globalMoveSourcePathFromRequest(request: Request): string {
  const filePath = globalFilePathFromRequest(request);
  return filePath.endsWith('/move') ? filePath.slice(0, -'/move'.length) : filePath;
}

function globalFilePathFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const pathPrefix = '/global/files/';
  const pathStart = pathname.indexOf(pathPrefix);

  try {
    return decodeURIComponent(pathname.slice(pathStart + pathPrefix.length));
  } catch {
    throw new Error('Invalid workspace path');
  }
}

function rawPathFromRequest(request: Request, projectId: string): string {
  const pathname = new URL(request.url).pathname;
  const pathPrefix = `/projects/${projectId}/raw/`;
  const pathStart = pathname.indexOf(pathPrefix);

  try {
    return decodeURIComponent(pathname.slice(pathStart + pathPrefix.length));
  } catch {
    throw new Error('Invalid workspace path');
  }
}

function moveSourcePathFromRequest(request: Request, projectId: string): string {
  const path = filePathFromRequest(request, projectId);
  return path.endsWith('/move') ? path.slice(0, -'/move'.length) : path;
}

async function ensureProjectExists(context: Context, store: WorkspaceStore, projectId: string): Promise<Response | undefined> {
  if (await store.getProject(projectId)) {
    return undefined;
  }

  return context.json({ error: 'Project not found' }, 404);
}

function filePathFromRequest(request: Request, projectId: string): string {
  const pathname = new URL(request.url).pathname;
  const pathPrefix = `/projects/${projectId}/files/`;
  const pathStart = pathname.indexOf(pathPrefix);

  try {
    return decodeURIComponent(pathname.slice(pathStart + pathPrefix.length));
  } catch {
    throw new Error('Invalid workspace path');
  }
}

function handleKnownError(context: Context, error: unknown, notFoundMessage: string): Response {
  if (isInvalidWorkspaceError(error) || error instanceof URIError) {
    return context.json({ error: 'Invalid workspace path' }, 400);
  }

  if (isNotFoundError(error)) {
    return context.json({ error: notFoundMessage }, 404);
  }

  throw error;
}

function isInvalidWorkspaceError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'Invalid workspace path' || error.message === 'Invalid project id');
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
