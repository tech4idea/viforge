import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { constants, type Dirent } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Codex, type Input, type ThreadEvent, type ThreadItem, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';
import type { AgentRun, StreamEvent } from '@viwork/shared';

import { appendJsonLog } from '../logger';
import { isDefaultAgentSkill, listAgentConfigSkillDefinitions } from '../skills/agentConfigSkills';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { RunBus } from './runBus';
import type { CreateRunInput, RunService } from './runService';

type CodexThread = {
  runStreamed(input: Input, options?: TurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }>;
};

type CodexClient = {
  startThread(options?: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
};

type CodexRunOptions = {
  codex?: CodexClient;
  codexPathOverride?: string;
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

type RunEndStreamEvent = Extract<StreamEvent, { type: 'run.end' }>;
type ToolStatus = 'running' | 'succeeded' | 'failed';

const RUN_DIAGNOSTIC_LOG = 'api-runs.jsonl';
const RUN_TEXT_LOG_LIMIT = 50_000;

type ItemState = {
  textByItemId: Map<string, string>;
  agentTraceKeys: Set<string>;
  thinkingByItemId: Map<string, { sequence: number; text: string }>;
  toolInputByItemId: Map<string, string>;
  toolOutputByItemId: Map<string, string>;
  toolStatusByItemId: Map<string, ToolStatus>;
  toolStarted: Set<string>;
  completedActionStatuses: ToolStatus[];
  pendingRunEnd: RunEndStreamEvent | null;
  runEnded: boolean;
  textSequence: number;
  toolSequence: number;
  thinkingSequence: number;
};

export function createCodexRunService(
  store: WorkspaceStore,
  bus: RunBus,
  options: CodexRunOptions = {},
): RunService {
  return {
    async createRun(input) {
      const project = await store.getProject(input.projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const timestamp = new Date().toISOString();
      const run: AgentRun = {
        id: `run_${randomUUID()}`,
        projectId: input.projectId,
        sessionId: input.sessionId,
        codexThreadId: input.codexThreadId,
        prompt: input.prompt,
        referencedFiles: input.referencedFiles ?? [],
        referencedSnippets: input.referencedSnippets ?? [],
        source: input.source ?? 'web',
        status: 'running',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      appendRunDiagnostic('createRun.accepted', {
        runId: run.id,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        codexThreadId: input.codexThreadId ?? null,
        source: input.source ?? 'web',
        prompt: textLogValue(input.prompt),
        referencedFiles: input.referencedFiles ?? [],
        referencedSnippets: input.referencedSnippets ?? [],
      });

      void executeCodexRun({
        bus,
        codex: options.codex,
        codexPathOverride: options.codexPathOverride,
        input,
        model: options.model,
        reasoningEffort: options.reasoningEffort ?? 'medium',
        run,
        store,
      });

      return { run };
    },
  };
}

async function executeCodexRun({
  bus,
  codex,
  codexPathOverride,
  input,
  model,
  reasoningEffort,
  run,
  store,
}: {
  bus: RunBus;
  codex?: CodexClient;
  codexPathOverride?: string;
  input: CreateRunInput;
  model?: string;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  run: AgentRun;
  store: WorkspaceStore;
}): Promise<void> {
  const state: ItemState = {
    textByItemId: new Map(),
    agentTraceKeys: new Set(),
    thinkingByItemId: new Map(),
    toolInputByItemId: new Map(),
    toolOutputByItemId: new Map(),
    toolStatusByItemId: new Map(),
    toolStarted: new Set(),
    completedActionStatuses: [],
    pendingRunEnd: null,
    runEnded: false,
    textSequence: 0,
    toolSequence: 0,
    thinkingSequence: 0,
  };
  const abortController = new AbortController();
  const publish = (event: StreamEvent) => {
    appendRunDiagnostic('stream.publish', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      event: summarizeStreamEvent(event),
    });
    bus.publish(event);
  };
  const emittedAt = () => new Date().toISOString();

  appendRunDiagnostic('execute.start', {
    runId: run.id,
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    codexThreadId: input.codexThreadId ?? null,
  });
  publish({ type: 'run.start', runId: run.id, emittedAt: emittedAt() });

  try {
    const prompt = await buildCodexPrompt(store, input);
    appendRunDiagnostic('prompt.built', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      prompt: textLogValue(prompt),
      referencedFileCount: input.referencedFiles?.length ?? 0,
      referencedSnippetCount: input.referencedSnippets?.length ?? 0,
    });
    const codexHome = await prepareCodexHome(store, input.sessionId ?? run.id);
    appendRunDiagnostic('codex.home.prepared', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      codexHome,
      codexHomeSummary: await summarizeCodexHome(codexHome),
    });
    const resolvedCodexPath = await resolveCodexPathOverride(codexPathOverride);
    appendRunDiagnostic('codex.path.resolved', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      codexPath: resolvedCodexPath,
      usingInjectedCodexClient: Boolean(codex),
    });
    const runtimeCodex = codex ?? new Codex({
      codexPathOverride: resolvedCodexPath,
      env: buildCodexEnv(codexHome),
      config: {
        show_raw_agent_reasoning: true,
      },
    });
    const additionalDirectories = await getGlobalResourceDirectories(store);
    const threadOptions: ThreadOptions = {
      workingDirectory: store.getProjectRoot(input.projectId),
      additionalDirectories,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      ...(model ? { model } : {}),
      modelReasoningEffort: reasoningEffort,
    };
    appendRunDiagnostic('thread.options', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      threadMode: input.codexThreadId ? 'resume' : 'start',
      threadOptions,
    });
    const thread = input.codexThreadId
      ? runtimeCodex.resumeThread(input.codexThreadId, threadOptions)
      : runtimeCodex.startThread(threadOptions);
    appendRunDiagnostic('thread.runStreamed.input', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      codexThreadId: input.codexThreadId ?? null,
      prompt: textLogValue(prompt),
    });
    const streamed = await thread.runStreamed(prompt, { signal: abortController.signal });
    appendRunDiagnostic('codex.stream.opened', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
    });

    for await (const event of streamed.events as AsyncIterable<ThreadEvent>) {
      appendRunDiagnostic('codex.event', {
        runId: run.id,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        event: summarizeThreadEvent(event),
      });
      handleCodexEvent(event, {
        emittedAt,
        publish,
        runId: run.id,
        state,
      });
    }
    appendRunDiagnostic('codex.stream.completed', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      state: summarizeItemState(state),
    });
    publishRunEnd(state.pendingRunEnd ?? {
      type: 'run.end',
      runId: run.id,
      emittedAt: emittedAt(),
      status: 'success',
      errorMessage: null,
    }, state, publish);
  } catch (error) {
    if (recoverPostToolCompletionFailure(error, state, {
      emittedAt,
      publish,
      runId: run.id,
    })) {
      appendRunDiagnostic('execute.recovered_after_tool_completion', {
        runId: run.id,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        codexThreadId: input.codexThreadId ?? null,
        error,
        state: summarizeItemState(state),
      });
      return;
    }

    appendRunDiagnostic('execute.error', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      codexThreadId: input.codexThreadId ?? null,
      error,
      state: summarizeItemState(state),
    });
    console.error('[codex-run] failed', {
      runId: run.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      codexThreadId: input.codexThreadId ?? null,
    }, error);
    publishRunEnd({
      type: 'run.end',
      runId: run.id,
      emittedAt: emittedAt(),
      status: 'error',
      errorMessage: cliRunErrorMessage(error, state),
    }, state, publish);
  }
}

