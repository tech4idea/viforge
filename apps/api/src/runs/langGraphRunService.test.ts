import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@viwork/shared';

import { createWorkspaceStore, type WorkspaceStore } from '../storage/workspaceStore';
import { createLangGraphRunService, __langGraphRunServiceTest } from './langGraphRunService';
import { createRunBus, type RunBus } from './runBus';

vi.setConfig({ testTimeout: 15_000 });

let root: string;
let store: WorkspaceStore;
let bus: RunBus;
let originalFetch: typeof fetch;
let originalBaseUrl: string | undefined;
let originalApiKey: string | undefined;
let originalImageModel: string | undefined;
let originalDatabaseUrl: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-LangGraph-run-service-'));
  store = createWorkspaceStore(root);
  bus = createRunBus();
  originalFetch = globalThis.fetch;
  originalBaseUrl = process.env.VIWORK_AIGC_HUB_BASE_URL;
  originalApiKey = process.env.VIWORK_AIGC_HUB_API_KEY;
  originalImageModel = process.env.VIWORK_AIGC_HUB_IMAGE_MODEL;
  originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  restoreEnv('VIWORK_AIGC_HUB_BASE_URL', originalBaseUrl);
  restoreEnv('VIWORK_AIGC_HUB_API_KEY', originalApiKey);
  restoreEnv('VIWORK_AIGC_HUB_IMAGE_MODEL', originalImageModel);
  restoreEnv('DATABASE_URL', originalDatabaseUrl);
  await rm(root, { recursive: true, force: true });
});

