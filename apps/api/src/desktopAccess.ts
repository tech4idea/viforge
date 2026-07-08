import type { Context, Hono } from 'hono';

const DESKTOP_TOKEN_COOKIE = 'viwork_desktop_token';

export function installDesktopAccessGuard(app: Hono): void {
  const expectedToken = process.env.VIWORK_DESKTOP_ACCESS_TOKEN;
  if (!expectedToken) return;

  app.use('*', async (context, next) => {
    if (isAuthorizedDesktopRequest(context, expectedToken)) {
      if (context.req.query('desktopToken') === expectedToken) {
        context.header('set-cookie', `${DESKTOP_TOKEN_COOKIE}=${encodeURIComponent(expectedToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      }
      await next();
      return;
    }

    return context.text('ViForge desktop session required', 403);
  });
}

function isAuthorizedDesktopRequest(context: Context, expectedToken: string): boolean {
  if (context.req.query('desktopToken') === expectedToken) return true;
  return parseCookie(context.req.header('cookie') ?? '')[DESKTOP_TOKEN_COOKIE] === expectedToken;
}

function parseCookie(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = pair.trim().split('=');
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rawValue.join('='));
  }
  return result;
}