async function prepareCodexHome(store: WorkspaceStore, sessionKey: string): Promise<string> {
  await store.listGlobalWorkspaceEntries();
  const globalRoot = store.getGlobalRoot();
  const sourceRoot = path.join(globalRoot, 'Agent 配置');
  const targetRoot = path.join(path.dirname(globalRoot), '.codex-home', sanitizeCodexHomeKey(sessionKey));

  await mkdir(targetRoot, { recursive: true });

  for (const entryName of ['AGENTS.md', 'auth.json', 'installation_id']) {
    const source = path.join(sourceRoot, entryName);
    const target = path.join(targetRoot, entryName);
    if (!(await pathExists(source))) {
      continue;
    }
    await writeFile(target, await readFile(source, 'utf8'), 'utf8');
  }

  await writeSanitizedCodexConfig(sourceRoot, targetRoot);

  for (const entryName of ['skills', 'plugins']) {
    const source = path.join(sourceRoot, entryName);
    const target = path.join(targetRoot, entryName);
    if (!(await pathExists(source))) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
  }

  return targetRoot;
}

const CODEX_BUNDLED_SKILL_BLOCK_HEADER = [
  '# viwork: do not let Codex load its own bundled skills or unrelated user skills.',
  '# These rules keep the sitcom-creation context clean: only _global/Agent 配置/skills stays visible.',
  '[skills.bundled]',
  'enabled = false',
  '',
].join('\n');

const CODEX_USER_SKILL_BLOCK_HEADER = [
  '# viwork: explicitly disable user-level skills that Codex picks up from outside CODEX_HOME',
  '# (for example, ~/.agents/skills or the user home).',
];

