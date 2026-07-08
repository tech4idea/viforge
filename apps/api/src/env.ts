import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProductProfile } from '@viwork/shared';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FALLBACK_WORKSPACES_ROOT = path.join(
  os.homedir(),
  '.viwork',
  'data',
  resolveProductProfile(process.env.VIWORK_PRODUCT).id,
  'workspaces',
);

export const PRODUCT_PROFILE = resolveProductProfile(process.env.VIWORK_PRODUCT);

export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ? path.resolve(process.env.WORKSPACES_ROOT)
  : FALLBACK_WORKSPACES_ROOT;

export const LOGS_ROOT = process.env.LOGS_ROOT
  ? path.resolve(process.env.LOGS_ROOT)
  : path.resolve(API_ROOT, '..', '..', 'logs');

export const AIGC_HUB_BASE_URL = process.env.VIWORK_AIGC_HUB_BASE_URL ?? '';

export const AIGC_HUB_API_KEY = process.env.VIWORK_AIGC_HUB_API_KEY ?? '';

export const AIGC_HUB_APP_ID = process.env.VIWORK_AIGC_HUB_APP_ID || `viforge-${PRODUCT_PROFILE.id}`;

export const AIGC_HUB_CHAT_MODEL = process.env.VIWORK_AIGC_HUB_CHAT_MODEL ?? '';

export const AIGC_HUB_IMAGE_MODEL = process.env.VIWORK_AIGC_HUB_IMAGE_MODEL ?? 'minimax/image-01';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';

export const QDRANT_URL = process.env.QDRANT_URL ?? '';

export const EMBEDDING_MODEL = process.env.VIWORK_AIGC_HUB_EMBEDDING_MODEL ?? 'doubao-embedding-vision';

export const PHOENIX_COLLECTOR_ENDPOINT = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? '';
export const PHOENIX_PROJECT_NAME = process.env.PHOENIX_PROJECT_NAME ?? 'viforge';
export const PHOENIX_SERVICE_NAME = process.env.PHOENIX_SERVICE_NAME ?? 'viforge-api';

export const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? '';
export const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? '';
export const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL ?? '';
export const LANGFUSE_PROMPT_LABEL = process.env.LANGFUSE_PROMPT_LABEL ?? 'production';
export const LANGFUSE_PROMPT_CACHE_TTL = Number(process.env.LANGFUSE_PROMPT_CACHE_TTL ?? '300');
