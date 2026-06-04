import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './api';

describe('api client', () => {
  it('encodes project ids and workspace path segments without flattening slashes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ path: 'folder name/a+b.txt', content: 'hello' }));
    const client = createApiClient({ fetch: fetchMock, baseUrl: '/api root' });

    await client.readWorkspaceFile('project/id', 'folder name/a+b.txt');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api root/api/projects/project%2Fid/files/folder%20name/a%2Bb.txt',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws the response error message for non-2xx JSON errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Project not found' }, { status: 404 }));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client.listWorkspaceEntries('missing project')).rejects.toThrow('Project not found');
  });

  it('calls theater management endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ok: true }));
    const client = createApiClient({ fetch: fetchMock, baseUrl: '/base' });

    await client.createFolder('project-1', 'episodes/episode-02');
    await client.moveEntry('project-1', 'drafts/scene.md', 'episodes/episode-02/script.md');
    await client.deleteProject('project-1');
    await client.updateSkill('conflict-pass', { enabled: false });
    await client.createWechatSetupSession();

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/base/api/projects/project-1/folders',
      '/base/api/projects/project-1/files/drafts/scene.md/move',
      '/base/api/projects/project-1',
      '/base/api/skills/conflict-pass',
      '/base/api/wechat/setup-sessions',
    ]);
  });

  it('calls chat session endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ id: 'session-1' }));
    const client = createApiClient({ fetch: fetchMock, baseUrl: '/base' });
    const message = {
      id: 'message-1',
      role: 'user' as const,
      content: '写第一场',
      createdAt: '2026-05-18T00:00:00.000Z',
      referencedFiles: [],
      streamEvents: [],
    };

    await client.listChatSessions('project-1');
    await client.listChatSessions('project-1', { includeArchived: true });
    await client.listTemporaryChatSessions({ includeArchived: true });
    await client.createChatSession('project-1');
    await client.createTemporaryChatSession();
    await client.updateChatSession('session-1', { codexThreadId: 'thread-1' });
    await client.appendChatMessage('session-1', message);
    await client.updateChatMessage('session-1', 'message-1', { ...message, content: '写第二场' });
    await client.archiveChatSession('session-1');
    await client.restoreChatSession('session-1');

    expect(fetchMock.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      ['/base/api/projects/project-1/chat-sessions', 'GET'],
      ['/base/api/projects/project-1/chat-sessions?includeArchived=true', 'GET'],
      ['/base/api/temporary-chat-sessions?includeArchived=true', 'GET'],
      ['/base/api/projects/project-1/chat-sessions', 'POST'],
      ['/base/api/temporary-chat-sessions', 'POST'],
      ['/base/api/chat-sessions/session-1', 'PATCH'],
      ['/base/api/chat-sessions/session-1/messages', 'POST'],
      ['/base/api/chat-sessions/session-1/messages/message-1', 'PUT'],
      ['/base/api/chat-sessions/session-1/archive', 'POST'],
      ['/base/api/chat-sessions/session-1/restore', 'POST'],
    ]);
  });

  it('calls global workspace endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ok: true }));
    const client = createApiClient({ fetch: fetchMock, baseUrl: '/base' });

    await client.listGlobalWorkspaceEntries();
    await client.readGlobalWorkspaceFile('Agent 配置/AGENTS.md');
    await client.writeGlobalWorkspaceFile('Agent 配置/AGENTS.md', '# Global');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/base/api/global/files',
      '/base/api/global/files/Agent%20%E9%85%8D%E7%BD%AE/AGENTS.md',
      '/base/api/global/files/Agent%20%E9%85%8D%E7%BD%AE/AGENTS.md',
    ]);
  });

  it('calls the product profile endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'novel-adaptation' }));
    const client = createApiClient({ fetch: fetchMock, baseUrl: '/base' });

    await expect(client.getProductProfile()).resolves.toEqual({ id: 'novel-adaptation' });

    expect(fetchMock).toHaveBeenCalledWith('/base/api/product-profile', expect.objectContaining({ method: 'GET' }));
  });

  it('sends referenced files with run requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run: { id: 'run_1' }, events: [] }));
    const client = createApiClient({ fetch: fetchMock, baseUrl: '/base' });

    await client.createRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      codexThreadId: 'thread-1',
      prompt: '参考设定补写第一场',
      referencedFiles: [{ path: 'characters.md', label: 'characters.md' }],
      referencedSnippets: [{
        id: 'snippet-1',
        messageId: 'message-1',
        role: 'assistant',
        label: '创作助手片段',
        text: '商场失物招领处',
        createdAt: '2026-05-18T00:00:00.000Z',
      }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/base/api/runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectId: 'project-1',
          sessionId: 'session-1',
          codexThreadId: 'thread-1',
          prompt: '参考设定补写第一场',
          referencedFiles: [{ path: 'characters.md', label: 'characters.md' }],
          referencedSnippets: [{
            id: 'snippet-1',
            messageId: 'message-1',
            role: 'assistant',
            label: '创作助手片段',
            text: '商场失物招领处',
            createdAt: '2026-05-18T00:00:00.000Z',
          }],
        }),
      }),
    );
  });

  it('opens an event stream for run events', () => {
    const originalEventSource = globalThis.EventSource;
    const close = vi.fn();
    const eventSources: Array<{ url: string; close: () => void }> = [];
    class FakeEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      url: string;
      constructor(url: string) {
        this.url = url;
        eventSources.push({ url, close });
      }
      close = close;
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const client = createApiClient({ baseUrl: '/base' });

    const unsubscribe = client.streamRunEvents('run_1', { onEvent: vi.fn() });
    unsubscribe();

    expect(eventSources[0]?.url).toBe('/base/api/runs/run_1/events');
    expect(close).toHaveBeenCalled();
    globalThis.EventSource = originalEventSource;
  });

  it('closes the event stream after run.end without reporting an interrupted stream', () => {
    const originalEventSource = globalThis.EventSource;
    const close = vi.fn();
    const eventSources: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: (() => void) | null;
      url: string;
      close: () => void;
    }> = [];
    class FakeEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        eventSources.push(this);
      }
      close = close;
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const client = createApiClient({ baseUrl: '/base' });
    const onEvent = vi.fn();
    const onError = vi.fn();

    client.streamRunEvents('run_1', { onEvent, onError });
    eventSources[0]?.onmessage?.({
      data: JSON.stringify({ type: 'run.end', runId: 'run_1', status: 'success', errorMessage: null, emittedAt: 'now' }),
    } as MessageEvent);
    eventSources[0]?.onerror?.();

    expect(close).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'run.end', status: 'success' }));
    expect(onError).not.toHaveBeenCalled();
    globalThis.EventSource = originalEventSource;
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}