async function writeSanitizedCodexConfig(sourceRoot: string, targetRoot: string): Promise<void> {
  const sourceConfig = path.join(sourceRoot, 'config.toml');
  const targetConfig = path.join(targetRoot, 'config.toml');
  let baseContent = '';
  if (await pathExists(sourceConfig)) {
    baseContent = await readFile(sourceConfig, 'utf8');
  }
  const sanitizedBase = sanitizeCodexConfig(baseContent);
  const disabledUserSkills = await listDisablingUserSkillRules();
  const finalContent = [
    sanitizedBase,
    '',
    CODEX_BUNDLED_SKILL_BLOCK_HEADER,
    ...CODEX_USER_SKILL_BLOCK_HEADER,
    ...disabledUserSkills,
  ].join('\n');
  await writeFile(targetConfig, finalContent, 'utf8');
}

function sanitizeCodexConfig(content: string): string {
  // Keep viwork-relevant top-level model/auth settings and the [viwork] section.
  // Drop unrelated sections (other-project trust levels, TUI tweaks, etc.) that
  // should not leak from a developer's personal ~/.codex into a viwork session.
  const lines = content.split(/\r?\n/);
  const keepTopLevel = new Set([
    'model',
    'model_provider',
    'model_reasoning_effort',
    'disable_response_storage',
    'approval_policy',
    'sandbox_mode',
  ]);
  const keepSectionPrefixes = ['model_providers', 'viwork'];
  const out: string[] = [];
  let currentSection: string | null = null;
  let buffer: string[] = [];
  const flushSection = () => {
    const section = currentSection;
    if (section === null) {
      out.push(...buffer);
    } else if (keepSectionPrefixes.some((prefix) => section === prefix || section.startsWith(`${prefix}.`))) {
      out.push(...buffer);
    }
    buffer = [];
    currentSection = null;
  };
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (sectionMatch) {
      flushSection();
      currentSection = sectionMatch[1].trim();
      buffer.push(line);
      continue;
    }
    if (currentSection === null) {
      const topLevelMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (topLevelMatch) {
        const key = topLevelMatch[1];
        if (keepTopLevel.has(key)) {
          buffer.push(line);
        }
      } else if (line.trim() === '' || line.trim().startsWith('#')) {
        buffer.push(line);
      }
    } else {
      buffer.push(line);
    }
  }
  flushSection();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function listDisablingUserSkillRules(): Promise<string[]> {
  // The user home may have additional Codex skills under ~/.codex/skills or ~/.agents/skills.
  // We do not want those to leak into a viwork session, but viwork still needs to expose its
  // own skills under <CODEX_HOME>/skills. We only know about the user-level skill names that
  // are present on the current machine, so we enumerate them defensively. The rule order
  // means later rules win, so a developer can still opt in by appending a positive rule.
  const userSkillRoots = [
    path.join(os.homedir(), '.codex', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];
  const names = new Set<string>();
  for (const root of userSkillRoots) {
    if (!(await pathExists(root))) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        names.add(entry.name);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        names.add(path.basename(root));
      }
    }
  }
  if (names.size === 0) return [];
  const blocks: string[] = [];
  for (const name of [...names].sort()) {
    blocks.push('[[skills.config]]');
    blocks.push(`name = ${JSON.stringify(name)}`);
    blocks.push('enabled = false');
  }
  return blocks;
}

function sanitizeCodexHomeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `session_${randomUUID()}`;
}

async function getGlobalResourceDirectories(store: WorkspaceStore): Promise<string[]> {
  await store.listGlobalWorkspaceEntries();
  const globalRoot = store.getGlobalRoot();
  const directories = [path.join(globalRoot, '知识库'), path.join(globalRoot, '模板库')];
  const existingDirectories = await Promise.all(
    directories.map(async (directory) => ((await pathExists(directory)) ? directory : null)),
  );
  return existingDirectories.filter((directory): directory is string => directory !== null);
}

export function buildCodexEnv(codexHome: string): Record<string, string> {
  const cacheHome = path.join(codexHome, '.cache');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      CODEX_HOME: codexHome,
      XDG_CACHE_HOME: cacheHome,
      UV_CACHE_DIR: path.join(cacheHome, 'uv'),
      PIP_CACHE_DIR: path.join(cacheHome, 'pip'),
      NPM_CONFIG_CACHE: path.join(cacheHome, 'npm'),
      npm_config_cache: path.join(cacheHome, 'npm'),
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  env.CODEX_API_KEY = env.CODEX_API_KEY ?? env.OPENAI_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? '';
  return env;
}

