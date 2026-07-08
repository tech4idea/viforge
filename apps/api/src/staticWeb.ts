import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Context, Hono } from 'hono';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function mountStaticWeb(app: Hono, root: string): void {
  app.get('*', async (context, next) => {
    if (context.req.path.startsWith('/api')) {
      await next();
      return;
    }

    const requestedPath = context.req.path === '/' ? 'index.html' : context.req.path.slice(1);
    const response = await serveFile(context, root, requestedPath);
    if (response) return response;
    return (await serveFile(context, root, 'index.html')) ?? context.text('Not found', 404);
  });
}

async function serveFile(context: Context, root: string, requestedPath: string): Promise<Response | null> {
  const filePath = path.resolve(root, requestedPath);
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return null;
    const bytes = await readFile(filePath);
    return context.body(bytes, 200, { 'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
