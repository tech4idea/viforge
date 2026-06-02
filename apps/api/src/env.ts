import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FALLBACK_WORKSPACES_ROOT = path.join(
  os.homedir(),
  '.viwork',
  'data',
  'workspaces',
);

export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ? path.resolve(process.env.WORKSPACES_ROOT)
  : FALLBACK_WORKSPACES_ROOT;

export const LOGS_ROOT = process.env.LOGS_ROOT
  ? path.resolve(process.env.LOGS_ROOT)
  : path.resolve(API_ROOT, '..', '..', 'logs');

export const AIGC_HUB_BASE_URL = process.env.VIWORK_AIGC_HUB_BASE_URL ?? '';

export const AIGC_HUB_API_KEY = process.env.VIWORK_AIGC_HUB_API_KEY ?? '';

export const AIGC_HUB_CHAT_MODEL = process.env.VIWORK_AIGC_HUB_CHAT_MODEL ?? '';

export const AIGC_HUB_IMAGE_MODEL = process.env.VIWORK_AIGC_HUB_IMAGE_MODEL ?? '';