export async function resolveCodexPathOverride(codexPathOverride?: string): Promise<string> {
  const configuredPath = codexPathOverride ?? process.env.CODEX_PATH;
  if (configuredPath) {
    return configuredPath;
  }

  const executable = await findExecutableOnPath('codex');
  if (!executable) {
    throw new Error('Codex CLI executable not found. Set CODEX_PATH or install codex on PATH.');
  }

  return executable;
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const pathEntry of pathEntries) {
    const candidate = path.join(pathEntry, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function appendRunDiagnostic(stage: string, data: Record<string, unknown>): void {
  appendJsonLog(RUN_DIAGNOSTIC_LOG, {
    scope: 'codex-run',
    stage,
    ...data,
  });
}

function textLogValue(text: string, limit = RUN_TEXT_LOG_LIMIT): { text: string; length: number; truncated: boolean } {
  return {
    text: text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]` : text,
    length: text.length,
    truncated: text.length > limit,
  };
}

async function summarizeCodexHome(codexHome: string): Promise<Record<string, unknown>> {
  try {
    const rootEntries = await readdir(codexHome, { withFileTypes: true });
    const skillRoot = path.join(codexHome, 'skills');
    const skillEntries = await safeReaddir(skillRoot);
    const skills = await Promise.all(
      skillEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const skillPath = path.join(skillRoot, entry.name, 'SKILL.md');
          try {
            const content = await readFile(skillPath, 'utf8');
            return {
              name: entry.name,
              hasSkillFile: true,
              hasYamlFrontmatter: content.trimStart().startsWith('---'),
              firstLine: content.split(/\r?\n/, 1)[0] ?? '',
            };
          } catch (error) {
            return {
              name: entry.name,
              hasSkillFile: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
    );

    return {
      path: codexHome,
      rootEntries: rootEntries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })),
      skills,
    };
  } catch (error) {
    return {
      path: codexHome,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function safeReaddir(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function summarizeThreadEvent(event: ThreadEvent): Record<string, unknown> {
  if (!event || typeof event !== 'object') {
    return { value: event };
  }

  const typedEvent = event as { item?: unknown; [key: string]: unknown };
  const { item, ...rest } = typedEvent;
  return {
    ...rest,
    ...(item ? { item: summarizeThreadItem(item) } : {}),
  };
}

function summarizeThreadItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const typedItem = item as { [key: string]: unknown };
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(typedItem)) {
    summary[key] = summarizeLogField(key, value);
  }
  return summary;
}

function summarizeStreamEvent(event: StreamEvent): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    summary[key] = summarizeLogField(key, value);
  }
  return summary;
}

function summarizeLogField(key: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  if (['text', 'delta', 'command', 'aggregated_output', 'outputText', 'errorMessage', 'message', 'query'].includes(key)) {
    return textLogValue(value);
  }

  return value;
}

function summarizeItemState(state: ItemState): Record<string, unknown> {
  return {
    textItemCount: state.textByItemId.size,
    thinkingItemCount: state.thinkingByItemId.size,
    toolInputItemCount: state.toolInputByItemId.size,
    toolOutputItemCount: state.toolOutputByItemId.size,
    toolStatusByItemId: Object.fromEntries(state.toolStatusByItemId.entries()),
    toolStartedCount: state.toolStarted.size,
    completedActionStatuses: state.completedActionStatuses,
    pendingRunEnd: state.pendingRunEnd,
    runEnded: state.runEnded,
    textSequence: state.textSequence,
    toolSequence: state.toolSequence,
    thinkingSequence: state.thinkingSequence,
    latestTextByItemId: Object.fromEntries([...state.textByItemId.entries()].map(([id, text]) => [id, textLogValue(text, 8_000)])),
    latestToolInputByItemId: Object.fromEntries([...state.toolInputByItemId.entries()].map(([id, text]) => [id, textLogValue(text, 8_000)])),
    latestToolOutputByItemId: Object.fromEntries([...state.toolOutputByItemId.entries()].map(([id, text]) => [id, textLogValue(text, 8_000)])),
  };
}

function handleCodexEvent(
  event: ThreadEvent,
  context: {
    emittedAt: () => string;
    publish: (event: StreamEvent) => void;
    runId: string;
    state: ItemState;
  },
): void {
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    handleCodexItem(event.item, event.type === 'item.completed', context);
    return;
  }

  if (event.type === 'thread.started') {
    context.publish({ type: 'thread.started', runId: context.runId, emittedAt: context.emittedAt(), threadId: event.thread_id });
    return;
  }

  if (event.type === 'turn.completed') {
    context.state.pendingRunEnd = { type: 'run.end', runId: context.runId, emittedAt: context.emittedAt(), status: 'success', errorMessage: null };
    return;
  }

  if (event.type === 'turn.failed') {
    context.state.pendingRunEnd = {
      type: 'run.end',
      runId: context.runId,
      emittedAt: context.emittedAt(),
      status: 'error',
      errorMessage: errorMessage(event.error.message),
    };
    return;
  }

  if (event.type === 'error') {
    context.state.pendingRunEnd = {
      type: 'run.end',
      runId: context.runId,
      emittedAt: context.emittedAt(),
      status: 'error',
      errorMessage: errorMessage(event.message),
    };
  }
}

function publishRunEnd(
  event: RunEndStreamEvent,
  state: ItemState,
  publish: (event: StreamEvent) => void,
): void {
  if (state.runEnded) return;
  state.runEnded = true;
  publish(event);
}

function recoverPostToolCompletionFailure(
  error: unknown,
  state: ItemState,
  context: {
    emittedAt: () => string;
    publish: (event: StreamEvent) => void;
    runId: string;
  },
): boolean {
  if (!isPostToolFinalResponseFailure(error, state)) {
    return false;
  }

  const fallbackText = state.textSequence === 0
    ? `操作已执行；Codex CLI 最终回复失败：${errorMessage(error)}`
    : `\n\n操作已执行；Codex CLI 最终回复失败：${errorMessage(error)}`;
  context.publish({
    type: 'text.delta',
    runId: context.runId,
    emittedAt: context.emittedAt(),
    delta: fallbackText,
    sequence: ++state.textSequence,
  });
  publishRunEnd({
    type: 'run.end',
    runId: context.runId,
    emittedAt: context.emittedAt(),
    status: 'success',
    errorMessage: null,
  }, state, context.publish);
  return true;
}

function isPostToolFinalResponseFailure(error: unknown, state: ItemState): boolean {
  const actionStatuses = state.completedActionStatuses.length > 0
    ? state.completedActionStatuses
    : [...state.toolStatusByItemId.values()];
  const hasSuccessfulAction = actionStatuses.some((status) => status === 'succeeded');
  const lastActionStatus = actionStatuses[actionStatuses.length - 1] ?? null;
  if (!hasSuccessfulAction || lastActionStatus !== 'succeeded') {
    return false;
  }

  const message = errorMessage(error);
  return /Codex Exec exited with code 1:\s*Reading prompt from stdin/i.test(message) ||
    /response\.failed|stream disconnected before completion|response\.completed|Reconnecting/i.test(message);
}

function handleCodexItem(
  item: ThreadItem,
  completed: boolean,
  context: {
    emittedAt: () => string;
    publish: (event: StreamEvent) => void;
    runId: string;
    state: ItemState;
  },
): void {
  if (!item || typeof item !== 'object' || !('type' in item) || !('id' in item)) return;
  const typedItem = item as { id: string; type: string; [key: string]: unknown };

  if (typedItem.type === 'agent_message' && typeof typedItem.text === 'string') {
    publishTextDelta(typedItem.id, typedItem.text, context);
    return;
  }

  if (typedItem.type === 'reasoning' && typeof typedItem.text === 'string') {
    publishThinking(typedItem.id, typedItem.text, completed, context);
    return;
  }

  if (typedItem.type === 'command_execution') {
    const command = typeof typedItem.command === 'string' ? typedItem.command : 'command';
    const output = typeof typedItem.aggregated_output === 'string' ? typedItem.aggregated_output : '';
    const exitCode = typeof typedItem.exit_code === 'number' ? typedItem.exit_code : null;
    const status = typedItem.status === 'failed' || (completed && exitCode !== null && exitCode !== 0) || (completed && isFailedCommandOutput(output))
      ? 'failed'
      : typedItem.status === 'completed'
        ? 'succeeded'
        : 'running';
    publishToolLifecycle(typedItem.id, 'command_execution', command, output, completed, status, context);
    return;
  }

  if (typedItem.type === 'mcp_tool_call') {
    const server = typeof typedItem.server === 'string' ? typedItem.server : 'mcp';
    const tool = typeof typedItem.tool === 'string' ? typedItem.tool : 'tool';
    const input = JSON.stringify(typedItem.arguments ?? {});
    const output = typedItem.error
      ? JSON.stringify(typedItem.error)
      : typedItem.result
        ? JSON.stringify(typedItem.result)
        : '';
    const status = typedItem.status === 'failed' ? 'failed' : typedItem.status === 'completed' ? 'succeeded' : 'running';
    publishToolLifecycle(typedItem.id, `${server}.${tool}`, input, output, completed, status, context);
    return;
  }

  if (typedItem.type === 'web_search') {
    const query = typeof typedItem.query === 'string' ? typedItem.query : '';
    publishToolLifecycle(typedItem.id, 'web_search', query, '', completed, completed ? 'succeeded' : 'running', context);
    return;
  }

  if (typedItem.type === 'file_change' && Array.isArray(typedItem.changes) && completed) {
    let publishedChange = false;
    for (const change of typedItem.changes) {
      if (!change || typeof change !== 'object') continue;
      const path = 'path' in change && typeof change.path === 'string' ? change.path : '';
      const kind = 'kind' in change && typeof change.kind === 'string' ? change.kind : 'update';
      if (!path) continue;
      publishedChange = true;
      context.publish({
        type: 'file.changed',
        runId: context.runId,
        emittedAt: context.emittedAt(),
        path,
        change: kind === 'add' ? 'created' : kind === 'delete' ? 'deleted' : 'modified',
      });
    }
    if (publishedChange) {
      context.state.completedActionStatuses.push('succeeded');
    }
    return;
  }

  if (typedItem.type === 'error' && typeof typedItem.message === 'string') {
    publishToolLifecycle(typedItem.id, 'error', '', typedItem.message, true, 'failed', context);
  }
}

function publishTextDelta(
  itemId: string,
  nextText: string,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  const previous = context.state.textByItemId.get(itemId) ?? '';
  const delta = nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText;
  context.state.textByItemId.set(itemId, nextText);
  publishAgentTraceEvents(nextText, context);
  if (!delta) return;
  context.publish({
    type: 'text.delta',
    runId: context.runId,
    emittedAt: context.emittedAt(),
    delta,
    sequence: ++context.state.textSequence,
  });
}

function publishAgentTraceEvents(
  text: string,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  for (const candidate of extractJsonCodeBlocks(text)) {
    const event = parseAgentTraceCandidate(candidate, context.runId, context.emittedAt());
    if (!event) continue;
    const key = agentTraceEventKey(event);
    if (context.state.agentTraceKeys.has(key)) continue;
    context.state.agentTraceKeys.add(key);
    context.publish(event);
  }
}

function agentTraceEventKey(event: StreamEvent): string {
  switch (event.type) {
    case 'agent.step.start':
      return `${event.type}:${event.agentId}:${event.phase}:${event.iteration}:${event.maxIterations ?? ''}`;
    case 'agent.step.end':
      return `${event.type}:${event.agentId}:${event.phase}:${event.iteration}:${event.maxIterations ?? ''}:${event.status}`;
    case 'agent.review.reject':
      return `${event.type}:${event.targetAgentId}:${event.iteration}:${event.maxIterations ?? ''}:${JSON.stringify(event.reasons)}`;
    case 'agent.workflow.end':
      return `${event.type}:${event.status}:${event.outputPath ?? ''}`;
    default:
      return JSON.stringify(event);
  }
}

function extractJsonCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencedBlockPattern = /```json\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencedBlockPattern)) {
    if (match[1]) blocks.push(match[1].trim());
  }
  return blocks;
}

