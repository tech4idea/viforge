import { randomUUID } from 'node:crypto';

import { AIGC_HUB_APP_ID } from './env';

export function buildAigcHubHeaders(input: {
  apiKey?: string;
  appId?: string;
  traceId?: string;
  contentType?: string;
} = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  if (input.contentType) headers['content-type'] = input.contentType;

  const appId = input.appId ?? AIGC_HUB_APP_ID;
  if (appId) headers.appid = appId;
  if (input.traceId) headers.traceid = input.traceId;

  return headers;
}

export function traceIdFromRequest(request: Request): string {
  return request.headers.get('traceid')
    ?? request.headers.get('x-trace-id')
    ?? request.headers.get('x-request-id')
    ?? randomUUID();
}

export function gatewayTraceIdFromResponse(response: Response, fallback: string): string {
  return response.headers.get('traceid')
    ?? response.headers.get('x-trace-id')
    ?? fallback;
}
