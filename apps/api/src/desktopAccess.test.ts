import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { installDesktopAccessGuard } from './desktopAccess';

const originalToken = process.env.VIWORK_DESKTOP_ACCESS_TOKEN;

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.VIWORK_DESKTOP_ACCESS_TOKEN;
  } else {
    process.env.VIWORK_DESKTOP_ACCESS_TOKEN = originalToken;
  }
});

describe('desktop access guard', () => {
  it('requires the desktop token when enabled and stores it in an HttpOnly cookie', async () => {
    process.env.VIWORK_DESKTOP_ACCESS_TOKEN = 'desktop-secret';
    const app = new Hono();
    installDesktopAccessGuard(app);
    app.get('/api/ping', (context) => context.json({ ok: true }));

    expect((await app.request('/api/ping')).status).toBe(403);

    const first = await app.request('/api/ping?desktopToken=desktop-secret');
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toContain('viwork_desktop_token=desktop-secret');

    const second = await app.request('/api/ping', {
      headers: { cookie: 'viwork_desktop_token=desktop-secret' },
    });
    expect(second.status).toBe(200);
  });
});