function parseAgentTraceCandidate(candidate: string, runId: string, emittedAt: string): StreamEvent | null {
  try {
    const value = JSON.parse(candidate) as Partial<StreamEvent> & Record<string, unknown>;
    const maxIterations = parseOptionalPositiveInteger(value.maxIterations);
    if (value.type === 'agent.step.start') {
      if (typeof value.agentId !== 'string' || typeof value.phase !== 'string' || typeof value.iteration !== 'number') return null;
      return {
        type: 'agent.step.start',
        runId,
        emittedAt,
        agentId: value.agentId,
        phase: value.phase,
        iteration: value.iteration,
        ...(maxIterations ? { maxIterations } : {}),
      };
    }
    if (value.type === 'agent.step.end') {
      if (
        typeof value.agentId !== 'string' ||
        typeof value.phase !== 'string' ||
        typeof value.iteration !== 'number' ||
        !['passed', 'rejected', 'failed'].includes(String(value.status))
      ) return null;
      return {
        type: 'agent.step.end',
        runId,
        emittedAt,
        agentId: value.agentId,
        phase: value.phase,
        iteration: value.iteration,
        ...(maxIterations ? { maxIterations } : {}),
        status: value.status as 'passed' | 'rejected' | 'failed',
      };
    }
    if (value.type === 'agent.review.reject') {
      if (typeof value.targetAgentId !== 'string' || typeof value.iteration !== 'number' || !Array.isArray(value.reasons)) return null;
      return {
        type: 'agent.review.reject',
        runId,
        emittedAt,
        targetAgentId: value.targetAgentId,
        iteration: value.iteration,
        ...(maxIterations ? { maxIterations } : {}),
        reasons: value.reasons.filter((reason): reason is string => typeof reason === 'string'),
      };
    }
    if (value.type === 'agent.workflow.end') {
      if (!['passed', 'stopped'].includes(String(value.status))) return null;
      return {
        type: 'agent.workflow.end',
        runId,
        emittedAt,
        status: value.status as 'passed' | 'stopped',
        ...(typeof value.outputPath === 'string' ? { outputPath: value.outputPath } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function publishThinking(
  itemId: string,
  nextText: string,
  completed: boolean,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  const previous = context.state.thinkingByItemId.get(itemId);
  const sequence = previous?.sequence ?? ++context.state.thinkingSequence;
  const previousText = previous?.text ?? '';
  const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
  context.state.thinkingByItemId.set(itemId, { sequence, text: nextText });
  if (delta) {
    context.publish({ type: 'thinking.delta', runId: context.runId, emittedAt: context.emittedAt(), delta, sequence });
  }
  if (completed) {
    context.publish({ type: 'thinking.end', runId: context.runId, emittedAt: context.emittedAt(), text: nextText, sequence });
  }
}

function publishToolLifecycle(
  itemId: string,
  toolName: string,
  input: string,
  output: string,
  completed: boolean,
  status: 'running' | 'succeeded' | 'failed',
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  context.state.toolStatusByItemId.set(itemId, status);

  if (!context.state.toolStarted.has(itemId)) {
    context.state.toolStarted.add(itemId);
    context.publish({ type: 'tool_use.start', runId: context.runId, emittedAt: context.emittedAt(), toolCallId: itemId, toolName });
  }

  publishToolDelta(itemId, 'input', input, context);
  publishToolDelta(itemId, 'output', output, context);

  if (completed) {
    context.state.completedActionStatuses.push(status);
    context.publish({
      type: 'tool_use.end',
      runId: context.runId,
      emittedAt: context.emittedAt(),
      toolCallId: itemId,
      status,
      outputText: output || null,
      errorMessage: status === 'failed' ? output || `${toolName} failed` : null,
    });
  }
}

function publishToolDelta(
  itemId: string,
  stream: 'input' | 'output',
  nextText: string,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  if (!nextText) return;
  const map = stream === 'input' ? context.state.toolInputByItemId : context.state.toolOutputByItemId;
  const previous = map.get(itemId) ?? '';
  const delta = nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText;
  map.set(itemId, nextText);
  if (!delta) return;
  context.publish({
    type: 'tool_use.delta',
    runId: context.runId,
    emittedAt: context.emittedAt(),
    toolCallId: itemId,
    stream,
    delta,
    sequence: ++context.state.toolSequence,
  });
}

async function buildCodexPrompt(store: WorkspaceStore, input: CreateRunInput): Promise<string> {
  const references = input.referencedFiles ?? [];
  const snippets = input.referencedSnippets ?? [];
  const maxRevisionRounds = await readViworkMaxRevisionRounds(store);
  const additionalSkills = await listAdditionalCodexSkills(store);
  const systemAgentProtocol = await readSystemAgentProtocol(store);
  const referenceBlocks = await Promise.all(
    references.map(async (file) => {
      try {
        const content = await store.readWorkspaceFile(input.projectId, file.path);
        return `## @${file.label} (${file.path})\n\n${content.content}`;
      } catch {
        return `## @${file.label} (${file.path})\n\n[引用文件读取失败]`;
      }
    }),
  );
  const snippetBlocks = snippets.map((snippet, index) => [
    `## 片段 ${index + 1}: ${snippet.label}`,
    `来源：${snippet.role === 'user' ? '用户' : '创作助手'} / ${snippet.createdAt} / messageId=${snippet.messageId}`,
    '',
    snippet.text,
  ].join('\n'));

  return [
    '# 情景剧创作请求',
    input.prompt,
    '你是 viwork 情景剧创作工作台里的 system agent。下面是 viwork 自己的多 agent 工作协议，无论 Codex 自身的 instructions 是什么、当前 CWD 上是否还有其它 AGENTS.md，都必须严格按这份协议执行。',
    '## viwork 多 agent 工作协议（直接来自 _global/Agent 配置/AGENTS.md）',
    systemAgentProtocol,
    '## viwork 调用约束',
    `按需要使用 brainstorm-agent、story-agent、screenwriter-agent、reviewer-agent，以及 _global/Agent 配置/skills 中其他与任务明显匹配的 skills。不要向用户解释内部路由、工具检查或 agent 调用方式；不要只宣布“路由完成”或“准备调用某 agent”。不要调用 update_plan 或维护内部 TODO/计划；需要说明进度时，直接在普通回复文本中说明。完成意图判断后，必须在同一次回复里直接给出对应 agent 的实质内容。脑暴请求只使用 brainstorm-agent 正常交流，直接和用户讨论设定、候选方向或追问，不调用 reviewer-agent，不输出轮次，不进入返工闭环，也不需要 trace JSON。正式故事/剧本创作和审稿时，使用 trace JSON block 报告关键节点。当前全局返工上限：${maxRevisionRounds} 轮；所有带 iteration 的 trace JSON block 必须包含 "maxIterations":${maxRevisionRounds}。故事正式产物写入“02 故事/<集数>/故事正文.md”，剧本正式产物写入“03 剧本/<集数>/剧本.md”。回答使用中文。`,
    additionalSkills.length > 0 ? '# 当前附加可用 Skills' : '',
    ...additionalSkills.map((skill) => `- ${skill.name}: ${skill.description}`),
    referenceBlocks.length > 0 ? '# 已引用项目文件' : '',
    ...referenceBlocks,
    snippetBlocks.length > 0 ? '# 已引用聊天片段' : '',
    ...snippetBlocks,
  ].filter(Boolean).join('\n\n');
}

async function readSystemAgentProtocol(store: WorkspaceStore): Promise<string> {
  try {
    const file = await store.readGlobalWorkspaceFile('Agent 配置/AGENTS.md');
    return file.content.trim();
  } catch {
    return '（viwork system agent 协议文件缺失，请检查 _global/Agent 配置/AGENTS.md。）';
  }
}

async function listAdditionalCodexSkills(store: WorkspaceStore) {
  const skillsRoot = path.join(store.getGlobalRoot(), 'Agent 配置', 'skills');
  const skills = await listAgentConfigSkillDefinitions(skillsRoot);
  return skills.filter((skill) => !isDefaultAgentSkill(skill.name));
}

async function readViworkMaxRevisionRounds(store: WorkspaceStore): Promise<number> {
  try {
    const config = await store.readGlobalWorkspaceFile('Agent 配置/config.toml');
    return parseViworkMaxRevisionRounds(config.content);
  } catch {
    return 5;
  }
}

function parseViworkMaxRevisionRounds(content: string): number {
  const sectionMatch = content.match(/(?:^|\n)\s*\[viwork\][\s\S]*?(?=\n\s*\[[^\]]+\]|\s*$)/);
  const section = sectionMatch?.[0] ?? '';
  const valueMatch = section.match(/^\s*max_revision_rounds\s*=\s*(\d+)\s*(?:#.*)?$/m);
  const value = Number(valueMatch?.[1]);
  return Number.isInteger(value) && value > 0 ? value : 5;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function cliRunErrorMessage(error: unknown, state: ItemState): string {
  const failedToolOutputs = [...state.toolStatusByItemId.entries()]
    .filter(([, status]) => status === 'failed')
    .map(([itemId]) => state.toolOutputByItemId.get(itemId) ?? '')
    .filter(Boolean);
  const cliMessage = errorMessage(error) || 'Codex run failed';
  const pendingTurnError = state.pendingRunEnd?.errorMessage?.trim();
  // The Codex CLI's stderr is often just the `Reading ... from stdin...` startup line
  // and contains no actionable cause. When that is all we got from the CLI, fall back
  // to the upstream `turn.failed`/`error` event which usually carries the real reason
  // (for example an HTTP 401 from the configured model provider).
  const cliStderrIsGeneric = /Codex Exec exited with code \d+: Reading (?:prompt|additional input) from stdin\.\.\.\s*$/i.test(cliMessage);

  if (failedToolOutputs.length === 0) {
    return pendingTurnError && cliStderrIsGeneric ? pendingTurnError : cliMessage;
  }

  return [
    '本轮工具调用失败，Codex CLI 未生成最终回复。会话线程未删除，可以继续发送消息。',
    '工具执行失败：',
    ...failedToolOutputs,
    pendingTurnError ? 'Codex turn 错误：' : '',
    pendingTurnError ?? '',
    'Codex CLI 退出信息：',
    cliMessage,
  ].filter(Boolean).join('\n');
}

function isFailedCommandOutput(output: string): boolean {
  return /can't find file to patch|Skipping patch|hunk ignored|No such file or directory|Permission denied|command not found/i.test(output);
}
