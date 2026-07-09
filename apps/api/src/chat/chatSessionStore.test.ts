import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ChatMessage } from '@viforge/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChatSessionStore } from './chatSessionStore';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viforge-chat-store-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('chat session store', () => {
  it('serializes concurrent message writes into one complete state file', async () => {
    const statePath = path.join(root, 'chat-sessions.json');
    const store = createChatSessionStore(statePath);
    const session = await store.createSession('project-1');

    const messages: ChatMessage[] = Array.from({ length: 32 }, (_, index) => ({
      id: `message-${index}`,
      role: 'user',
      content: `消息 ${index}`,
      createdAt: `2026-05-18T00:00:${String(index).padStart(2, '0')}.000Z`,
      referencedFiles: [],
      referencedSnippets: [],
      streamEvents: [],
    }));

    await Promise.all(messages.map((message) => store.appendMessage(session.id, message)));

    const [storedSession] = await store.listProjectSessions('project-1', { includeArchived: true });
    expect(storedSession.messages).toHaveLength(messages.length);
    expect(new Set(storedSession.messages.map((message) => message.id))).toEqual(new Set(messages.map((message) => message.id)));
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { sessions?: unknown[] };
    expect(persisted.sessions).toHaveLength(1);
  });
});
