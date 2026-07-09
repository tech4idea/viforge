import { Hono } from 'hono';
import net from 'node:net';

import { createPlaywriterService } from '../browser/playwriterService';
import type { BrowserConnectorConnection, BrowserConnectorStatus, BrowserConnectorTab } from '@viforge/shared';

const RELAY_PORT = 19988;

async function checkPortConflict(host: string): Promise<{ conflict: boolean; detail?: string }> {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return { conflict: false };
  }

  const relayHost = url.hostname || '127.0.0.1';
  const relayPort = Number(url.port) || RELAY_PORT;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3_000);

    socket.on('connect', () => {
      socket.destroy();
      resolve({ conflict: true, detail: `端口 ${relayPort} 已被其他程序占用，Playwriter relay 无法启动。` });
    });
    socket.on('error', () => {
      socket.destroy();
      resolve({ conflict: false });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ conflict: false });
    });

    socket.connect(relayPort, relayHost);
  });
}

async function getBrowserConnections(host: string | undefined): Promise<BrowserConnectorConnection[]> {
  if (!host) return [];

  try {
    const response = await fetch(new URL('/extensions/status', host), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return [];

    const body = await response.json() as { extensions?: unknown };
    if (!Array.isArray(body.extensions)) return [];

    return body.extensions.flatMap((item): BrowserConnectorConnection[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const extensionId = typeof record.extensionId === 'string' ? record.extensionId : '';
      if (!extensionId) return [];

      const profile = record.profile && typeof record.profile === 'object'
        ? record.profile as Record<string, unknown>
        : null;

      return [{
        extensionId,
        ...(typeof record.stableKey === 'string' ? { stableKey: record.stableKey } : {}),
        browser: typeof record.browser === 'string' ? record.browser : null,
        profile: profile
          ? {
              ...(typeof profile.email === 'string' ? { email: profile.email } : {}),
              ...(typeof profile.id === 'string' ? { id: profile.id } : {}),
            }
          : null,
        activeTargets: typeof record.activeTargets === 'number' ? record.activeTargets : 0,
      }];
    });
  } catch {
    return [];
  }
}

async function getBrowserTabs(host: string | undefined): Promise<BrowserConnectorTab[]> {
  if (!host) return [];

  try {
    const response = await fetch(new URL('/json/list', host), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return [];

    const body = await response.json() as unknown;
    if (!Array.isArray(body)) return [];

    return body.flatMap((item): BrowserConnectorTab[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      if (!id) return [];

      return [{
        id,
        ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
        ...(typeof record.url === 'string' && record.url.trim() ? { url: record.url.trim() } : {}),
      }];
    });
  } catch {
    return [];
  }
}

export function createBrowserRoutes(): Hono {
  const routes = new Hono();

  routes.get('/browser/status', async (context) => {
    const service = createPlaywriterService();
    const cli = await service.status();
    const guide = await service.installGuide();

    let portConflict = false;
    let portConflictDetail: string | undefined;

    if (cli.enabled && !guide.relayReachable && guide.error) {
      if (/EADDRINUSE|address already in use/i.test(guide.error)) {
        portConflict = true;
        portConflictDetail = guide.error;
      } else if (guide.host) {
        const check = await checkPortConflict(guide.host);
        portConflict = check.conflict;
        portConflictDetail = check.detail;
      }
    }

    const status: BrowserConnectorStatus = {
      relayReachable: guide.relayReachable,
      connectedBrowsers: guide.connectedBrowsers,
      connections: guide.relayReachable ? await getBrowserConnections(guide.host) : [],
      tabs: guide.relayReachable ? await getBrowserTabs(guide.host) : [],
      relayError: guide.relayReachable ? undefined : guide.error,
      cliAvailable: cli.enabled,
      cliError: cli.enabled ? undefined : cli.error,
      portConflict,
      portConflictDetail,
      installSteps: guide.steps,
    };

    return context.json(status);
  });

  return routes;
}
