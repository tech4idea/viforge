import path from 'node:path';

export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ? path.resolve(process.env.WORKSPACES_ROOT)
  : path.resolve(process.cwd(), 'data', 'workspaces');
