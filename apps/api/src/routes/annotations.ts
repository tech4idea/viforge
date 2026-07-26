import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import type { DocumentAnnotationStore } from '../storage/documentAnnotationStore';
import type { WorkspaceStore } from '../storage/workspaceStore';

const annotationBaseSchema = z.object({
  filePath: z.string().trim().min(1),
  selectedText: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  beforeText: z.string(),
  afterText: z.string(),
  fileContentHash: z.string(),
  comment: z.string().trim().min(1),
});

const updateAnnotationSchema = z.object({
  filePath: z.string().trim().min(1),
  comment: z.string().trim().min(1).optional(),
  status: z.enum(['open', 'stale', 'resolved']).optional(),
  selectedText: z.string().min(1).optional(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(0).optional(),
  beforeText: z.string().optional(),
  afterText: z.string().optional(),
  fileContentHash: z.string().optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'filePath'), { message: 'No fields to update' });

export function createAnnotationRoutes(store: DocumentAnnotationStore, workspaceStore: WorkspaceStore): Hono {
  const routes = new Hono();

  routes.get('/projects/:projectId/annotations', async (context) => {
    const projectId = context.req.param('projectId');
    try {
      const missingProject = await ensureProjectExists(context, workspaceStore, projectId);
      if (missingProject) return missingProject;

      const filePath = context.req.query('filePath');
      if (filePath) {
        return context.json(await store.readAnnotations(projectId, filePath));
      }
      return context.json(await store.listAnnotationSummaries(projectId));
    } catch (error) {
      return handleKnownError(context, error, 'Annotations not found');
    }
  });

  routes.post('/projects/:projectId/annotations', async (context) => {
    const projectId = context.req.param('projectId');
    try {
      const missingProject = await ensureProjectExists(context, workspaceStore, projectId);
      if (missingProject) return missingProject;

      const parsed = annotationBaseSchema.safeParse(await parseJson(context.req.raw));
      if (!parsed.success) return context.json({ error: 'Invalid annotation' }, 400);

      return context.json(await store.createAnnotation(projectId, parsed.data), 201);
    } catch (error) {
      return handleKnownError(context, error, 'Annotation target not found');
    }
  });

  routes.patch('/projects/:projectId/annotations/:annotationId', async (context) => {
    const projectId = context.req.param('projectId');
    try {
      const missingProject = await ensureProjectExists(context, workspaceStore, projectId);
      if (missingProject) return missingProject;

      const parsed = updateAnnotationSchema.safeParse(await parseJson(context.req.raw));
      if (!parsed.success) return context.json({ error: 'Invalid annotation update' }, 400);

      return context.json(await store.updateAnnotation(projectId, context.req.param('annotationId'), parsed.data));
    } catch (error) {
      return handleKnownError(context, error, 'Annotation not found');
    }
  });

  routes.delete('/projects/:projectId/annotations/:annotationId', async (context) => {
    const projectId = context.req.param('projectId');
    try {
      const missingProject = await ensureProjectExists(context, workspaceStore, projectId);
      if (missingProject) return missingProject;

      const filePath = context.req.query('filePath');
      if (!filePath) return context.json({ error: 'Missing filePath' }, 400);

      return context.json(await store.deleteAnnotation(projectId, filePath, context.req.param('annotationId')));
    } catch (error) {
      return handleKnownError(context, error, 'Annotation not found');
    }
  });

  routes.delete('/projects/:projectId/annotations', async (context) => {
    const projectId = context.req.param('projectId');
    try {
      const missingProject = await ensureProjectExists(context, workspaceStore, projectId);
      if (missingProject) return missingProject;

      const filePath = context.req.query('filePath');
      if (!filePath) return context.json({ error: 'Missing filePath' }, 400);

      return context.json(await store.clearAnnotations(projectId, filePath));
    } catch (error) {
      return handleKnownError(context, error, 'Annotations not found');
    }
  });

  return routes;
}

async function ensureProjectExists(context: Context, store: WorkspaceStore, projectId: string): Promise<Response | undefined> {
  if (await store.getProject(projectId)) return undefined;
  return context.json({ error: 'Project not found' }, 404);
}

function handleKnownError(context: Context, error: unknown, notFoundMessage: string): Response {
  if (isInvalidWorkspaceError(error)) {
    return context.json({ error: 'Invalid workspace path' }, 400);
  }

  if (error instanceof Error && error.message === 'Annotation target must be a Markdown file') {
    return context.json({ error: error.message }, 400);
  }

  if (error instanceof Error && error.message === 'Invalid annotation file') {
    return context.json({ error: error.message }, 500);
  }

  if (error instanceof Error && error.message === 'Annotation not found') {
    return context.json({ error: notFoundMessage }, 404);
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