describe('langgraph run service', () => {
  it('streams text, tool lifecycle events, and workspace file changes through RunBus', async () => {
    const project = await store.createProject({ name: 'LangGraph Writers' });
    let capturedPrompt = '';
    let capturedThread: unknown = null;
    let writeTool: ReturnType<typeof __langGraphRunServiceTest.createWorkspaceTools>['write_workspace_file'] | null = null;

    const { run } = await createLangGraphRunService(store, bus, {
      createAgent({ tools }) {
        writeTool = tools.write_workspace_file;
        return {
          async stream(prompt, options) {
            capturedPrompt = typeof prompt === "string" ? prompt : prompt.map((message) => message.content).join("\n\n");
            capturedThread = options.memory;
            const toolResult = await tools.write_workspace_file.execute?.({
              path: '02 改编方案/第1集/单集改编方案.md',
              content: '# 单集改编方案\n\n第一集聚焦原著开端的人物选择。',
            }, {} as never);
            return {
              fullStream: asyncGenerator([
                { type: 'text-delta', payload: { text: '已完成改编方案初稿。' } },
                {
                  type: 'tool-call',
                  payload: {
                    toolCallId: 'tool_1',
                    toolName: 'write_workspace_file',
                    args: { path: '02 改编方案/第1集/单集改编方案.md' },
                  },
                },
                {
                  type: 'tool-result',
                  payload: { toolCallId: 'tool_1', toolName: 'write_workspace_file', result: toolResult },
                },
              ]),
            };
          },
          async generate() {
            return { text: '已完成改编方案初稿。' };
          },
        };
      },
    }).createRun({
      projectId: project.id,
      sessionId: 'session-1',
      prompt: '把原著第一章改编成第一集方案',
      referencedSnippets: [{
        id: 'snippet-1',
        messageId: 'message-1',
        role: 'assistant',
        label: '脑暴片段',
        text: '第一章、人物选择、结尾钩子',
        createdAt: '2026-06-02T00:00:00.000Z',
      }],
    });

    const events = await collectUntilEnd(bus, run.id);

    expect(writeTool).toBeTruthy();
    expect(capturedPrompt).toContain('# 小说改编剧本创作请求');
    expect(capturedPrompt).toContain('第一章、人物选择、结尾钩子');
    expect(capturedThread).toEqual({ thread: 'session-1', resource: project.id });
    await expect(store.readWorkspaceFile(project.id, '02 改编方案/第1集/单集改编方案.md')).resolves.toMatchObject({
      content: expect.stringContaining('第一集聚焦原著开端的人物选择'),
    });
    expect(events.map((event) => event.type)).toEqual([
      'run.start',
      'thread.started',
      'file.changed',
      'text.delta',
      'tool_use.start',
      'tool_use.delta',
      'tool_use.delta',
      'tool_use.end',
      'run.end',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', status: 'success' });
  });

  it('uses the project product profile for prompts and specialist registry setup', async () => {
    const project = await store.createProject({ name: 'Studio Sitcom', productId: 'sitcom' });
    let capturedPrompt = '';
    let capturedInstructions = '';
    let capturedProfileId = '';

    const { run } = await createLangGraphRunService(store, bus, {
      async createAgentRegistry(_tools, context) {
        capturedProfileId = context.productProfile?.id ?? '';
        return {
          brainstorm: null,
          character: null,
          continuity: null,
          story: null,
          sourceAnalyst: null,
          adaptationPlanner: null,
          screenwriter: null,
          reviewer: null,
          async systemAgent(instructions) {
            capturedInstructions = instructions;
            return {
              id: 'viwork-system-agent',
              async stream(prompt) {
                capturedPrompt = typeof prompt === "string" ? prompt : prompt.map((message) => message.content).join("\n\n");
                return { fullStream: asyncGenerator([{ type: 'text-delta', payload: { text: '情景剧处理完成。' } }]) };
              },
              async generate() {
                return { text: '情景剧处理完成。' };
              },
            };
          },
        };
      },
    }).createRun({
      projectId: project.id,
      sessionId: 'session-sitcom',
      prompt: '写一个职场误会单集故事',
    });

    await collectUntilEnd(bus, run.id);

    expect(capturedProfileId).toBe('sitcom');
    expect(capturedPrompt).toContain('# 情景剧创作请求');
    expect(capturedInstructions).toContain('情景剧');
    expect(capturedInstructions).not.toContain('小说改编剧本创作的全流程');
  });

  it('lets the main agent answer simple requests without specialist delegation', async () => {
    const project = await store.createProject({ name: 'Casual Chat' });
    let mainAgentTools: Record<string, unknown> | null = null;
    const specialistCalls: string[] = [];

    const { run } = await createLangGraphRunService(store, bus, {
      async createAgentRegistry(tools) {
        return {
          brainstorm: specialistAgent('brainstorm-agent', specialistCalls),
          character: specialistAgent('character-agent', specialistCalls),
          continuity: specialistAgent('continuity-agent', specialistCalls),
          story: specialistAgent('story-agent', specialistCalls),
          sourceAnalyst: specialistAgent('source-analyst-agent', specialistCalls),
          adaptationPlanner: specialistAgent('adaptation-planner-agent', specialistCalls),
          screenwriter: specialistAgent('screenwriter-agent', specialistCalls),
          reviewer: specialistAgent('reviewer-agent', specialistCalls),
          async systemAgent(_instructions, toolsOverride) {
            mainAgentTools = toolsOverride ?? tools;
            return {
              id: 'viwork-system-agent',
              async stream() {
                return { fullStream: asyncGenerator([{ type: 'text-delta', payload: { text: '你好，我在。' } }]) };
              },
              async generate() {
                return { text: '你好，我在。' };
              },
            };
          },
        };
      },
    }).createRun({
      projectId: project.id,
      sessionId: 'session-simple',
      prompt: '你好',
    });

    const events = await collectUntilEnd(bus, run.id);

    expect(mainAgentTools).toHaveProperty('delegate_to_specialist_agent');
    expect(specialistCalls).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['run.start', 'thread.started', 'text.delta', 'run.end']);
  });

  it('allows the main agent to delegate explicit specialist work on demand', async () => {
    const project = await store.createProject({ name: 'Specialist Delegation' });
    let delegateTool: { execute?: (input: { agentId: string; task: string; context?: string }, options: never) => Promise<unknown> } | null = null;
    const specialistCalls: string[] = [];

    const { run } = await createLangGraphRunService(store, bus, {
      async createAgentRegistry(tools) {
        return {
          brainstorm: specialistAgent('brainstorm-agent', specialistCalls),
          character: specialistAgent('character-agent', specialistCalls),
          continuity: specialistAgent('continuity-agent', specialistCalls),
          story: specialistAgent('story-agent', specialistCalls),
          sourceAnalyst: specialistAgent('source-analyst-agent', specialistCalls),
          adaptationPlanner: specialistAgent('adaptation-planner-agent', specialistCalls),
          screenwriter: specialistAgent('screenwriter-agent', specialistCalls),
          reviewer: specialistAgent('reviewer-agent', specialistCalls),
          async systemAgent(_instructions, toolsOverride) {
            delegateTool = (toolsOverride as typeof tools & { delegate_to_specialist_agent?: typeof delegateTool })?.delegate_to_specialist_agent ?? null;
            return {
              id: 'viwork-system-agent',
              async stream() {
                const result = await delegateTool?.execute?.({
                  agentId: 'reviewer-agent',
                  task: '严格审稿第一集剧本',
                  context: '用户明确要求审稿。',
                }, {} as never);
                return {
                  fullStream: asyncGenerator([
                    {
                      type: 'tool-call',
                      payload: {
                        toolCallId: 'tool_delegate',
                        toolName: 'delegate_to_specialist_agent',
                        args: { agentId: 'reviewer-agent' },
                      },
                    },
                    {
                      type: 'tool-result',
                      payload: { toolCallId: 'tool_delegate', toolName: 'delegate_to_specialist_agent', result },
                    },
                    { type: 'text-delta', payload: { text: '审稿完成。' } },
                  ]),
                };
              },
              async generate() {
                return { text: '审稿完成。' };
              },
            };
          },
        };
      },
    }).createRun({
      projectId: project.id,
      sessionId: 'session-delegate',
      prompt: '请严格审一下第一集剧本',
    });

    const events = await collectUntilEnd(bus, run.id);

    expect(delegateTool).toBeTruthy();
    expect(specialistCalls).toEqual(['reviewer-agent']);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.step.start', agentId: 'reviewer-agent' }),
      expect.objectContaining({ type: 'agent.step.end', agentId: 'reviewer-agent' }),
      expect.objectContaining({ type: 'tool_use.start', toolName: 'delegate_to_specialist_agent' }),
    ]));
    expect(events.at(-1)).toMatchObject({ type: 'run.end', status: 'success' });
  });

  it('stores working and semantic project memory through LangGraph Store tools', async () => {
    const project = await store.createProject({ name: 'Memory Tools' });
    const events: StreamEvent[] = [];
    const tools = __langGraphRunServiceTest.createWorkspaceTools(
      store,
      project.id,
      (event) => events.push(event),
      'run_memory_tools',
      () => '2026-06-04T00:00:00.000Z',
    );

    await tools.update_project_memory.execute?.({
      content: '# 项目记忆\n\n- 主角叫小程。',
      reason: '用户确认主角名称',
    }, {} as never);
    const working = await tools.read_project_memory.execute?.({}, {} as never) as { memory: string };

    const remembered = await tools.remember_project_memory.execute?.({
      memory: '用户偏好：主角小程要保持冷幽默，不要热血口号。',
      category: 'user_preference',
      reason: '后续角色对白需要遵守',
    }, {} as never) as { remembered: boolean; messageId: string };
    const recalled = await tools.recall_project_memory.execute?.({
      query: '小程的对白风格偏好',
      topK: 3,
    }, {} as never) as { matches: Array<{ content: string }> };

    expect(working.memory).toContain('主角叫小程');
    expect(remembered).toMatchObject({ remembered: true, messageId: expect.stringMatching(/^memory-/) });
    expect(recalled.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('冷幽默') }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'memory.write', memoryType: 'summary' }),
      expect.objectContaining({ type: 'memory.read', bytes: expect.any(Number) }),
      expect.objectContaining({ type: 'memory.write', memoryType: 'profile', content: expect.stringContaining('冷幽默') }),
      expect.objectContaining({ type: 'memory.recall', query: '小程的对白风格偏好' }),
    ]));
  });

  it('retrieves knowledge cards from the global knowledge index and publishes retrieval events', async () => {
    const project = await store.createProject({ name: 'Knowledge Tools' });
    await store.writeGlobalWorkspaceFile('知识库/index.yaml', [
      'version: 1',
      'entries:',
      '  - id: kb-mechanism-owner-group-misread',
      '    title: 业主群误会升级',
      '    path: mechanisms/误会升级/业主群误会升级.md',
      '    type: mechanism',
      '    tags: [误会, 群聊, 升级]',
      '    rightsRisk: low',
      '    updatedAt: "2026-06-04T00:00:00.000Z"',
    ].join('\n'));
    const events: StreamEvent[] = [];
    const tools = __langGraphRunServiceTest.createWorkspaceTools(
      store,
      project.id,
      (event) => events.push(event),
      'run_knowledge_tools',
      () => '2026-06-04T00:00:00.000Z',
    );

    const result = await tools.retrieve_knowledge_cards.execute?.({
      query: '业主群误会',
      tags: ['误会'],
      topK: 3,
    }, {} as never) as { matches: Array<{ id: string; title: string }> };

    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'kb-mechanism-owner-group-misread', title: '业主群误会升级' }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'knowledge.retrieve',
        query: '业主群误会',
        matches: expect.arrayContaining([expect.objectContaining({ id: 'kb-mechanism-owner-group-misread' })]),
      }),
    ]));
  });

  it('exposes image generation as an agent workspace tool', async () => {
    process.env.VIWORK_AIGC_HUB_BASE_URL = 'http://127.0.0.1:8000/v1';
    process.env.VIWORK_AIGC_HUB_API_KEY = 'hub_test_key';
    process.env.VIWORK_AIGC_HUB_IMAGE_MODEL = 'gpt-image-1';
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ b64_json: Buffer.from('fake-image').toString('base64'), revised_prompt: 'revised prompt' }],
    })) as unknown as typeof fetch;

    const project = await store.createProject({ name: 'Image Tool Project' });
    const events: StreamEvent[] = [];
    const tools = __langGraphRunServiceTest.createWorkspaceTools(
      store,
      project.id,
      (event) => events.push(event),
      'run_image_tool',
      () => '2026-06-04T00:00:00.000Z',
    );

    const result = await tools.generate_project_image.execute?.({
      prompt: '生成孙少平人物形象图',
      aspectRatio: '3:4',
      count: 1,
    }, {} as never) as { images: Array<{ path: string; mimeType: string; model?: string; revisedPrompt?: string }> };

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer hub_test_key' }),
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: '生成孙少平人物形象图',
          size: '1024x1536',
          n: 1,
          response_format: 'b64_json',
        }),
      }),
    );
    expect(result.images[0]).toEqual(expect.objectContaining({
      path: expect.stringMatching(/^生成图片\//),
      mimeType: 'image/png',
      model: 'gpt-image-1',
      revisedPrompt: 'revised prompt',
    }));
    expect(events).toEqual([
      expect.objectContaining({ type: 'file.changed', path: result.images[0]?.path, change: 'created' }),
      expect.objectContaining({
        type: 'image.generated',
        attachment: expect.objectContaining({
          path: result.images[0]?.path,
          kind: 'generated-image',
          model: 'gpt-image-1',
          aspectRatio: '3:4',
        }),
      }),
    ]);
    const raw = await store.readWorkspaceFileBytes(project.id, result.images[0]!.path);
    expect(raw.bytes.toString()).toBe('fake-image');
  });
});

function specialistAgent(agentId: string, calls: string[]) {
  return {
    id: agentId,
    async stream() {
      calls.push(agentId);
      return { fullStream: asyncGenerator([{ type: 'text-delta', payload: { text: `${agentId} output` } }]) };
    },
    async generate() {
      calls.push(agentId);
      return { text: `${agentId} output` };
    },
  };
}

async function* asyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function collectUntilEnd(bus: RunBus, runId: string): Promise<StreamEvent[]> {
  return new Promise((resolve) => {
    const events: StreamEvent[] = [];
    let unsubscribe: (() => void) | null = null;
    unsubscribe = bus.subscribe(runId, (event) => {
      events.push(event);
      if (event.type === 'run.end') {
        unsubscribe?.();
        resolve(events);
      }
    });
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
