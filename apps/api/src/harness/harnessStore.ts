import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentLayerConfig,
  AgentSpecReleaseAuditCategory,
  AgentSpecReleaseForceReason,
  AgentSpecReleaseGate,
  AgentSpecReleaseRecord,
  AgentSpec,
  EvalFixture,
  EvalRun,
  EvalAssertionResult,
  HarnessSummary,
  HarnessVersionDiff,
  HumanReview,
  HumanReviewRubric,
  KnowledgeBaseEntry,
  MemoryPolicy,
  MemoryRecord,
  PromptBlock,
  ReferencedChatSnippet,
  ReferencedFile,
  RetrievalPolicy,
  RunArtifact,
  RunInputSnapshot,
  RunInputSnapshotFile,
  SkillSnapshot,
  WorkspaceManifest,
} from '@viforge/shared';
import { PRODUCT_PROFILES, resolveProductProfile, type ProductProfile } from '@viforge/shared';

import type { GitService } from '../storage/gitService';
import type { WorkspaceStore } from '../storage/workspaceStore';
import { readProductSkillPrompt, readProductSystemAgentPrompt } from '../productProfilePrompts';

type HarnessState = {
  agentLayerConfigs: AgentLayerConfig[];
  agentSpecs: AgentSpec[];
  memoryPolicies: MemoryPolicy[];
  knowledgeBaseEntries: KnowledgeBaseEntry[];
  retrievalPolicies: RetrievalPolicy[];
  promptBlocks: PromptBlock[];
  skillSnapshots: SkillSnapshot[];
  workspaceManifests: WorkspaceManifest[];
  runArtifacts: RunArtifact[];
  snapshots: RunInputSnapshot[];
  evalFixtures: EvalFixture[];
  evalRuns: EvalRun[];
  humanReviewRubrics: HumanReviewRubric[];
  releaseRecords: AgentSpecReleaseRecord[];
};

export type CreateRunInputSnapshotInput = {
  runId: string;
  projectId: string;
  sessionId?: string;
  prompt?: string;
  productId?: string;
  referencedFiles?: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
};

export type CreateEvalFixtureFromSnapshotInput = {
  snapshotId: string;
  name?: string;
  target: string;
  inputMessages?: EvalFixture['inputMessages'];
  memoryFixture?: MemoryRecord[];
  knowledgeFixture?: KnowledgeBaseEntry[];
  toolMocks?: Record<string, unknown>;
  assertions?: Record<string, unknown>;
  tags?: string[];
};

export type UpdateEvalFixtureInput = Partial<Pick<EvalFixture,
  'name' | 'target' | 'inputMessages' | 'referencedSnippets' | 'memoryFixture' | 'knowledgeFixture' | 'expectedChangedFiles' | 'expectedToolEvents' | 'toolRetentionPolicy' | 'sensitiveFieldRules' | 'toolRetentionArtifacts' | 'toolMocks' | 'assertions' | 'tags'
>>;

export type CreateEvalRunInput = {
  fixtureId: string;
  agentSpecId: string;
  runMode?: EvalRun['runMode'];
};

export type CreateHumanReviewInput = Omit<HumanReview, 'evalRunId' | 'createdAt'>;

export type BatchHumanReviewInput = CreateHumanReviewInput & {
  evalRunIds: string[];
};

export type ListReleaseRecordsFilter = {
  productId?: string;
  agentId?: string;
  action?: AgentSpecReleaseRecord['action'];
  auditCategory?: AgentSpecReleaseAuditCategory;
  force?: boolean;
  limit?: number;
};

export type EvalRunExecutorInput = {
  evalRunId: string;
  workspaceRoot: string;
  fixture: EvalFixture;
  agentSpec: AgentSpec;
  model?: string;
  modelParams?: RunArtifact['modelParams'];
  resolvedAgentConfig: EvalRun['resolvedAgentConfig'];
  runMode: EvalRun['runMode'];
  onEvent?: (event: EvalRun['toolEvents'][number]) => void;
};

export type EvalRunExecutorResult = {
  outputMessage?: string;
  toolEvents?: EvalRun['toolEvents'];
  status?: Extract<EvalRun['status'], 'passed' | 'failed' | 'error'>;
  executionMode?: NonNullable<EvalRun['executionMode']>;
  errorMessage?: string;
};

type TextSnapshotByPath = Map<string, string | null>;

type PendingEvalRunExecution = {
  evalRunId: string;
  runWorkspaceRoot: string;
  fixture: EvalFixture;
  agentSpec: AgentSpec;
  model?: string;
  modelParams?: RunArtifact['modelParams'];
  beforeManifest: RunInputSnapshotFile[];
  beforeTextSnapshot: TextSnapshotByPath;
  resolvedAgentConfig: EvalRun['resolvedAgentConfig'];
  runMode: EvalRun['runMode'];
};

export type RecordRunArtifactEventInput = {
  runId: string;
  projectId: string;
  sessionId?: string;
  productId?: string;
  inputSnapshotId?: string;
  traceId?: string;
  model?: string;
  modelParams?: RunArtifact['modelParams'];
  prompt: string;
  referencedFiles?: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  event: RunArtifact['streamEvents'][number];
};

export type HarnessStore = {
  getSummary(): Promise<HarnessSummary>;
  listAgentLayerConfigs(): Promise<AgentLayerConfig[]>;
  createAgentLayerConfig(input: Omit<AgentLayerConfig, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { version?: number }): Promise<AgentLayerConfig>;
  listAgentSpecs(): Promise<AgentSpec[]>;
  createAgentSpec(input: Omit<AgentSpec, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'activatedAt'> & { version?: number }): Promise<AgentSpec>;
  getAgentSpecReleaseGate(agentSpecId: string): Promise<AgentSpecReleaseGate>;
  listMemoryPolicies(): Promise<MemoryPolicy[]>;
  createMemoryPolicy(input: Omit<MemoryPolicy, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { version?: number }): Promise<MemoryPolicy>;
  listKnowledgeBaseEntries(): Promise<KnowledgeBaseEntry[]>;
  upsertKnowledgeBaseEntry(input: Omit<KnowledgeBaseEntry, 'updatedAt'> & { updatedAt?: string }): Promise<KnowledgeBaseEntry>;
  listRetrievalPolicies(): Promise<RetrievalPolicy[]>;
  createRetrievalPolicy(input: Omit<RetrievalPolicy, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { version?: number }): Promise<RetrievalPolicy>;
  listPromptBlocks(): Promise<PromptBlock[]>;
  createPromptBlock(input: Omit<PromptBlock, 'id' | 'version' | 'contentHash' | 'createdAt' | 'updatedAt'> & { id?: string; version?: number }): Promise<PromptBlock>;
  createPromptBlockVersion(promptBlockId: string, input: Partial<Pick<PromptBlock, 'title' | 'scope' | 'content' | 'status'>>): Promise<PromptBlock>;
  getPromptBlockDiff(promptBlockId: string, fromVersion?: number, toVersion?: number): Promise<HarnessVersionDiff>;
  updatePromptBlockStatus(promptBlockId: string, version: number, status: PromptBlock['status']): Promise<PromptBlock>;
  listSkillSnapshots(): Promise<SkillSnapshot[]>;
  createSkillSnapshot(input: Omit<SkillSnapshot, 'id' | 'version' | 'contentHash' | 'createdAt' | 'updatedAt'> & { id?: string; version?: number }): Promise<SkillSnapshot>;
  createSkillSnapshotVersion(skillSnapshotId: string, input: Partial<Pick<SkillSnapshot, 'content' | 'status' | 'source'>>): Promise<SkillSnapshot>;
  getSkillSnapshotDiff(skillSnapshotId: string, fromVersion?: number, toVersion?: number): Promise<HarnessVersionDiff>;
  updateSkillSnapshotStatus(skillSnapshotId: string, version: number, status: SkillSnapshot['status']): Promise<SkillSnapshot>;
  listWorkspaceManifests(): Promise<WorkspaceManifest[]>;
  createWorkspaceManifest(input: Omit<WorkspaceManifest, 'id' | 'createdAt' | 'updatedAt'>): Promise<WorkspaceManifest>;
  listRunArtifacts(): Promise<RunArtifact[]>;
  getRunArtifact(runId: string): Promise<RunArtifact | undefined>;
  recordRunArtifactEvent(input: RecordRunArtifactEventInput): Promise<void>;
  listRunInputSnapshots(): Promise<RunInputSnapshot[]>;
  createRunInputSnapshot(input: CreateRunInputSnapshotInput): Promise<RunInputSnapshot>;
  getRunInputSnapshot(snapshotId: string): Promise<RunInputSnapshot | undefined>;
  listEvalFixtures(): Promise<EvalFixture[]>;
  createEvalFixtureFromSnapshot(input: CreateEvalFixtureFromSnapshotInput): Promise<EvalFixture>;
  createEvalFixtureFromRunArtifact(runId: string, input: Omit<CreateEvalFixtureFromSnapshotInput, 'snapshotId'> & { snapshotId?: string }): Promise<EvalFixture>;
  updateEvalFixture(fixtureId: string, input: UpdateEvalFixtureInput): Promise<EvalFixture>;
  listEvalRuns(): Promise<EvalRun[]>;
  createEvalRun(input: CreateEvalRunInput): Promise<EvalRun>;
  completeEvalRun(evalRunId: string, outputMessage?: string): Promise<EvalRun>;
  addHumanReview(evalRunId: string, input: CreateHumanReviewInput): Promise<EvalRun>;
  addBatchHumanReview(input: BatchHumanReviewInput): Promise<EvalRun[]>;
  updateAgentSpecStatus(agentSpecId: string, status: AgentSpec['status'], options?: { force?: boolean; forceReason?: AgentSpecReleaseForceReason; auditCategory?: AgentSpecReleaseAuditCategory; reviewer?: string; notes?: string }): Promise<AgentSpec>;
  deleteAgentSpec(agentSpecId: string): Promise<{ deleted: true }>;
  rollbackAgentSpec(agentSpecId: string, options?: { forceReason?: AgentSpecReleaseForceReason; auditCategory?: AgentSpecReleaseAuditCategory; reviewer?: string; notes?: string; sourceReleaseRecordId?: string }): Promise<AgentSpec>;
  listReleaseRecords(filter?: ListReleaseRecordsFilter): Promise<AgentSpecReleaseRecord[]>;
  listHumanReviewRubrics(): Promise<HumanReviewRubric[]>;
};

const STATE_FILE = 'harness.json';
const SNAPSHOTS_DIR = 'snapshots';
const FIXTURES_DIR = 'eval-fixtures';
const EVAL_RUNS_DIR = 'eval-runs';

const SNAPSHOT_EXCLUDE_RULES = [
  '.git/**',
  'node_modules/**',
  'dist/**',
  '*.tsbuildinfo',
  '.DS_Store',
  '.codex-home/**',
  'logs/**',
];

export function createHarnessStore(
  root: string,
  workspaceStore: WorkspaceStore,
  options: { gitService?: GitService; evalRunExecutor?: (input: EvalRunExecutorInput) => Promise<EvalRunExecutorResult>; asyncEvalRuns?: boolean } = {},
): HarnessStore {
  const harnessRoot = path.resolve(root);
  const statePath = path.join(harnessRoot, STATE_FILE);
  let writeQueue = Promise.resolve();

  async function ensureRoot(): Promise<void> {
    await mkdir(harnessRoot, { recursive: true });
  }

  async function readState(): Promise<HarnessState> {
    await ensureRoot();
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<HarnessState>;
      return seedProductProfileBaselines(await normalizeState(parsed));
    } catch (error) {
      if (isNotFoundError(error)) return seedProductProfileBaselines(await normalizeState({}));
      throw error;
    }
  }

  async function writeStateUnqueued(state: HarnessState): Promise<void> {
    await ensureRoot();
    const tempPath = `${statePath}.tmp-${randomUUID()}`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(tempPath, statePath);
  }

  async function writeState(state: HarnessState): Promise<void> {
    const operation = writeQueue.then(() => writeStateUnqueued(state));
    writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async function updateState<T>(update: (state: HarnessState) => Promise<T> | T): Promise<T> {
    const operation = writeQueue.then(async () => {
      const state = await readState();
      const result = await update(state);
      await writeStateUnqueued(state);
      return result;
    });
    writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function executeEvalRunAndUpdate(input: PendingEvalRunExecution): Promise<void> {
    const progressEvents: EvalRun['toolEvents'] = [];
    let persistedProgressEvents = 0;
    let lastProgressPersistedAt = 0;
    const persistProgress = (force = false): void => {
      if (progressEvents.length <= persistedProgressEvents) return;
      const now = Date.now();
      const shouldPersist = force || progressEvents.length - persistedProgressEvents >= 25 || now - lastProgressPersistedAt >= 1_000;
      if (!shouldPersist) return;
      const eventsToAppend = progressEvents.slice(persistedProgressEvents);
      persistedProgressEvents = progressEvents.length;
      lastProgressPersistedAt = now;
      void updateState((nextState) => {
        const evalRun = nextState.evalRuns.find((item) => item.id === input.evalRunId);
        if (!evalRun || evalRun.status !== 'running') return undefined;
        evalRun.toolEvents = [...evalRun.toolEvents, ...eventsToAppend];
        evalRun.outputMessage = summarizeEvalRunProgress(evalRun.toolEvents);
        return evalRun;
      });
    };
    try {
      const executorResult = options.evalRunExecutor
        ? await executeCustomEvalRun(options.evalRunExecutor, {
            evalRunId: input.evalRunId,
            workspaceRoot: input.runWorkspaceRoot,
            fixture: input.fixture,
            agentSpec: input.agentSpec,
            model: input.model,
            modelParams: input.modelParams,
            resolvedAgentConfig: input.resolvedAgentConfig,
            runMode: input.runMode,
            onEvent: (event) => {
              progressEvents.push(event);
              persistProgress();
            },
          })
        : await replayFixtureExpectations(input.runWorkspaceRoot, input.fixture);
      persistProgress(true);
      const toolEvents = executorResult.toolEvents ?? [];
      const afterManifest = await buildFileManifest(input.runWorkspaceRoot);
      const fileDiff = diffFileManifests(input.beforeManifest, afterManifest);
      const changedFiles = await captureEvalRunChangedFiles(input.runWorkspaceRoot, fileDiff);
      const state = await readState();
      const assertionResults = await evaluateAssertions(
        input.runWorkspaceRoot,
        input.beforeManifest,
        afterManifest,
        input.fixture.assertions,
        toolEvents,
        input.fixture.productId,
        state.workspaceManifests,
        input.beforeTextSnapshot,
      );
      const assertionStatus = assertionResults.every((result) => result.passed) ? 'passed' : 'failed';
      const status = executorResult.status === 'error' ? 'error' : assertionStatus;
      await updateState((nextState) => {
        const evalRun = nextState.evalRuns.find((item) => item.id === input.evalRunId);
        if (!evalRun) throw new Error('Eval run not found');
        evalRun.executionMode = executorResult.executionMode ?? (options.evalRunExecutor ? 'custom_executor' : 'fixture_replay');
        evalRun.status = status;
        evalRun.endedAt = new Date().toISOString();
        evalRun.outputMessage = executorResult.outputMessage ?? `EvalRun executed in isolated workspace ${normalizePath(path.relative(harnessRoot, input.runWorkspaceRoot))}.`;
        evalRun.errorMessage = executorResult.errorMessage;
        evalRun.toolEvents = toolEvents;
        evalRun.fileDiff = fileDiff;
        evalRun.changedFiles = changedFiles;
        evalRun.assertionResults = assertionResults;
        return evalRun;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateState((nextState) => {
        const evalRun = nextState.evalRuns.find((item) => item.id === input.evalRunId);
        if (!evalRun) return undefined;
        evalRun.status = 'error';
        evalRun.endedAt = new Date().toISOString();
        evalRun.errorMessage = message;
        evalRun.outputMessage = `EvalRun failed: ${message}`;
        return evalRun;
      });
    }
  }

  return {
    async getSummary() {
      return readState();
    },

    async listAgentLayerConfigs() {
      return (await readState()).agentLayerConfigs;
    },

    async createAgentLayerConfig(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.agentLayerConfigs
          .filter((config) => config.productId === input.productId)
          .map((config) => config.version));
        const config: AgentLayerConfig = {
          ...input,
          id: `agent_layer_${randomUUID()}`,
          version: input.version ?? latestVersion + 1,
          createdAt: now,
          updatedAt: now,
        };
        state.agentLayerConfigs.push(config);
        return config;
      });
    },

    async listAgentSpecs() {
      return (await readState()).agentSpecs;
    },

    async getAgentSpecReleaseGate(agentSpecId) {
      const state = await readState();
      const spec = state.agentSpecs.find((item) => item.id === agentSpecId);
      if (!spec) throw new Error('Agent spec not found');
      return evaluateReleaseGate(state, spec);
    },

    async createAgentSpec(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.agentSpecs
          .filter((spec) => spec.productId === input.productId && spec.agentId === input.agentId)
          .map((spec) => spec.version));
        const spec: AgentSpec = {
          ...input,
          id: `agent_spec_${randomUUID()}`,
          version: input.version ?? latestVersion + 1,
          createdAt: now,
          updatedAt: now,
          activatedAt: input.status === 'active' ? now : null,
        };
        if (spec.status === 'active') {
          for (const item of state.agentSpecs) {
            if (item.productId === spec.productId && item.agentId === spec.agentId && item.status === 'active') {
              item.status = 'archived';
              item.updatedAt = now;
            }
          }
        }
        state.agentSpecs.push(spec);
        return spec;
      });
    },

    async updateAgentSpecStatus(agentSpecId, status, statusOptions = {}) {
      return updateState((state) => {
        const spec = state.agentSpecs.find((item) => item.id === agentSpecId);
        if (!spec) throw new Error('Agent spec not found');
        const now = new Date().toISOString();
        if (status === 'active') {
          const gate = evaluateReleaseGate(state, spec);
          if (!statusOptions.force && !gate.passed) throw new Error(gate.reason);
          const previousActiveSpec = state.agentSpecs.find((item) => item.productId === spec.productId && item.agentId === spec.agentId && item.status === 'active');
          for (const item of state.agentSpecs) {
            if (item.productId === spec.productId && item.agentId === spec.agentId && item.status === 'active') {
              item.status = 'archived';
              item.updatedAt = now;
            }
          }
          spec.activatedAt = now;
          state.releaseRecords.push({
            id: `agent_release_${randomUUID()}`,
            agentSpecId: spec.id,
            productId: spec.productId,
            agentId: spec.agentId,
            action: 'activate',
            previousActiveSpecId: previousActiveSpec?.id,
            targetSpecId: spec.id,
            evalRunIds: gate.evalRunIds,
            force: statusOptions.force === true,
            forceReason: statusOptions.force ? (statusOptions.forceReason ?? 'manual_override') : undefined,
            auditCategory: statusOptions.force ? (statusOptions.auditCategory ?? auditCategoryForForceReason(statusOptions.forceReason ?? 'manual_override')) : undefined,
            gate,
            reviewer: statusOptions.reviewer,
            notes: statusOptions.notes,
            createdAt: now,
          });
        }
        spec.status = status;
        spec.updatedAt = now;
        return spec;
      });
    },

    async deleteAgentSpec(agentSpecId) {
      return updateState((state) => {
        const spec = state.agentSpecs.find((item) => item.id === agentSpecId);
        if (!spec) throw new Error('Agent spec not found');
        const hasRuns = state.evalRuns.some((run) => run.agentSpecId === agentSpecId);
        const hasRelease = state.releaseRecords.some((record) => record.agentSpecId === agentSpecId || record.targetSpecId === agentSpecId || record.previousActiveSpecId === agentSpecId);
        if (hasRuns || hasRelease) {
          throw new Error('Only unused AgentSpec drafts can be deleted');
        }
        state.agentSpecs = state.agentSpecs.filter((item) => item.id !== agentSpecId);
        return { deleted: true as const };
      });
    },

    async rollbackAgentSpec(agentSpecId, rollbackOptions = {}) {
      return updateState((state) => {
        const sourceReleaseRecord = rollbackOptions.sourceReleaseRecordId
          ? state.releaseRecords.find((record) => record.id === rollbackOptions.sourceReleaseRecordId)
          : undefined;
        const targetSpecId = sourceReleaseRecord?.previousActiveSpecId ?? agentSpecId;
        const target = state.agentSpecs.find((item) => item.id === targetSpecId);
        if (!target) throw new Error('Agent spec not found');
        const now = new Date().toISOString();
        const previousActiveSpec = state.agentSpecs.find((item) => item.productId === target.productId && item.agentId === target.agentId && item.status === 'active');
        for (const item of state.agentSpecs) {
          if (item.productId === target.productId && item.agentId === target.agentId && item.status === 'active') {
            item.status = 'archived';
            item.updatedAt = now;
          }
        }
        target.status = 'active';
        target.activatedAt = now;
        target.updatedAt = now;
        state.releaseRecords.push({
          id: `agent_release_${randomUUID()}`,
          agentSpecId: target.id,
          productId: target.productId,
          agentId: target.agentId,
          action: 'rollback',
          previousActiveSpecId: previousActiveSpec?.id,
          targetSpecId: target.id,
          evalRunIds: [],
          force: true,
          forceReason: rollbackOptions.forceReason ?? 'rollback',
          auditCategory: rollbackOptions.auditCategory ?? auditCategoryForForceReason(rollbackOptions.forceReason ?? 'rollback'),
          sourceReleaseRecordId: rollbackOptions.sourceReleaseRecordId,
          gate: evaluateReleaseGate(state, target),
          reviewer: rollbackOptions.reviewer,
          notes: rollbackOptions.notes,
          createdAt: now,
        });
        return target;
      });
    },

    async listMemoryPolicies() {
      return (await readState()).memoryPolicies;
    },

    async createMemoryPolicy(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.memoryPolicies
          .filter((policy) => policy.productId === input.productId)
          .map((policy) => policy.version));
        const policy: MemoryPolicy = {
          ...input,
          id: `memory_policy_${randomUUID()}`,
          version: input.version ?? latestVersion + 1,
          createdAt: now,
          updatedAt: now,
        };
        state.memoryPolicies.push(policy);
        return policy;
      });
    },

    async listKnowledgeBaseEntries() {
      return (await readState()).knowledgeBaseEntries;
    },

    async upsertKnowledgeBaseEntry(input) {
      return updateState(async (state) => {
        const now = new Date().toISOString();
        const entry: KnowledgeBaseEntry = { ...input, updatedAt: input.updatedAt ?? now };
        const existingIndex = state.knowledgeBaseEntries.findIndex((item) => item.id === entry.id);
        if (existingIndex >= 0) {
          state.knowledgeBaseEntries[existingIndex] = entry;
        } else {
          state.knowledgeBaseEntries.push(entry);
        }
        await syncKnowledgeIndex(workspaceStore, state.knowledgeBaseEntries);
        await ensureKnowledgeCard(workspaceStore, entry);
        return entry;
      });
    },

    async listRetrievalPolicies() {
      return (await readState()).retrievalPolicies;
    },

    async createRetrievalPolicy(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.retrievalPolicies
          .filter((policy) => policy.productId === input.productId)
          .map((policy) => policy.version));
        const policy: RetrievalPolicy = {
          ...input,
          id: `retrieval_policy_${randomUUID()}`,
          version: input.version ?? latestVersion + 1,
          createdAt: now,
          updatedAt: now,
        };
        state.retrievalPolicies.push(policy);
        return policy;
      });
    },

    async listPromptBlocks() {
      return (await readState()).promptBlocks;
    },

    async createPromptBlock(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.promptBlocks
          .filter((block) => block.productId === input.productId && block.id === input.id)
          .map((block) => block.version));
        const block: PromptBlock = {
          ...input,
          id: input.id || `prompt_block_${randomUUID()}`,
          version: input.version ?? latestVersion + 1,
          contentHash: sha256(input.content),
          createdAt: now,
          updatedAt: now,
        };
        state.promptBlocks.push(block);
        return block;
      });
    },

    async createPromptBlockVersion(promptBlockId, input) {
      return updateState((state) => {
        const previous = state.promptBlocks.find((block) => block.id === promptBlockId);
        if (!previous) throw new Error('Prompt block not found');
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.promptBlocks
          .filter((block) => block.productId === previous.productId && block.id === previous.id)
          .map((block) => block.version));
        const block: PromptBlock = {
          ...previous,
          title: input.title ?? previous.title,
          scope: input.scope ?? previous.scope,
          content: input.content ?? previous.content,
          status: input.status ?? 'draft',
          version: latestVersion + 1,
          contentHash: sha256(input.content ?? previous.content),
          createdAt: now,
          updatedAt: now,
        };
        state.promptBlocks.push(block);
        return block;
      });
    },

    async getPromptBlockDiff(promptBlockId, fromVersion, toVersion) {
      const state = await readState();
      const versions = state.promptBlocks
        .filter((block) => block.id === promptBlockId)
        .sort((a, b) => a.version - b.version);
      const selected = selectVersionPair(versions, fromVersion, toVersion, 'Prompt block not found');
      return buildVersionDiff('prompt_block', selected.previous.id, selected.previous, selected.next, selected.previous.content, selected.next.content);
    },

    async updatePromptBlockStatus(promptBlockId, version, status) {
      return updateState((state) => {
        const block = state.promptBlocks.find((item) => item.id === promptBlockId && item.version === version);
        if (!block) throw new Error('Prompt block not found');
        const now = new Date().toISOString();
        if (status === 'active') {
          for (const item of state.promptBlocks) {
            if (item.productId === block.productId && item.id === block.id && item.status === 'active' && item.version !== block.version) {
              item.status = 'archived';
              item.updatedAt = now;
            }
          }
        }
        block.status = status;
        block.updatedAt = now;
        return block;
      });
    },

    async listSkillSnapshots() {
      return (await readState()).skillSnapshots;
    },

    async createSkillSnapshot(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.skillSnapshots
          .filter((snapshot) => snapshot.productId === input.productId && snapshot.skillId === input.skillId)
          .map((snapshot) => snapshot.version));
        const snapshot: SkillSnapshot = {
          ...input,
          id: input.id || `skill_snapshot_${randomUUID()}`,
          version: input.version ?? latestVersion + 1,
          contentHash: sha256(input.content),
          createdAt: now,
          updatedAt: now,
        };
        state.skillSnapshots.push(snapshot);
        return snapshot;
      });
    },

    async createSkillSnapshotVersion(skillSnapshotId, input) {
      return updateState((state) => {
        const previous = state.skillSnapshots.find((snapshot) => snapshot.id === skillSnapshotId);
        if (!previous) throw new Error('Skill snapshot not found');
        const now = new Date().toISOString();
        const latestVersion = Math.max(0, ...state.skillSnapshots
          .filter((snapshot) => snapshot.productId === previous.productId && snapshot.skillId === previous.skillId)
          .map((snapshot) => snapshot.version));
        const snapshot: SkillSnapshot = {
          ...previous,
          content: input.content ?? previous.content,
          status: input.status ?? 'draft',
          source: input.source ?? previous.source,
          version: latestVersion + 1,
          contentHash: sha256(input.content ?? previous.content),
          createdAt: now,
          updatedAt: now,
        };
        state.skillSnapshots.push(snapshot);
        return snapshot;
      });
    },

    async getSkillSnapshotDiff(skillSnapshotId, fromVersion, toVersion) {
      const state = await readState();
      const versions = state.skillSnapshots
        .filter((snapshot) => snapshot.id === skillSnapshotId)
        .sort((a, b) => a.version - b.version);
      const selected = selectVersionPair(versions, fromVersion, toVersion, 'Skill snapshot not found');
      return buildVersionDiff('skill_snapshot', selected.previous.id, selected.previous, selected.next, selected.previous.content, selected.next.content);
    },

    async updateSkillSnapshotStatus(skillSnapshotId, version, status) {
      return updateState((state) => {
        const snapshot = state.skillSnapshots.find((item) => item.id === skillSnapshotId && item.version === version);
        if (!snapshot) throw new Error('Skill snapshot not found');
        const now = new Date().toISOString();
        if (status === 'active') {
          for (const item of state.skillSnapshots) {
            if (item.productId === snapshot.productId && item.skillId === snapshot.skillId && item.status === 'active' && item.version !== snapshot.version) {
              item.status = 'archived';
              item.updatedAt = now;
            }
          }
        }
        snapshot.status = status;
        snapshot.updatedAt = now;
        return snapshot;
      });
    },

    async listWorkspaceManifests() {
      return (await readState()).workspaceManifests;
    },

    async createWorkspaceManifest(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const manifest: WorkspaceManifest = {
          ...input,
          id: `workspace_manifest_${randomUUID()}`,
          createdAt: now,
          updatedAt: now,
        };
        if (manifest.status === 'active') {
          for (const item of state.workspaceManifests) {
            if (item.productId === manifest.productId && item.status === 'active') {
              item.status = 'archived';
              item.updatedAt = now;
            }
          }
        }
        state.workspaceManifests.push(manifest);
        return manifest;
      });
    },

    async listRunArtifacts() {
      return (await readState()).runArtifacts;
    },

    async getRunArtifact(runId) {
      return (await readState()).runArtifacts.find((artifact) => artifact.runId === runId);
    },

    async recordRunArtifactEvent(input) {
      await updateState(async (state) => {
        const now = new Date().toISOString();
        let artifact = state.runArtifacts.find((item) => item.runId === input.runId);
        if (!artifact) {
          const snapshot = input.inputSnapshotId ? state.snapshots.find((item) => item.id === input.inputSnapshotId) : undefined;
          artifact = {
            runId: input.runId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            productId: input.productId ?? snapshot?.productId,
            inputSnapshotId: input.inputSnapshotId,
            traceId: input.traceId,
            model: input.model,
            modelParams: input.modelParams,
            prompt: input.prompt,
            referencedFiles: input.referencedFiles ?? [],
            referencedSnippets: input.referencedSnippets ?? [],
            streamEvents: [],
            fileDiff: [],
            changedFiles: [],
            memoryFixture: [],
            knowledgeFixture: [],
            memoryWrites: [],
            memoryTombstones: [],
            knowledgeRetrievals: [],
            toolIoSummaries: [],
            toolEvents: [],
            resolvedAgentConfig: resolveActiveAgentConfig(state, input.productId),
            status: 'running',
            createdAt: now,
            updatedAt: now,
          };
          state.runArtifacts.push(artifact);
        }
        artifact.traceId ??= input.traceId;
        artifact.model ??= input.model;
        artifact.modelParams ??= input.modelParams;
        artifact.resolvedAgentConfig ??= resolveActiveAgentConfig(state, artifact.productId);
        artifact.streamEvents.push(input.event);
        artifact.updatedAt = now;
        if (input.event.type === 'file.changed') {
          const actualChange = resolveActualFileChange(state, artifact.inputSnapshotId, input.event.path, input.event.change);
          artifact.fileDiff.push({ path: input.event.path, change: actualChange });
          const changedFile = await captureChangedFile(workspaceStore, input.projectId, input.event.path, actualChange);
          if (changedFile) {
            const existingIndex = artifact.changedFiles.findIndex((item) => item.path === changedFile.path);
            if (existingIndex >= 0) {
              artifact.changedFiles[existingIndex] = changedFile;
            } else {
              artifact.changedFiles.push(changedFile);
            }
          }
        } else if (input.event.type === 'memory.recall') {
          artifact.memoryFixture = dedupeMemoryRecords([...artifact.memoryFixture, ...input.event.matches]);
        } else if (input.event.type === 'memory.write') {
          artifact.memoryWrites.push({ authority: input.event.authority, memoryType: input.event.memoryType, updateMode: input.event.updateMode, content: input.event.content, emittedAt: input.event.emittedAt, tombstonedMemoryId: input.event.tombstonedMemoryId, mocked: input.event.mocked, persisted: input.event.persisted });
          if (input.event.updateMode === 'tombstone') {
            artifact.memoryTombstones.push({ memoryId: input.event.tombstonedMemoryId, content: input.event.content, emittedAt: input.event.emittedAt });
          }
        } else if (input.event.type === 'knowledge.retrieve') {
          artifact.knowledgeFixture = dedupeKnowledgeEntries([...artifact.knowledgeFixture, ...input.event.matches]);
          artifact.knowledgeRetrievals.push({ query: input.event.query, matches: input.event.matches, emittedAt: input.event.emittedAt, tags: input.event.tags, topK: input.event.topK, source: input.event.source, rightsRiskMax: input.event.rightsRiskMax });
        } else if (input.event.type === 'tool_use.start' || input.event.type === 'tool_use.delta' || input.event.type === 'tool_use.end') {
          artifact.toolEvents.push(input.event);
          updateToolIoSummary(artifact, input.event);
        } else if (input.event.type === 'run.end') {
          artifact.status = input.event.status;
        }
      });
    },

    async listRunInputSnapshots() {
      return (await readState()).snapshots;
    },

    async createRunInputSnapshot(input) {
      const project = await workspaceStore.getProject(input.projectId);
      if (!project) throw new Error('Project not found');

      const snapshotId = `snapshot_${randomUUID()}`;
      const projectRoot = workspaceStore.getProjectRoot(input.projectId);
      const snapshotRoot = path.join(harnessRoot, SNAPSHOTS_DIR, snapshotId, 'workspace');
      await rm(snapshotRoot, { recursive: true, force: true });
      await mkdir(path.dirname(snapshotRoot), { recursive: true });
      await cp(projectRoot, snapshotRoot, {
        recursive: true,
        filter: (source) => shouldCopySnapshotPath(projectRoot, source),
      });

      const fileManifest = await buildFileManifest(snapshotRoot);
      const gitStatus = options.gitService ? await options.gitService.getStatus(projectRoot) : undefined;
      const now = new Date().toISOString();
      const snapshot: RunInputSnapshot = {
        id: snapshotId,
        runId: input.runId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        prompt: input.prompt,
        productId: input.productId ?? project.productId,
        snapshotMode: 'full_project',
        root: normalizePath(path.relative(harnessRoot, snapshotRoot)),
        excludeRules: SNAPSHOT_EXCLUDE_RULES,
        projectGitCommit: gitStatus?.lastCommitHash,
        projectGitDirty: gitStatus ? gitStatus.changedFiles > 0 : undefined,
        fileManifest,
        referencedFiles: input.referencedFiles ?? [],
        referencedSnippets: input.referencedSnippets ?? [],
        createdAt: now,
      };

      await updateState((state) => {
        state.snapshots.push(snapshot);
      });
      return snapshot;
    },

    async getRunInputSnapshot(snapshotId) {
      return (await readState()).snapshots.find((snapshot) => snapshot.id === snapshotId);
    },

    async listEvalFixtures() {
      return (await readState()).evalFixtures;
    },

    async createEvalFixtureFromSnapshot(input) {
      const state = await readState();
      const snapshot = state.snapshots.find((item) => item.id === input.snapshotId);
      if (!snapshot) throw new Error('Snapshot not found');

      const fixtureId = `eval_fixture_${randomUUID()}`;
      const fixtureWorkspaceRoot = path.join(harnessRoot, FIXTURES_DIR, fixtureId, 'workspace');
      await rm(fixtureWorkspaceRoot, { recursive: true, force: true });
      await mkdir(path.dirname(fixtureWorkspaceRoot), { recursive: true });
      await cp(path.join(harnessRoot, snapshot.root), fixtureWorkspaceRoot, { recursive: true });

      const now = new Date().toISOString();
      const fixture: EvalFixture = {
        id: fixtureId,
        name: input.name,
        productId: snapshot.productId ?? 'unknown',
        target: input.target,
        sourceRunId: snapshot.runId,
        sourceSnapshotId: snapshot.id,
        workspaceSnapshotRoot: normalizePath(path.relative(harnessRoot, fixtureWorkspaceRoot)),
        inputMessages: input.inputMessages ?? (snapshot.prompt ? [{ role: 'user', content: snapshot.prompt, createdAt: snapshot.createdAt }] : []),
        referencedSnippets: snapshot.referencedSnippets ?? [],
        memoryFixture: input.memoryFixture ?? [],
        knowledgeFixture: input.knowledgeFixture ?? [],
        expectedChangedFiles: [],
        expectedToolEvents: [],
        toolRetentionPolicy: [],
        sensitiveFieldRules: defaultSensitiveFieldRules(),
        toolRetentionArtifacts: [],
        toolMocks: input.toolMocks ?? {},
        assertions: input.assertions ?? {},
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
      };

      state.evalFixtures.push(fixture);
      await writeState(state);
      return fixture;
    },

    async createEvalFixtureFromRunArtifact(runId, input) {
      const state = await readState();
      const artifact = state.runArtifacts.find((item) => item.runId === runId);
      if (!artifact) throw new Error('Run artifact not found');
      const snapshotId = input.snapshotId ?? artifact.inputSnapshotId;
      if (!snapshotId) throw new Error('Run artifact has no input snapshot');
      const snapshot = state.snapshots.find((item) => item.id === snapshotId);
      if (!snapshot) throw new Error('Snapshot not found');

      const fixtureId = `eval_fixture_${randomUUID()}`;
      const fixtureWorkspaceRoot = path.join(harnessRoot, FIXTURES_DIR, fixtureId, 'workspace');
      await rm(fixtureWorkspaceRoot, { recursive: true, force: true });
      await mkdir(path.dirname(fixtureWorkspaceRoot), { recursive: true });
      await cp(path.join(harnessRoot, snapshot.root), fixtureWorkspaceRoot, { recursive: true });

      const now = new Date().toISOString();
      const sensitiveFieldRules = defaultSensitiveFieldRules();
      const toolRetentionPolicy = suggestToolRetentionPolicy(artifact, sensitiveFieldRules);
      const fixture: EvalFixture = {
        id: fixtureId,
        name: input.name,
        productId: snapshot.productId ?? artifact.productId ?? 'unknown',
        target: input.target,
        sourceRunId: artifact.runId,
        sourceSnapshotId: snapshot.id,
        workspaceSnapshotRoot: normalizePath(path.relative(harnessRoot, fixtureWorkspaceRoot)),
        inputMessages: input.inputMessages ?? [{ role: 'user', content: artifact.prompt, createdAt: artifact.createdAt }],
        referencedSnippets: artifact.referencedSnippets ?? [],
        memoryFixture: input.memoryFixture ?? artifact.memoryFixture,
        knowledgeFixture: input.knowledgeFixture ?? artifact.knowledgeFixture,
        expectedChangedFiles: artifact.changedFiles,
        expectedToolEvents: artifact.streamEvents.filter(isAssertionReplayEvent),
        toolRetentionPolicy,
        sensitiveFieldRules,
        toolRetentionArtifacts: buildToolRetentionArtifacts(artifact, toolRetentionPolicy),
        toolMocks: input.toolMocks ?? {},
        assertions: input.assertions ?? suggestAssertionsFromArtifact(artifact),
        tags: input.tags ?? ['from-run-artifact'],
        createdAt: now,
        updatedAt: now,
      };

      state.evalFixtures.push(fixture);
      await writeState(state);
      return fixture;
    },

    async updateEvalFixture(fixtureId, input) {
      return updateState((state) => {
        const fixture = state.evalFixtures.find((item) => item.id === fixtureId);
        if (!fixture) throw new Error('Eval fixture not found');
        if (input.name !== undefined) fixture.name = input.name;
        if (input.target !== undefined) fixture.target = input.target;
        if (input.inputMessages !== undefined) fixture.inputMessages = input.inputMessages;
        if (input.referencedSnippets !== undefined) fixture.referencedSnippets = input.referencedSnippets;
        if (input.memoryFixture !== undefined) fixture.memoryFixture = input.memoryFixture;
        if (input.knowledgeFixture !== undefined) fixture.knowledgeFixture = input.knowledgeFixture;
        if (input.expectedChangedFiles !== undefined) fixture.expectedChangedFiles = input.expectedChangedFiles;
        if (input.expectedToolEvents !== undefined) fixture.expectedToolEvents = input.expectedToolEvents;
        if (input.toolRetentionPolicy !== undefined) fixture.toolRetentionPolicy = input.toolRetentionPolicy;
        if (input.sensitiveFieldRules !== undefined) {
          fixture.sensitiveFieldRules = input.sensitiveFieldRules;
          if (fixture.sourceRunId) {
            const artifact = state.runArtifacts.find((item) => item.runId === fixture.sourceRunId);
            if (artifact) {
              fixture.toolRetentionPolicy = suggestToolRetentionPolicy(artifact, fixture.sensitiveFieldRules);
              fixture.toolRetentionArtifacts = buildToolRetentionArtifacts(artifact, fixture.toolRetentionPolicy);
            }
          }
        }
        if (input.toolRetentionArtifacts !== undefined) fixture.toolRetentionArtifacts = input.toolRetentionArtifacts;
        if (input.toolMocks !== undefined) fixture.toolMocks = input.toolMocks;
        if (input.assertions !== undefined) fixture.assertions = input.assertions;
        if (input.tags !== undefined) fixture.tags = input.tags;
        fixture.updatedAt = new Date().toISOString();
        return fixture;
      });
    },

    async listEvalRuns() {
      return (await readState()).evalRuns;
    },

    async createEvalRun(input) {
      let pendingExecution: PendingEvalRunExecution | null = null;
      const evalRun = await updateState(async (state) => {
        const fixture = state.evalFixtures.find((item) => item.id === input.fixtureId);
        if (!fixture) throw new Error('Eval fixture not found');
        const agentSpec = state.agentSpecs.find((item) => item.id === input.agentSpecId);
        if (!agentSpec) throw new Error('Agent spec not found');
        const now = new Date().toISOString();
        const evalRunId = `eval_run_${randomUUID()}`;
        const runWorkspaceRoot = path.join(harnessRoot, EVAL_RUNS_DIR, evalRunId, 'workspace');
        await mkdir(path.dirname(runWorkspaceRoot), { recursive: true });
        await cp(path.join(harnessRoot, fixture.workspaceSnapshotRoot), runWorkspaceRoot, { recursive: true });
        const beforeManifest = await buildFileManifest(runWorkspaceRoot);
        const beforeTextSnapshot = await collectAssertionTextSnapshot(runWorkspaceRoot, fixture.assertions);
        const resolvedAgentConfig = await resolveAgentConfig(state, agentSpec, workspaceStore);
        const sourceArtifact = fixture.sourceRunId ? state.runArtifacts.find((item) => item.runId === fixture.sourceRunId) : undefined;
        const model = sourceArtifact?.modelParams?.model ?? sourceArtifact?.model;
        const modelParams = sourceArtifact?.modelParams ?? (model ? { model, maxSteps: 25, source: 'run_input' as const } : undefined);
        const evalRun: EvalRun = {
          id: evalRunId,
          fixtureId: fixture.id,
          agentSpecId: agentSpec.id,
          runMode: input.runMode ?? 'repro',
          executionMode: options.evalRunExecutor ? 'custom_executor' : 'fixture_replay',
          status: 'running',
          model,
          modelParams,
          startedAt: now,
          outputMessage: `EvalRun created. Execution continues in isolated workspace ${normalizePath(path.relative(harnessRoot, runWorkspaceRoot))}. Model: ${model ?? 'runtime default'}.`,
          toolEvents: [],
          fileDiff: [],
          changedFiles: [],
          assertionResults: [],
          humanReview: null,
          resolvedAgentConfig,
        };
        state.evalRuns.push(evalRun);
        pendingExecution = {
          evalRunId,
          runWorkspaceRoot,
          fixture: structuredClone(fixture),
          agentSpec: structuredClone(agentSpec),
          model,
          modelParams,
          beforeManifest,
          beforeTextSnapshot,
          resolvedAgentConfig,
          runMode: input.runMode ?? 'repro',
        };
        return evalRun;
      });
      if (pendingExecution) {
        if (options.asyncEvalRuns === true) {
          void executeEvalRunAndUpdate(pendingExecution);
        } else {
          await executeEvalRunAndUpdate(pendingExecution);
          const completedEvalRun = (await readState()).evalRuns.find((item) => item.id === evalRun.id);
          if (completedEvalRun) return completedEvalRun;
        }
      }
      return evalRun;
    },

    async completeEvalRun(evalRunId, outputMessage) {
      return updateState((state) => {
        const evalRun = state.evalRuns.find((item) => item.id === evalRunId);
        if (!evalRun) throw new Error('Eval run not found');
        evalRun.endedAt = new Date().toISOString();
        evalRun.outputMessage = outputMessage ?? evalRun.outputMessage;
        evalRun.status = evalRun.assertionResults.every((result) => result.passed) ? 'passed' : 'failed';
        return evalRun;
      });
    },

    async addHumanReview(evalRunId, input) {
      return updateState((state) => {
        const evalRun = state.evalRuns.find((item) => item.id === evalRunId);
        if (!evalRun) throw new Error('Eval run not found');
        evalRun.humanReview = {
          ...input,
          evalRunId,
          createdAt: new Date().toISOString(),
        };
        return evalRun;
      });
    },

    async addBatchHumanReview(input) {
      return updateState((state) => {
        const now = new Date().toISOString();
        const updated: EvalRun[] = [];
        for (const evalRunId of input.evalRunIds) {
          const evalRun = state.evalRuns.find((item) => item.id === evalRunId);
          if (!evalRun) throw new Error(`Eval run not found: ${evalRunId}`);
          evalRun.humanReview = {
            rubricId: input.rubricId,
            rubricVersion: input.rubricVersion,
            reviewer: input.reviewer,
            decision: input.decision,
            scores: input.scores,
            subScores: input.subScores,
            annotations: input.annotations,
            notes: input.notes,
            evalRunId,
            createdAt: now,
          };
          updated.push(evalRun);
        }
        return updated;
      });
    },

    async listReleaseRecords(filter = {}) {
      const state = await readState();
      const records = state.releaseRecords
        .filter((record) => filter.productId === undefined || record.productId === filter.productId)
        .filter((record) => filter.agentId === undefined || record.agentId === filter.agentId)
        .filter((record) => filter.action === undefined || record.action === filter.action)
        .filter((record) => filter.auditCategory === undefined || record.auditCategory === filter.auditCategory)
        .filter((record) => filter.force === undefined || record.force === filter.force)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return typeof filter.limit === 'number' ? records.slice(0, filter.limit) : records;
    },

    async listHumanReviewRubrics() {
      const state = await readState();
      if (state.humanReviewRubrics.length > 0) return state.humanReviewRubrics;
      return [defaultStoryRubric()];
    },
  };
}

async function seedProductProfileBaselines(state: HarnessState): Promise<HarnessState> {
  for (const productProfile of Object.values(PRODUCT_PROFILES)) {
    await seedProductProfileBaseline(state, productProfile.id);
  }
  return state;
}

async function seedProductProfileBaseline(state: HarnessState, productId: string): Promise<void> {
  const productProfile = resolveProductProfile(productId);
  const now = new Date().toISOString();

  await ensureBaselinePromptBlocks(state, productProfile, now);
  const memoryPolicy = ensureBaselineMemoryPolicy(state, productId, now);
  const retrievalPolicy = ensureBaselineRetrievalPolicy(state, productId, now);
  ensureBaselineWorkspaceManifest(state, productId, now);
  const layerConfig = await ensureBaselineLayerConfig(state, productId, memoryPolicy, retrievalPolicy, now);

  const existingSystemSpec = state.agentSpecs.find((spec) => spec.productId === productId && spec.agentId === 'system' && spec.status === 'active');
  if (existingSystemSpec) {
    if (existingSystemSpec.id === `seed_${productId}_system_active_v1` && existingSystemSpec.promptBlockRefs.length === 0) {
      existingSystemSpec.promptBlockRefs = baselinePromptBlockRefs(productId, 'system');
      existingSystemSpec.updatedAt = now;
    }
  } else {
    state.agentSpecs.push({
      id: `seed_${productId}_system_active_v1`,
      productId,
      agentId: 'system',
      version: 1,
      status: 'active',
      layerConfigRef: layerConfig.id,
      promptBlockRefs: baselinePromptBlockRefs(productId, 'system'),
      skillRefs: [],
      memoryPolicyRef: `${memoryPolicy.id}@${memoryPolicy.version}`,
      retrievalPolicyRef: `${retrievalPolicy.id}@${retrievalPolicy.version}`,
      toolPolicyRef: layerConfig.toolPolicyRef,
      modelPolicyRef: layerConfig.modelPolicyRef,
      changelog: `Seeded from ${productId} product profile system prompt as the baseline active AgentSpec.`,
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
    });
  }

  for (const agentId of productProfile.defaultAgentSkillNames) {
    const existingActiveSpec = state.agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
    if (existingActiveSpec) {
      if (existingActiveSpec.id === `seed_${productId}_${agentId}_active_v1` && existingActiveSpec.promptBlockRefs.length === 0) {
        existingActiveSpec.promptBlockRefs = baselinePromptBlockRefs(productId, agentId);
        existingActiveSpec.updatedAt = now;
      }
      continue;
    }
    state.agentSpecs.push({
      id: `seed_${productId}_${agentId}_active_v1`,
      productId,
      agentId,
      version: 1,
      status: 'active',
      layerConfigRef: layerConfig.id,
      promptBlockRefs: baselinePromptBlockRefs(productId, agentId),
      skillRefs: [{ skillId: agentId, version: 1 }],
      memoryPolicyRef: `${memoryPolicy.id}@${memoryPolicy.version}`,
      retrievalPolicyRef: `${retrievalPolicy.id}@${retrievalPolicy.version}`,
      toolPolicyRef: layerConfig.toolPolicyRef,
      modelPolicyRef: layerConfig.modelPolicyRef,
      changelog: `Seeded from ${productId} product profile and global Agent config as the baseline active AgentSpec.`,
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
    });
  }
}

async function ensureBaselinePromptBlocks(state: HarnessState, profile: ProductProfile, now: string): Promise<void> {
  const productId = profile.id;
  const definitions: Array<{ id: string; title: string; scope: PromptBlock['scope']; content: string }> = [
    {
      id: `seed_${productId}_system_orchestration`,
      title: 'System orchestration and workflow gates',
      scope: 'system',
      content: systemWorkflowBlock(productId),
    },
    {
      id: `seed_${productId}_workspace_output_policy`,
      title: 'Workspace output and tool policy',
      scope: 'tool',
      content: workspaceOutputPolicyBlock(productId),
    },
  ];

  for (const agentId of profile.defaultAgentSkillNames) {
    const prompt = await readProductSkillPrompt(profile, agentId).catch(() => '');
    definitions.push({
      id: `seed_${productId}_${agentId}_role_boundary`,
      title: `${agentId} role and boundary`,
      scope: agentId === 'reviewer-agent' ? 'reviewer' : 'specialist',
      content: extractPromptBlock(prompt, ['职责', '边界', '输入', '规则', '打回对象判断']) || fallbackRoleBoundaryBlock(productId, agentId),
    });
    definitions.push({
      id: `seed_${productId}_${agentId}_quality_gate`,
      title: `${agentId} quality gate`,
      scope: agentId === 'reviewer-agent' ? 'reviewer' : 'quality',
      content: extractPromptBlock(prompt, ['质量标准', '合格故事最低门槛', '基本要求', '好原著分析标准', '好改编方案标准', '好剧本标准', '故事一票否决项', '故事审查项', '原著分析审查', '改编方案审查', '剧本审查']) || fallbackQualityGateBlock(productId, agentId),
    });
    definitions.push({
      id: `seed_${productId}_${agentId}_output_contract`,
      title: `${agentId} output contract`,
      scope: 'specialist',
      content: extractPromptBlock(prompt, ['输出格式']) || fallbackOutputContractBlock(productId, agentId),
    });
  }

  for (const definition of definitions) {
    const existing = state.promptBlocks.find((block) => block.id === definition.id && block.version === 1);
    if (existing) continue;
    state.promptBlocks.push({
      id: definition.id,
      productId,
      version: 1,
      status: 'active',
      title: definition.title,
      scope: definition.scope,
      content: definition.content.trim(),
      contentHash: sha256(definition.content.trim()),
      createdAt: now,
      updatedAt: now,
    });
  }
}

function ensureBaselineMemoryPolicy(state: HarnessState, productId: string, now: string): MemoryPolicy {
  const existing = state.memoryPolicies
    .filter((policy) => policy.productId === productId && policy.status === 'active')
    .sort(compareVersionAndUpdatedAt)[0];
  if (existing) return existing;

  const policy: MemoryPolicy = {
    id: `seed_${productId}_memory_policy`,
    productId,
    version: 1,
    status: 'active',
    namespaces: {
      session: ['viforge', productId, 'sessions', '{sessionId}', 'memories'],
      workspace: ['viforge', productId, 'workspaces', '{projectId}', 'memories'],
      global: ['viforge', productId, 'users', '{userId}', 'global', 'memories'],
    },
    recallOrder: ['session', 'workspace', 'global'],
    writeRules: {
      user_explicit: 'allow',
      file_derived: 'allow_with_evidence',
      agent_inferred: 'confirm_for_long_term',
      workflow_event: 'allow',
    },
    conflictPolicy: 'formal_file_wins',
    tombstoneRequired: true,
    createdAt: now,
    updatedAt: now,
  };
  state.memoryPolicies.push(policy);
  return policy;
}

function ensureBaselineRetrievalPolicy(state: HarnessState, productId: string, now: string): RetrievalPolicy {
  const existing = state.retrievalPolicies
    .filter((policy) => policy.productId === productId && policy.status === 'active')
    .sort(compareVersionAndUpdatedAt)[0];
  if (existing) return existing;

  const policy: RetrievalPolicy = {
    id: `seed_${productId}_retrieval_policy`,
    productId,
    version: 1,
    status: 'active',
    enabledTypes: ['mechanism', 'viewpoint', 'joke_pattern'],
    defaultTopK: 5,
    rightsRiskMax: 'medium',
    writeFlow: 'inbox_then_confirm',
    forbiddenUse: ['copy_dialogue', 'copy_full_plot', 'copy_character_identity'],
    mockable: true,
    createdAt: now,
    updatedAt: now,
  };
  state.retrievalPolicies.push(policy);
  return policy;
}

function ensureBaselineWorkspaceManifest(state: HarnessState, productId: string, now: string): WorkspaceManifest {
  const existing = state.workspaceManifests
    .filter((manifest) => manifest.productId === productId && manifest.status === 'active')
    .sort((left, right) => right.templateVersion - left.templateVersion || compareUpdatedAt(left, right))[0];
  if (existing) return existing;

  const profile = resolveProductProfile(productId);
  const planPath = productId === 'sitcom'
    ? '02 故事/01 第一集/单集大纲.md'
    : profile.artifactPaths.plan?.[0] ?? profile.artifactPaths.sourceAnalysis?.[0];
  const artifactTypes: WorkspaceManifest['artifactTypes'] = {
    script: { canonicalPath: profile.artifactPaths.script, requiredSections: ['冷开场', '正戏', '结尾'] },
  };
  if (planPath) {
    artifactTypes.plan = { canonicalPath: planPath, requiredSections: productId === 'sitcom' ? ['主角目标', '主要阻力', '升级链条'] : ['原著范围', '戏剧任务'] };
  }

  const manifest: WorkspaceManifest = {
    id: `seed_${productId}_workspace_manifest`,
    productId,
    templateVersion: 1,
    status: 'active',
    requiredDirectories: profile.projectDirectories.filter((directory) => !directory.startsWith('04 ') && !directory.startsWith('05 ') && !directory.startsWith('06 ')),
    artifactTypes,
    validationRules: ['formal_file_wins_memory', 'reviewer_required_before_save'],
    createdAt: now,
    updatedAt: now,
  };
  state.workspaceManifests.push(manifest);
  return manifest;
}

function baselinePromptBlockRefs(productId: string, agentId: string): string[] {
  if (agentId === 'system') {
    return [`seed_${productId}_system_orchestration@1`, `seed_${productId}_workspace_output_policy@1`];
  }
  return [
    `seed_${productId}_system_orchestration@1`,
    `seed_${productId}_workspace_output_policy@1`,
    `seed_${productId}_${agentId}_role_boundary@1`,
    `seed_${productId}_${agentId}_quality_gate@1`,
    `seed_${productId}_${agentId}_output_contract@1`,
  ];
}

function systemWorkflowBlock(productId: string): string {
  if (productId === 'sitcom') {
    return [
      'System agent 统筹情景剧创作链路，不替代 specialist 完成正式故事或剧本。',
      '脑暴只委派 brainstorm-agent，在聊天中展示，不进入审稿闭环，不写正式文件。',
      '正式故事请求必须读取项目设定、人物关系、场景规则、风格约束和目标集数已有文件。',
      '人物动机、角色关系或连续性不足时，先委派 character-agent 或 continuity-agent 补齐约束。',
      '正式故事必须由 story-agent 产出，并经 reviewer-agent 通过后才能写入正式故事路径。',
      '审稿打回时按 reviewer-agent 的具体不合格项返工；达到全局返工上限仍失败时停止并说明阻塞点。',
    ].join('\n');
  }
  return [
    'System agent 统筹小说改编链路，不替代 specialist 完成正式产物。',
    '脑暴只委派 brainstorm-agent，在聊天中展示，不进入审稿闭环，不写正式文件。',
    '正式流程按原著分析、改编方案、剧本逐级推进；每一级正式产物都必须经过 reviewer-agent。',
    '原著分析打回交回 source-analyst-agent；方案打回交回 adaptation-planner-agent；剧本问题按根因交回 screenwriter-agent、adaptation-planner-agent 或 source-analyst-agent。',
    '达到全局返工上限仍失败时停止并说明最近一次不合格项、失败根因和需要用户决策的点。',
  ].join('\n');
}

function workspaceOutputPolicyBlock(productId: string): string {
  const paths = productId === 'sitcom'
    ? [
      '整季故事线：02 故事/整季故事线.md',
      '单集故事：02 故事/<集数>/单集大纲.md',
      '情节卡片：02 故事/<集数>/情节卡片.md',
      '剧本：03 剧本/<集数>/定稿剧本.md',
    ]
    : [
      '原著分析：01 原著资料/章节拆解.md、01 原著资料/人物关系.md 或用户指定路径',
      '改编方案：02 改编方案/全季改编方案.md、02 改编方案/<集数>/单集改编方案.md',
      '剧本：03 剧本/<集数>/剧本.md',
    ];
  return [
    '所有正式文件写入必须遵守 WorkspaceManifest 和用户明确指定路径；用户指定路径优先。',
    '审稿意见默认只展示在聊天中，不保存为项目文件，除非用户明确要求记录。',
    '图片工具调用前必须先展示完整 prompt、比例、数量、预计保存路径；编辑图片还要说明原图和修改要点，并等待用户明确确认。',
    '正式产物路径：',
    ...paths.map((item) => `- ${item}`),
  ].join('\n');
}

function fallbackRoleBoundaryBlock(productId: string, agentId: string): string {
  const sitcom: Record<string, string> = {
    'brainstorm-agent': '只负责情景剧方向脑暴和候选故事种子，不审稿、不写正式文件。',
    'character-agent': '只负责人设、角色关系、行为边界和可复用喜剧机关，不写完整故事或剧本。',
    'continuity-agent': '只负责连续性事实、场景规则、历史包袱和不可违背约束，不做最终质量验收。',
    'story-agent': '负责正式情景剧故事创作，处理目标、阻力、升级、A/B 故事和结尾回收，不写完整剧本。',
    'screenwriter-agent': '只能基于已通过故事大纲写可拍摄剧本，不推翻故事核心。',
    'reviewer-agent': '作为严格质量闸门，只判断通过或打回，不直接改稿。',
  };
  const adaptation: Record<string, string> = {
    'brainstorm-agent': '只负责小说改编方向脑暴，不审稿、不写正式项目文件。',
    'source-analyst-agent': '负责把用户提供或引用的小说资料拆解为可改编依据。',
    'adaptation-planner-agent': '负责把已成立的原著分析转换为全季或单集改编方案。',
    'screenwriter-agent': '负责把已通过改编方案转换为可拍摄、可表演剧本。',
    'reviewer-agent': '作为严格改编质量闸门，只判断通过或打回，不直接改稿。',
  };
  return (productId === 'sitcom' ? sitcom : adaptation)[agentId] ?? `${agentId} follows product-specific specialist boundaries.`;
}

function fallbackQualityGateBlock(productId: string, agentId: string): string {
  if (productId === 'sitcom') {
    if (agentId === 'reviewer-agent') return '必须检查主角目标、持续阻力、因果升级、喜剧机制、人物一致性、结尾回收和可表演性；任一结构性失败都打回。';
    if (agentId === 'story-agent') return '故事必须同时具备具体目标、持续阻力、因果链、升级、选择与后果、喜剧机制、人物一致性、单集闭合和结尾回收。';
    if (agentId === 'character-agent') return '主要角色必须有表层目标、隐藏需求、喜剧缺点、行为边界、关系压力和可执行行动约束。';
    if (agentId === 'continuity-agent') return '必须区分已确认事实、推断和待确认信息，并给出具体冲突来源、影响范围和修复方式。';
    if (agentId === 'screenwriter-agent') return '每场戏必须有场景目标、冲突、动作、对白和转折，喜剧节拍必须可表演可拍摄。';
    return '候选方向必须包含角色欲望、阻力、喜剧错位和升级可能，并说明推荐方向的理由。';
  }
  if (agentId === 'reviewer-agent') return '必须严格审查原著分析、改编方案或剧本是否达标，只允许通过或打回。';
  if (agentId === 'source-analyst-agent') return '原著分析必须明确主题、主线、人物关系、可影视化场面、外化处理建议和改编风险。';
  if (agentId === 'adaptation-planner-agent') return '改编方案必须明确原著范围、戏剧任务、主角行动、角色取舍、外化方式和结尾钩子。';
  if (agentId === 'screenwriter-agent') return '剧本每场戏必须有目标、冲突、可拍摄动作、可表演对白、节拍和原著对应关系。';
  return '候选方向必须包含改编定位、主视角、篇幅建议、人物取舍、潜在风险和推荐理由。';
}

function fallbackOutputContractBlock(productId: string, agentId: string): string {
  if (productId === 'sitcom') {
    if (agentId === 'story-agent') return '输出单集故事，包含一句话故事核、本集主题、设定约束、A 故事、B 故事、关键场景、涉及人物和场景、喜剧机制、给 screenwriter-agent 的提示。';
    if (agentId === 'reviewer-agent') return '输出结论、审查对象、打回对象、硬门槛检查、不合格项、返工要求和通过条件；需要结构化时附加 JSON。';
    if (agentId === 'character-agent') return '输出人物设定补充、角色小传、角色关系表和给 story-agent 的约束。';
    if (agentId === 'continuity-agent') return '输出连续性检查、已确认事实、角色关系状态、场景与规则、冲突检查和给 story-agent 的约束。';
    if (agentId === 'brainstorm-agent') return '输出候选方向和推荐方向；每个方向包含故事种子、人物欲望、阻力/误会、喜剧机制、升级方式和风险。';
    return '输出可拍摄剧本，按场景组织动作、对白、节拍和可表演冲突。';
  }
  if (agentId === 'source-analyst-agent') return '输出原著分析，包含核心主题、主线剧情、人物关系、关键场面、可改编单元、外化处理建议、改编边界与风险。';
  if (agentId === 'adaptation-planner-agent') return '输出改编方案，包含改编定位、原著范围、分集规划、单集节拍、角色与情节取舍、原著对应关系。';
  if (agentId === 'screenwriter-agent') return '输出剧本，包含冷开场、正戏、结尾；每场包含地点/时间、动作、角色对白、节拍和原著对应。';
  if (agentId === 'reviewer-agent') return '输出结论、打回对象、不合格项和返工要求。';
  return '输出 3 到 5 个候选改编方向，并推荐最值得进入 source-analyst-agent 的方向。';
}

function extractPromptBlock(prompt: string, headings: string[]): string {
  const lines = stripYamlFrontmatter(prompt).split(/\r?\n/);
  const sections: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '');
    if (!match || !headings.includes(match[1])) continue;
    const sectionLines = [lines[index]];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^##\s+/.test(lines[next] ?? '')) break;
      sectionLines.push(lines[next]);
    }
    sections.push(sectionLines.join('\n').trim());
  }
  return sections.join('\n\n').trim();
}

function stripYamlFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

async function ensureBaselineLayerConfig(state: HarnessState, productId: string, memoryPolicy: MemoryPolicy, retrievalPolicy: RetrievalPolicy, now: string): Promise<AgentLayerConfig> {
  const existing = state.agentLayerConfigs
    .filter((config) => config.productId === productId && config.status === 'active')
    .sort(compareVersionAndUpdatedAt)[0];
  if (existing) {
    if (existing.id === `seed_${productId}_layer_config`) {
      const systemRefs = [`seed_${productId}_system_orchestration@1`, `seed_${productId}_workspace_output_policy@1`];
      existing.systemAgent.promptBlockRefs = uniqueStrings([...existing.systemAgent.promptBlockRefs, ...systemRefs]);
      existing.specialists = existing.specialists.map((specialist) => ({
        ...specialist,
        promptBlockRefs: uniqueStrings([
          ...specialist.promptBlockRefs,
          ...baselinePromptBlockRefs(productId, specialist.agentId).filter((ref) => !systemRefs.includes(ref)),
        ]),
      }));
      existing.updatedAt = now;
    }
    return existing;
  }

  const profile = resolveProductProfile(productId);
  const systemInstructions = await readProductSystemAgentPrompt(profile).catch(() => '');
  const layerConfig: AgentLayerConfig = {
    id: `seed_${productId}_layer_config`,
    productId,
    version: 1,
    status: 'active',
    systemAgent: {
      agentId: 'system',
      promptBlockRefs: [`seed_${productId}_system_orchestration@1`, `seed_${productId}_workspace_output_policy@1`],
      allowedTools: ['read_workspace_file', 'write_workspace_file', 'delegate_to_specialist_agent', 'recall_project_memory', 'retrieve_knowledge_cards'],
      instructionOverride: systemInstructions,
    },
    specialists: await Promise.all(profile.defaultAgentSkillNames.map(async (agentId) => ({
      agentId,
      skillRef: `${agentId}@1`,
      promptBlockRefs: baselinePromptBlockRefs(productId, agentId).filter((ref) => !ref.includes('_system_orchestration') && !ref.includes('_workspace_output_policy')),
      defaultEnabled: true,
      instructionOverride: await readProductSkillPrompt(profile, agentId).catch(() => undefined),
    }))),
    memoryPolicyRef: `${memoryPolicy.id}@${memoryPolicy.version}`,
    retrievalPolicyRef: `${retrievalPolicy.id}@${retrievalPolicy.version}`,
    toolPolicyRef: 'workspace-safe-write@1',
    modelPolicyRef: 'default-chat-model@1',
    createdAt: now,
    updatedAt: now,
  };
  state.agentLayerConfigs.push(layerConfig);
  return layerConfig;
}

function normalizeState(state: Partial<HarnessState>): HarnessState {
  const runArtifacts = Array.isArray(state.runArtifacts) ? state.runArtifacts.map((artifact) => ({
    ...artifact,
    memoryTombstones: Array.isArray(artifact.memoryTombstones) ? artifact.memoryTombstones : [],
    toolIoSummaries: Array.isArray(artifact.toolIoSummaries) ? artifact.toolIoSummaries : [],
  })) : [];
  return {
    agentLayerConfigs: Array.isArray(state.agentLayerConfigs) ? state.agentLayerConfigs : [],
    agentSpecs: Array.isArray(state.agentSpecs) ? state.agentSpecs : [],
    memoryPolicies: Array.isArray(state.memoryPolicies) ? state.memoryPolicies : [],
    knowledgeBaseEntries: Array.isArray(state.knowledgeBaseEntries) ? state.knowledgeBaseEntries : [],
    retrievalPolicies: Array.isArray(state.retrievalPolicies) ? state.retrievalPolicies : [],
    promptBlocks: Array.isArray(state.promptBlocks) ? state.promptBlocks : [],
    skillSnapshots: Array.isArray(state.skillSnapshots) ? state.skillSnapshots : [],
    workspaceManifests: Array.isArray(state.workspaceManifests) ? state.workspaceManifests : [],
    runArtifacts,
    snapshots: Array.isArray(state.snapshots) ? state.snapshots : [],
    evalFixtures: Array.isArray(state.evalFixtures) ? state.evalFixtures : [],
    evalRuns: Array.isArray(state.evalRuns) ? state.evalRuns : [],
    humanReviewRubrics: Array.isArray(state.humanReviewRubrics) ? state.humanReviewRubrics : [],
    releaseRecords: Array.isArray(state.releaseRecords) ? state.releaseRecords : [],
  };
}

function compareVersionAndUpdatedAt<T extends { version: number; updatedAt?: string }>(left: T, right: T): number {
  return right.version - left.version || compareUpdatedAt(left, right);
}

function compareUpdatedAt(left: { updatedAt?: string }, right: { updatedAt?: string }): number {
  return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function evaluateReleaseGate(state: HarnessState, spec: AgentSpec): AgentSpecReleaseGate {
  const evalRuns = state.evalRuns.filter((run) => run.agentSpecId === spec.id);
  const passingReviewedRuns = evalRuns.filter((run) => {
    const decision = run.humanReview?.decision;
    return run.status === 'passed' && (decision === 'pass' || decision === 'improved');
  });
  const activeSpec = state.agentSpecs.find((item) => item.productId === spec.productId && item.agentId === spec.agentId && item.status === 'active' && item.id !== spec.id);
  const configChanges = summarizeConfigChanges(spec, activeSpec);
  const checks = [
    {
      id: 'has_eval_run',
      passed: evalRuns.length > 0,
      message: evalRuns.length > 0 ? undefined : 'No EvalRun has been created for this AgentSpec.',
    },
    {
      id: 'has_passing_eval_run',
      passed: evalRuns.some((run) => run.status === 'passed'),
      message: evalRuns.some((run) => run.status === 'passed') ? undefined : 'No EvalRun has passed program assertions.',
    },
    {
      id: 'has_positive_human_review',
      passed: passingReviewedRuns.length > 0,
      message: passingReviewedRuns.length > 0 ? undefined : 'No passed EvalRun has pass/improved human review.',
    },
  ];
  if (passingReviewedRuns.length === 0) {
    return {
      agentSpecId: spec.id,
      passed: false,
      reason: 'AgentSpec must have at least one passed EvalRun with pass/improved human review before activation. Use force only for explicit emergency override.',
      evalRunIds: evalRuns.map((run) => run.id),
      checks,
      configChanges,
    };
  }
  return { agentSpecId: spec.id, passed: true, reason: 'ok', evalRunIds: passingReviewedRuns.map((run) => run.id), checks, configChanges };
}

function summarizeConfigChanges(spec: AgentSpec, activeSpec: AgentSpec | undefined): AgentSpecReleaseGate['configChanges'] {
  if (!activeSpec) {
    return [
      { field: 'activeSpec', changed: true, message: 'No existing active AgentSpec for this product/agent.' },
    ];
  }
  return [
    compareScalarConfig('promptBlockRefs', spec.promptBlockRefs, activeSpec.promptBlockRefs),
    compareScalarConfig('skillRefs', spec.skillRefs, activeSpec.skillRefs),
    compareScalarConfig('layerConfigRef', spec.layerConfigRef, activeSpec.layerConfigRef),
    compareScalarConfig('memoryPolicyRef', spec.memoryPolicyRef, activeSpec.memoryPolicyRef),
    compareScalarConfig('retrievalPolicyRef', spec.retrievalPolicyRef, activeSpec.retrievalPolicyRef),
    compareScalarConfig('toolPolicyRef', spec.toolPolicyRef, activeSpec.toolPolicyRef),
    compareScalarConfig('modelPolicyRef', spec.modelPolicyRef, activeSpec.modelPolicyRef),
  ];
}

function compareScalarConfig(field: string, candidateValue: unknown, activeValue: unknown): AgentSpecReleaseGate['configChanges'][number] {
  const candidate = stableStringify(candidateValue ?? null);
  const active = stableStringify(activeValue ?? null);
  const changed = candidate !== active;
  return {
    field,
    changed,
    message: changed ? `candidate ${candidate} != active ${active}` : `unchanged ${candidate}`,
  };
}

function auditCategoryForForceReason(reason: AgentSpecReleaseForceReason): AgentSpecReleaseAuditCategory {
  switch (reason) {
    case 'emergency_fix':
    case 'eval_gap':
    case 'manual_override':
      return 'gate_bypass';
    case 'bad_active_regression':
    case 'bad_release':
      return 'quality_regression';
    case 'data_corruption':
      return 'data_integrity';
    case 'policy_violation':
      return 'policy_exception';
    case 'rollback':
      return 'planned_rollback';
    case 'other':
      return 'other';
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function selectVersionPair<T extends { version: number }>(versions: T[], fromVersion: number | undefined, toVersion: number | undefined, notFoundMessage: string): { previous: T; next: T } {
  if (versions.length === 0) throw new Error(notFoundMessage);
  const next = toVersion !== undefined
    ? versions.find((item) => item.version === toVersion)
    : versions.at(-1);
  if (!next) throw new Error(notFoundMessage);
  const previous = fromVersion !== undefined
    ? versions.find((item) => item.version === fromVersion)
    : [...versions].reverse().find((item) => item.version < next.version) ?? next;
  if (!previous) throw new Error(notFoundMessage);
  return { previous, next };
}

function buildVersionDiff(
  recordType: HarnessVersionDiff['recordType'],
  id: string,
  previous: { version: number; contentHash: string },
  next: { version: number; contentHash: string },
  previousText: string,
  nextText: string,
): HarnessVersionDiff {
  return {
    recordType,
    id,
    previousVersion: previous.version,
    nextVersion: next.version,
    previousHash: previous.contentHash,
    nextHash: next.contentHash,
    changed: previous.contentHash !== next.contentHash,
    lines: diffTextLines(previousText, nextText),
  };
}

function diffTextLines(previousText: string, nextText: string): HarnessVersionDiff['lines'] {
  const previousLines = splitDiffLines(previousText);
  const nextLines = splitDiffLines(nextText);
  const lcs = buildLcsMatrix(previousLines, nextLines);
  const lines: HarnessVersionDiff['lines'] = [];
  let previousIndex = 0;
  let nextIndex = 0;
  while (previousIndex < previousLines.length && nextIndex < nextLines.length) {
    if (previousLines[previousIndex] === nextLines[nextIndex]) {
      lines.push({ change: 'same', lineNumber: nextIndex + 1, previousLineNumber: previousIndex + 1, nextLineNumber: nextIndex + 1, text: previousLines[previousIndex] });
      previousIndex += 1;
      nextIndex += 1;
    } else if (lcs[previousIndex + 1]?.[nextIndex] >= lcs[previousIndex]?.[nextIndex + 1]) {
      lines.push({ change: 'removed', previousLineNumber: previousIndex + 1, text: previousLines[previousIndex] });
      previousIndex += 1;
    } else {
      lines.push({ change: 'added', nextLineNumber: nextIndex + 1, text: nextLines[nextIndex] });
      nextIndex += 1;
    }
  }
  while (previousIndex < previousLines.length) {
    lines.push({ change: 'removed', previousLineNumber: previousIndex + 1, text: previousLines[previousIndex] });
    previousIndex += 1;
  }
  while (nextIndex < nextLines.length) {
    lines.push({ change: 'added', nextLineNumber: nextIndex + 1, text: nextLines[nextIndex] });
    nextIndex += 1;
  }
  return lines;
}

function splitDiffLines(value: string): string[] {
  if (value.length === 0) return [];
  return value.replace(/\r\n/g, '\n').split('\n');
}

function buildLcsMatrix(previousLines: string[], nextLines: string[]): number[][] {
  const matrix = Array.from({ length: previousLines.length + 1 }, () => Array(nextLines.length + 1).fill(0) as number[]);
  for (let previousIndex = previousLines.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let nextIndex = nextLines.length - 1; nextIndex >= 0; nextIndex -= 1) {
      matrix[previousIndex][nextIndex] = previousLines[previousIndex] === nextLines[nextIndex]
        ? matrix[previousIndex + 1][nextIndex + 1] + 1
        : Math.max(matrix[previousIndex + 1][nextIndex], matrix[previousIndex][nextIndex + 1]);
    }
  }
  return matrix;
}

function dedupeMemoryRecords(records: MemoryRecord[]): MemoryRecord[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function dedupeKnowledgeEntries(entries: KnowledgeBaseEntry[]): KnowledgeBaseEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function updateToolIoSummary(artifact: RunArtifact, event: Extract<RunArtifact['toolEvents'][number], { type: 'tool_use.start' | 'tool_use.delta' | 'tool_use.end' }>): void {
  let summary = artifact.toolIoSummaries.find((item) => item.toolCallId === event.toolCallId);
  if (!summary) {
    summary = { toolCallId: event.toolCallId, inputChars: 0, outputChars: 0, inputTruncated: false, outputTruncated: false };
    artifact.toolIoSummaries.push(summary);
  }
  if (event.type === 'tool_use.start') {
    summary.toolName = event.toolName;
    return;
  }
  if (event.type === 'tool_use.delta') {
    if (event.stream === 'input') {
      summary.inputChars += event.delta.length;
      summary.inputTruncated ||= isLikelyTruncatedToolText(event.delta);
    } else {
      summary.outputChars += event.delta.length;
      summary.outputTruncated ||= isLikelyTruncatedToolText(event.delta);
    }
    return;
  }
  if (event.outputText) {
    summary.outputChars += event.outputText.length;
    summary.outputTruncated ||= isLikelyTruncatedToolText(event.outputText);
  }
}

function isLikelyTruncatedToolText(value: string): boolean {
  return value.includes('[truncated]') || value.includes('工具结果过大已省略') || value.includes('[data removed]') || value.includes('[binary data removed]');
}

function suggestToolRetentionPolicy(artifact: RunArtifact, sensitiveFieldRules: NonNullable<EvalFixture['sensitiveFieldRules']> = defaultSensitiveFieldRules()): NonNullable<EvalFixture['toolRetentionPolicy']> {
  const ioByCallId = collectToolIo(artifact.toolEvents);
  return artifact.toolIoSummaries.map((summary) => {
    const detectedSensitivity = inferToolSensitivity(summary.toolName);
    const io = ioByCallId.get(summary.toolCallId);
    const matchedSensitiveRules = matchSensitiveFieldRules(`${io?.input ?? ''}\n${io?.output ?? ''}`, sensitiveFieldRules);
    const sensitivity = matchedSensitiveRules.length > 0 ? 'high' : detectedSensitivity;
    const retention = recommendToolRetention(summary, sensitivity);
    return {
      toolCallId: summary.toolCallId,
      toolName: summary.toolName,
      retention,
      sensitivity,
      reason: toolRetentionReason(summary, sensitivity, retention, matchedSensitiveRules),
      matchedSensitiveRules,
    };
  });
}

function inferToolSensitivity(toolName: string | undefined): 'low' | 'medium' | 'high' {
  if (!toolName) return 'medium';
  if (/write|memory|wechat|image|global/i.test(toolName)) return 'high';
  if (/read|retrieve|recall/i.test(toolName)) return 'medium';
  return 'low';
}

function recommendToolRetention(summary: RunArtifact['toolIoSummaries'][number], sensitivity: 'low' | 'medium' | 'high'): 'full' | 'excerpt_hash' | 'summary_hash' | 'drop' {
  const total = summary.inputChars + summary.outputChars;
  if (sensitivity === 'high' || summary.inputTruncated || summary.outputTruncated || total > 20_000) return 'summary_hash';
  if (total > 4_000) return 'excerpt_hash';
  return 'full';
}

function toolRetentionReason(summary: RunArtifact['toolIoSummaries'][number], sensitivity: 'low' | 'medium' | 'high', retention: 'full' | 'excerpt_hash' | 'summary_hash' | 'drop', matchedSensitiveRules: string[] = []): string {
  const total = summary.inputChars + summary.outputChars;
  if (matchedSensitiveRules.length > 0) return `sensitive field detected (${matchedSensitiveRules.join(', ')}), totalChars=${total}`;
  if (retention === 'summary_hash') return `sensitivity=${sensitivity}, totalChars=${total}, truncated=${summary.inputTruncated || summary.outputTruncated}`;
  if (retention === 'excerpt_hash') return `large tool IO, totalChars=${total}`;
  return `small low-risk tool IO, totalChars=${total}`;
}

function defaultSensitiveFieldRules(): NonNullable<EvalFixture['sensitiveFieldRules']> {
  return [
    { id: 'api-key', pattern: '\\bapi[_-]?key\\b', enabled: true },
    { id: 'authorization', pattern: '\\bauthorization\\b|\\bbearer\\s+[a-z0-9._-]+', enabled: true },
    { id: 'token', pattern: '\\b(access|refresh)[_-]?token\\b', enabled: true },
    { id: 'secret', pattern: '\\bsecret\\b', enabled: true },
    { id: 'password', pattern: '\\bpassword\\b', enabled: true },
    { id: 'cookie', pattern: '\\bcookie\\b', enabled: true },
  ];
}

function matchSensitiveFieldRules(value: string, rules: NonNullable<EvalFixture['sensitiveFieldRules']>): string[] {
  return rules
    .filter((rule) => rule.enabled)
    .filter((rule) => {
      try {
        return new RegExp(rule.pattern, 'i').test(value);
      } catch {
        return false;
      }
    })
    .map((rule) => rule.id);
}

function buildToolRetentionArtifacts(
  artifact: RunArtifact,
  policy: NonNullable<EvalFixture['toolRetentionPolicy']>,
): NonNullable<EvalFixture['toolRetentionArtifacts']> {
  const ioByCallId = collectToolIo(artifact.toolEvents);
  return policy.map((item) => {
    const io = ioByCallId.get(item.toolCallId) ?? { input: '', output: '' };
    return buildToolRetentionArtifact(item, io.input, io.output);
  });
}

function collectToolIo(events: RunArtifact['toolEvents']): Map<string, { input: string; output: string; toolName?: string }> {
  const byCallId = new Map<string, { input: string; output: string; toolName?: string }>();
  for (const event of events) {
    if (event.type !== 'tool_use.start' && event.type !== 'tool_use.delta' && event.type !== 'tool_use.end') continue;
    const item = byCallId.get(event.toolCallId) ?? { input: '', output: '' };
    if (event.type === 'tool_use.start') {
      item.toolName = event.toolName;
    } else if (event.type === 'tool_use.delta') {
      if (event.stream === 'input') item.input += event.delta;
      if (event.stream === 'output') item.output += event.delta;
    } else if (event.outputText) {
      item.output += event.outputText;
    }
    byCallId.set(event.toolCallId, item);
  }
  return byCallId;
}

function buildToolRetentionArtifact(
  policy: NonNullable<EvalFixture['toolRetentionPolicy']>[number],
  input: string,
  output: string,
): NonNullable<EvalFixture['toolRetentionArtifacts']>[number] {
  const base = {
    toolCallId: policy.toolCallId,
    toolName: policy.toolName,
    retention: policy.retention,
    inputChars: input.length,
    outputChars: output.length,
  };
  if (policy.retention === 'drop') {
    return { ...base, inputHash: hashText(input), outputHash: hashText(output), dropped: true };
  }
  if (policy.retention === 'summary_hash') {
    return {
      ...base,
      inputSummary: summarizeToolText(input),
      inputHash: hashText(input),
      outputSummary: summarizeToolText(output),
      outputHash: hashText(output),
    };
  }
  if (policy.retention === 'excerpt_hash') {
    return {
      ...base,
      inputExcerpt: excerptToolText(input),
      inputHash: hashText(input),
      outputExcerpt: excerptToolText(output),
      outputHash: hashText(output),
    };
  }
  return {
    ...base,
    inputExcerpt: input,
    inputHash: hashText(input),
    outputExcerpt: output,
    outputHash: hashText(output),
  };
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function excerptToolText(value: string): string {
  if (value.length <= 1_200) return value;
  return `${value.slice(0, 700)}\n...[${value.length - 1_100} chars omitted]...\n${value.slice(-400)}`;
}

function summarizeToolText(value: string): string {
  if (!value) return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  const head = compact.slice(0, 220);
  const tail = compact.length > 420 ? compact.slice(-160) : '';
  return tail ? `${head} ... ${tail}` : head;
}

function suggestAssertionsFromArtifact(artifact: RunArtifact): Record<string, unknown> {
  const createdOrModified = artifact.fileDiff
    .filter((diff) => diff.change === 'created' || diff.change === 'modified')
    .map((diff) => diff.path);
  const created = artifact.fileDiff
    .filter((diff) => diff.change === 'created')
    .map((diff) => diff.path);
  const modified = artifact.fileDiff
    .filter((diff) => diff.change === 'modified')
    .map((diff) => diff.path);
  const toolNames = artifact.toolEvents
    .filter((event): event is Extract<RunArtifact['toolEvents'][number], { type: 'tool_use.start' }> => event.type === 'tool_use.start')
    .map((event) => event.toolName);
  const agentPhases = artifact.streamEvents
    .filter((event): event is Extract<RunArtifact['streamEvents'][number], { type: 'agent.step.start' }> => event.type === 'agent.step.start')
    .map((event) => `${event.agentId}:${event.phase}`);
  const reviewerPassed = artifact.streamEvents.some((event) => event.type === 'agent.step.end' && event.agentId === 'reviewer-agent' && event.status === 'passed');
  const workflowPassed = artifact.streamEvents.some((event) => event.type === 'agent.workflow.end' && event.status === 'passed');
  const markdown = artifact.changedFiles
    .filter((file) => file.change !== 'deleted' && file.path.endsWith('.md') && typeof file.content === 'string')
    .map((file) => ({
      path: file.path,
      requiredHeadings: extractMarkdownHeadings(file.content ?? ''),
    }))
    .filter((assertion) => assertion.requiredHeadings.length > 0);
  const manifestAssertions = suggestManifestAssertions(artifact.productId, artifact.fileDiff.map((diff) => diff.path));
  return {
    files: {
      mustCreate: created,
      mustModify: modified,
      mustCreateOrModify: createdOrModified,
    },
    markdown,
    toolEvents: {
      mustCall: [...new Set(toolNames)],
      mustCallInOrder: [...new Set(toolNames)],
    },
    workflow: {
      mustPassReviewer: reviewerPassed,
      mustPassWorkflow: workflowPassed,
      mustRunPhases: [...new Set(agentPhases)],
    },
    diff: {
      allowedPaths: [...new Set(artifact.fileDiff.map((diff) => diff.path))],
      allowDeletes: artifact.fileDiff.some((diff) => diff.change === 'deleted'),
    },
    ...(manifestAssertions.length > 0 ? { manifest: manifestAssertions } : {}),
  };
}

function suggestManifestAssertions(productId: string | undefined, changedPaths: string[]): Array<{ artifactType: string; path: string; requiredSections: string[] }> {
  if (!productId) return [];
  const profile = resolveProductProfile(productId);
  const candidates = [
    ...((profile.artifactPaths.sourceAnalysis ?? []).map((path) => ({ artifactType: 'sourceAnalysis', path, requiredSections: [] }))),
    ...((profile.artifactPaths.plan ?? []).map((path) => ({ artifactType: 'plan', path, requiredSections: [] }))),
    { artifactType: 'script', path: profile.artifactPaths.script, requiredSections: [] },
  ];
  return candidates.filter((candidate) => changedPaths.includes(candidate.path));
}

function resolveActualFileChange(
  state: HarnessState,
  snapshotId: string | undefined,
  filePath: string,
  reportedChange: 'created' | 'modified' | 'deleted',
): 'created' | 'modified' | 'deleted' {
  if (reportedChange === 'deleted') return reportedChange;
  const snapshot = snapshotId ? state.snapshots.find((item) => item.id === snapshotId) : undefined;
  if (!snapshot) return reportedChange;
  return snapshot.fileManifest.some((file) => file.path === filePath) ? 'modified' : 'created';
}

function isAssertionReplayEvent(event: RunArtifact['streamEvents'][number]): boolean {
  return event.type === 'tool_use.start'
    || event.type === 'tool_use.delta'
    || event.type === 'tool_use.end'
    || event.type === 'agent.step.start'
    || event.type === 'agent.step.end'
    || event.type === 'agent.review.reject'
    || event.type === 'agent.workflow.end';
}

function extractMarkdownHeadings(content: string): string[] {
  return [...content.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)]
    .map((match) => match[1]?.trim())
    .filter((heading): heading is string => Boolean(heading))
    .slice(0, 12);
}

async function captureChangedFile(
  store: WorkspaceStore,
  projectId: string,
  filePath: string,
  change: 'created' | 'modified' | 'deleted',
): Promise<RunArtifact['changedFiles'][number] | null> {
  if (change === 'deleted') return { path: filePath, change };
  try {
    const file = await store.readWorkspaceFile(projectId, filePath);
    return {
      path: file.path,
      change,
      content: file.content,
      hash: `sha256:${createHash('sha256').update(file.content).digest('hex')}`,
    };
  } catch {
    return null;
  }
}

async function applyArtifactChangedFiles(workspaceRoot: string, changedFiles: RunArtifact['changedFiles']): Promise<void> {
  for (const file of changedFiles) {
    const targetPath = path.join(workspaceRoot, file.path);
    if (file.change === 'deleted') {
      await rm(targetPath, { force: true, recursive: true });
      continue;
    }
    if (typeof file.content === 'string') {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, 'utf8');
    }
  }
}

async function captureEvalRunChangedFiles(workspaceRoot: string, fileDiff: EvalRun['fileDiff']): Promise<RunArtifact['changedFiles']> {
  const changedFiles: RunArtifact['changedFiles'] = [];
  for (const diff of fileDiff) {
    if (diff.change === 'deleted') {
      changedFiles.push({ path: diff.path, change: diff.change });
      continue;
    }
    const content = await readTextIfExists(path.join(workspaceRoot, diff.path));
    changedFiles.push({
      path: diff.path,
      change: diff.change,
      content: content ?? undefined,
      hash: content === null ? undefined : `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
  }
  return changedFiles;
}

async function replayFixtureExpectations(workspaceRoot: string, fixture: EvalFixture): Promise<EvalRunExecutorResult> {
  await applyArtifactChangedFiles(workspaceRoot, fixture.expectedChangedFiles ?? []);
  return {
    executionMode: 'fixture_replay',
    outputMessage: `Repro EvalRun executed in isolated workspace. V1 fallback runner replays fixture file changes and captured tool events before assertion evaluation.`,
    toolEvents: fixture.expectedToolEvents ?? [],
  };
}

async function executeCustomEvalRun(
  executor: (input: EvalRunExecutorInput) => Promise<EvalRunExecutorResult>,
  input: EvalRunExecutorInput,
): Promise<EvalRunExecutorResult> {
  try {
    const result = await executor(input);
    return { executionMode: 'custom_executor', ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      executionMode: 'custom_executor',
      status: 'error',
      outputMessage: `EvalRun executor failed: ${message}`,
      errorMessage: message,
      toolEvents: [],
    };
  }
}

function diffFileManifests(before: RunInputSnapshotFile[], after: RunInputSnapshotFile[]): EvalRun['fileDiff'] {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  const changes: EvalRun['fileDiff'] = [];
  for (const [filePath, afterFile] of afterByPath) {
    const beforeFile = beforeByPath.get(filePath);
    if (!beforeFile) {
      changes.push({ path: filePath, change: 'created' });
    } else if (beforeFile.hash !== afterFile.hash) {
      changes.push({ path: filePath, change: 'modified' });
    }
  }
  for (const filePath of beforeByPath.keys()) {
    if (!afterByPath.has(filePath)) changes.push({ path: filePath, change: 'deleted' });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeEvalRunProgress(events: EvalRun['toolEvents']): string {
  const lastEvent = events[events.length - 1];
  const toolStarts = events.filter((event) => event.type === 'tool_use.start').length;
  const toolEnds = events.filter((event) => event.type === 'tool_use.end').length;
  const textDeltas = events.filter((event) => event.type === 'text.delta').length;
  const lastText = [...events].reverse().find((event): event is Extract<EvalRun['toolEvents'][number], { type: 'text.delta' }> => event.type === 'text.delta')?.delta;
  const lastTool = [...events].reverse().find((event): event is Extract<EvalRun['toolEvents'][number], { type: 'tool_use.start' | 'tool_use.end' }> => event.type === 'tool_use.start' || event.type === 'tool_use.end');
  const lastToolName = lastTool && 'toolName' in lastTool ? lastTool.toolName : lastTool?.toolCallId;
  const lastDetail = lastTool
    ? `${lastTool.type === 'tool_use.end' ? '工具完成' : '工具调用'}：${lastToolName}`
    : lastText
      ? `最新输出：${lastText.slice(0, 80)}`
      : lastEvent
        ? `最新事件：${lastEvent.type}`
        : '等待执行事件';
  return `EvalRun 正在执行。已收到 ${events.length} 个事件，工具 ${toolEnds}/${toolStarts}，文本片段 ${textDeltas}。${lastDetail}`;
}

async function evaluateAssertions(
  workspaceRoot: string,
  beforeManifest: RunInputSnapshotFile[],
  afterManifest: RunInputSnapshotFile[],
  assertions: Record<string, unknown>,
  toolEvents: EvalRun['toolEvents'],
  productId?: string,
  workspaceManifests: WorkspaceManifest[] = [],
  beforeTextSnapshot: TextSnapshotByPath = new Map(),
): Promise<EvalAssertionResult[]> {
  const diff = diffFileManifests(beforeManifest, afterManifest);
  const results: EvalAssertionResult[] = [];
  const files = isRecord(assertions.files) ? assertions.files : {};
  const markdownAssertions = Array.isArray(assertions.markdown) ? assertions.markdown.filter(isRecord) : [];
  const manifestAssertions = Array.isArray(assertions.manifest) ? assertions.manifest.filter(isRecord) : [];
  const workspaceManifest = resolveWorkspaceManifest(workspaceManifests, productId);
  const toolAssertion = isRecord(assertions.toolEvents) ? assertions.toolEvents : {};
  const workflowAssertion = isRecord(assertions.workflow) ? assertions.workflow : {};
  const diffAssertion = isRecord(assertions.diff) ? assertions.diff : {};

  const mustCreateOrModify = arrayOfStrings(files.mustCreateOrModify);
  for (const filePath of mustCreateOrModify) {
    const changed = diff.find((item) => item.path === filePath && (item.change === 'created' || item.change === 'modified'));
    const exists = afterManifest.some((item) => item.path === filePath);
    const passed = Boolean(changed);
    results.push({
      id: `files.mustCreateOrModify:${filePath}`,
      passed,
      message: passed ? undefined : exists
        ? `断言未满足：${filePath} 存在，但本次 EvalRun 没有创建或修改它。实际变更：${summarizeFileDiffForMessage(diff)}`
        : `断言未满足：${filePath} 不存在，也没有被创建。实际变更：${summarizeFileDiffForMessage(diff)}`,
    });
  }

  const mustNotModify = arrayOfStrings(files.mustNotModify);
  for (const pattern of mustNotModify) {
    const modified = diff.filter((item) => pathMatchesPattern(item.path, pattern));
    results.push({ id: `files.mustNotModify:${pattern}`, passed: modified.length === 0, message: modified.length ? `Modified forbidden paths: ${modified.map((item) => item.path).join(', ')}` : undefined });
  }

  const mustCreate = arrayOfStrings(files.mustCreate);
  for (const filePath of mustCreate) {
    const passed = diff.some((item) => item.path === filePath && item.change === 'created');
    const actual = diff.find((item) => item.path === filePath);
    results.push({ id: `files.mustCreate:${filePath}`, passed, message: passed ? undefined : `断言未满足：期望创建 ${filePath}，实际${actual ? `是 ${actual.change}` : '没有变更'}。实际变更：${summarizeFileDiffForMessage(diff)}` });
  }

  const mustModify = arrayOfStrings(files.mustModify);
  for (const filePath of mustModify) {
    const passed = diff.some((item) => item.path === filePath && item.change === 'modified');
    const actual = diff.find((item) => item.path === filePath);
    results.push({ id: `files.mustModify:${filePath}`, passed, message: passed ? undefined : `断言未满足：期望修改 ${filePath}，实际${actual ? `是 ${actual.change}` : '没有变更'}。实际变更：${summarizeFileDiffForMessage(diff)}` });
  }

  const mustDelete = arrayOfStrings(files.mustDelete);
  for (const filePath of mustDelete) {
    const passed = diff.some((item) => item.path === filePath && item.change === 'deleted');
    const actual = diff.find((item) => item.path === filePath);
    results.push({ id: `files.mustDelete:${filePath}`, passed, message: passed ? undefined : `断言未满足：期望删除 ${filePath}，实际${actual ? `是 ${actual.change}` : '没有变更'}。实际变更：${summarizeFileDiffForMessage(diff)}` });
  }

  const mustNotWrite = arrayOfStrings(files.mustNotWrite);
  for (const pattern of mustNotWrite) {
    const changed = diff.filter((item) => pathMatchesPattern(item.path, pattern));
    results.push({ id: `files.mustNotWrite:${pattern}`, passed: changed.length === 0, message: changed.length ? `Changed forbidden paths: ${changed.map((item) => item.path).join(', ')}` : undefined });
  }

  const allowedPaths = arrayOfStrings(diffAssertion.allowedPaths);
  if (allowedPaths.length > 0) {
    const unexpected = diff.filter((item) => !allowedPaths.some((pattern) => pathMatchesPattern(item.path, pattern)));
    results.push({ id: 'diff.allowedPaths', passed: unexpected.length === 0, message: unexpected.length ? `Unexpected changed paths: ${unexpected.map((item) => item.path).join(', ')}` : undefined });
  }

  if (diffAssertion.allowDeletes === false) {
    const deletes = diff.filter((item) => item.change === 'deleted');
    results.push({ id: 'diff.allowDeletes', passed: deletes.length === 0, message: deletes.length ? `Unexpected deleted paths: ${deletes.map((item) => item.path).join(', ')}` : undefined });
  }

  const allowedChanges = isRecord(diffAssertion.allowedChanges) ? diffAssertion.allowedChanges : {};
  for (const changeType of ['created', 'modified', 'deleted'] as const) {
    const allowedForType = arrayOfStrings(allowedChanges[changeType]);
    if (allowedForType.length === 0) continue;
    const unexpected = diff.filter((item) => item.change === changeType && !allowedForType.some((pattern) => pathMatchesPattern(item.path, pattern)));
    results.push({
      id: `diff.allowedChanges:${changeType}`,
      passed: unexpected.length === 0,
      message: unexpected.length ? `Unexpected ${changeType} paths: ${unexpected.map((item) => item.path).join(', ')}` : undefined,
    });
  }

  for (const [key, predicate] of [
    ['maxChangedFiles', () => diff.length],
    ['maxCreatedFiles', () => diff.filter((item) => item.change === 'created').length],
    ['maxModifiedFiles', () => diff.filter((item) => item.change === 'modified').length],
    ['maxDeletedFiles', () => diff.filter((item) => item.change === 'deleted').length],
  ] as const) {
    const limit = typeof diffAssertion[key] === 'number' ? diffAssertion[key] : undefined;
    if (limit === undefined) continue;
    const count = predicate();
    results.push({
      id: `diff.${key}`,
      passed: count <= limit,
      message: count <= limit ? undefined : `Expected ${key} <= ${limit}, got ${count}`,
    });
  }

  for (const assertion of markdownAssertions) {
    const filePath = typeof assertion.path === 'string' ? assertion.path : '';
    if (!filePath) continue;
    const content = await readTextIfExists(path.join(workspaceRoot, filePath));
    const actualHeadings = content === null ? [] : extractMarkdownHeadings(content);
    const requiredHeadings = arrayOfStrings(assertion.requiredHeadings);
    for (const heading of requiredHeadings) {
      const passed = content !== null && markdownHasHeading(content, heading);
      results.push({ id: `markdown.requiredHeadings:${filePath}:${heading}`, passed, message: passed ? undefined : content === null
        ? `断言未满足：${filePath} 不存在，无法检查标题 ${heading}`
        : `断言未满足：${filePath} 缺少 Markdown 标题 ${heading}。实际标题：${summarizeListForMessage(actualHeadings)}` });
    }
    const requiredText = arrayOfStrings(assertion.requiredText);
    for (const text of requiredText) {
      const passed = content !== null && content.includes(text);
      results.push({ id: `markdown.requiredText:${filePath}:${text}`, passed, message: passed ? undefined : content === null
        ? `断言未满足：${filePath} 不存在，无法检查文本 ${text}`
        : `断言未满足：${filePath} 缺少文本 ${text}。文件长度 ${content.length} 字符。` });
    }
    const forbiddenText = arrayOfStrings(assertion.forbiddenText);
    for (const text of forbiddenText) {
      const passed = content === null || !content.includes(text);
      results.push({ id: `markdown.forbiddenText:${filePath}:${text}`, passed, message: passed ? undefined : `Forbidden text ${text} found in ${filePath}` });
    }
  }

  const markdownSectionAssertions = Array.isArray(diffAssertion.allowedMarkdownSections)
    ? diffAssertion.allowedMarkdownSections.filter(isRecord)
    : [];
  for (const assertion of markdownSectionAssertions) {
    const filePath = typeof assertion.path === 'string' ? assertion.path.trim() : '';
    if (!filePath) continue;
    const sections = arrayOfStrings(assertion.sections);
    if (sections.length === 0) continue;
    const beforeContent = beforeTextSnapshot.has(filePath) ? beforeTextSnapshot.get(filePath) ?? null : await readTextIfExists(path.join(workspaceRoot, filePath));
    const afterContent = await readTextIfExists(path.join(workspaceRoot, filePath));
    const comparison = compareMarkdownOutsideAllowedSections(beforeContent, afterContent, sections);
    results.push({
      id: `diff.allowedMarkdownSections:${filePath}`,
      passed: comparison.outsideUnchanged,
      message: comparison.outsideUnchanged ? undefined : `Unexpected changes outside allowed sections in ${filePath}`,
    });
    if (assertion.forbidSectionDelete !== false) {
      for (const section of sections) {
        const passed = comparison.deletedSections.includes(section) === false;
        results.push({
          id: `diff.forbidMarkdownSectionDelete:${filePath}:${section}`,
          passed,
          message: passed ? undefined : `Allowed section ${section} was deleted from ${filePath}`,
        });
      }
    }
  }

  const markdownTableRowAssertions = Array.isArray(diffAssertion.allowedMarkdownTableRows)
    ? diffAssertion.allowedMarkdownTableRows.filter(isRecord)
    : [];
  for (const assertion of markdownTableRowAssertions) {
    const filePath = typeof assertion.path === 'string' ? assertion.path.trim() : '';
    if (!filePath) continue;
    const keyColumn = typeof assertion.keyColumn === 'string' ? assertion.keyColumn.trim() : '';
    const allowedKeys = arrayOfStrings(assertion.allowedKeys);
    if (!keyColumn || allowedKeys.length === 0) continue;
    const beforeContent = beforeTextSnapshot.has(filePath) ? beforeTextSnapshot.get(filePath) ?? null : await readTextIfExists(path.join(workspaceRoot, filePath));
    const afterContent = await readTextIfExists(path.join(workspaceRoot, filePath));
    const comparison = compareMarkdownTablesOutsideAllowedRows(beforeContent, afterContent, keyColumn, allowedKeys);
    results.push({
      id: `diff.allowedMarkdownTableRows:${filePath}:${keyColumn}`,
      passed: comparison.outsideUnchanged,
      message: comparison.outsideUnchanged ? undefined : `Unexpected table row changes outside allowed ${keyColumn} keys in ${filePath}: ${comparison.changedKeys.join(', ') || 'table structure changed'}`,
    });
    if (assertion.forbidRowDelete !== false) {
      for (const key of allowedKeys) {
        const passed = !comparison.deletedAllowedKeys.includes(key);
        results.push({
          id: `diff.forbidMarkdownTableRowDelete:${filePath}:${keyColumn}:${key}`,
          passed,
          message: passed ? undefined : `Allowed table row ${keyColumn}=${key} was deleted from ${filePath}`,
        });
      }
    }
  }

  const markdownTableCellAssertions = Array.isArray(diffAssertion.allowedMarkdownTableCells)
    ? diffAssertion.allowedMarkdownTableCells.filter(isRecord)
    : [];
  for (const assertion of markdownTableCellAssertions) {
    const filePath = typeof assertion.path === 'string' ? assertion.path.trim() : '';
    if (!filePath) continue;
    const keyColumn = typeof assertion.keyColumn === 'string' ? assertion.keyColumn.trim() : '';
    const allowedKeys = arrayOfStrings(assertion.allowedKeys);
    const allowedColumns = arrayOfStrings(assertion.allowedColumns);
    if (!keyColumn || allowedKeys.length === 0 || allowedColumns.length === 0) continue;
    const beforeContent = beforeTextSnapshot.has(filePath) ? beforeTextSnapshot.get(filePath) ?? null : await readTextIfExists(path.join(workspaceRoot, filePath));
    const afterContent = await readTextIfExists(path.join(workspaceRoot, filePath));
    const comparison = compareMarkdownTablesOutsideAllowedCells(beforeContent, afterContent, keyColumn, allowedKeys, allowedColumns);
    results.push({
      id: `diff.allowedMarkdownTableCells:${filePath}:${keyColumn}`,
      passed: comparison.outsideUnchanged,
      message: comparison.outsideUnchanged ? undefined : `Unexpected table cell changes in ${filePath}: ${comparison.changedCells.join(', ') || 'table structure changed'}`,
    });
    if (assertion.forbidRowDelete !== false) {
      for (const key of allowedKeys) {
        const passed = !comparison.deletedAllowedKeys.includes(key);
        results.push({
          id: `diff.forbidMarkdownTableCellRowDelete:${filePath}:${keyColumn}:${key}`,
          passed,
          message: passed ? undefined : `Allowed table row ${keyColumn}=${key} was deleted from ${filePath}`,
        });
      }
    }
  }

  const markdownParagraphAssertions = Array.isArray(diffAssertion.allowedMarkdownParagraphs)
    ? diffAssertion.allowedMarkdownParagraphs.filter(isRecord)
    : [];
  for (const assertion of markdownParagraphAssertions) {
    const filePath = typeof assertion.path === 'string' ? assertion.path.trim() : '';
    if (!filePath) continue;
    const allowedAnchors = arrayOfStrings(assertion.allowedAnchors);
    if (allowedAnchors.length === 0) continue;
    const beforeContent = beforeTextSnapshot.has(filePath) ? beforeTextSnapshot.get(filePath) ?? null : await readTextIfExists(path.join(workspaceRoot, filePath));
    const afterContent = await readTextIfExists(path.join(workspaceRoot, filePath));
    const comparison = compareMarkdownParagraphsOutsideAllowedAnchors(beforeContent, afterContent, allowedAnchors);
    results.push({
      id: `diff.allowedMarkdownParagraphs:${filePath}`,
      passed: comparison.outsideUnchanged,
      message: comparison.outsideUnchanged ? undefined : `Unexpected paragraph changes outside allowed anchors in ${filePath}: ${comparison.changedAnchors.join(', ') || 'paragraph count changed'}`,
    });
    if (assertion.forbidParagraphDelete !== false) {
      for (const anchor of allowedAnchors) {
        const passed = !comparison.deletedAllowedAnchors.includes(anchor);
        results.push({
          id: `diff.forbidMarkdownParagraphDelete:${filePath}:${anchor}`,
          passed,
          message: passed ? undefined : `Allowed paragraph anchor ${anchor} was deleted from ${filePath}`,
        });
      }
    }
  }

  for (const assertion of manifestAssertions) {
    const artifactType = typeof assertion.artifactType === 'string' ? assertion.artifactType : 'artifact';
    const manifestArtifact = workspaceManifest?.artifactTypes[artifactType];
    const expectedPaths = resolveManifestAssertionPaths(assertion, artifactType, productId, diff.map((item) => item.path), workspaceManifest);
    const hasExplicitRequiredSections = Object.prototype.hasOwnProperty.call(assertion, 'requiredSections');
    const requiredSections = arrayOfStrings(assertion.requiredSections);
    const resolvedRequiredSections = hasExplicitRequiredSections ? requiredSections : manifestArtifact?.requiredSections ?? [];
    if (expectedPaths.length === 0) continue;
    for (const expectedPath of expectedPaths) {
      const exists = afterManifest.some((item) => item.path === expectedPath);
      results.push({ id: `manifest.canonicalPath:${artifactType}:${expectedPath}`, passed: exists, message: exists ? undefined : `Expected canonical ${artifactType} artifact at ${expectedPath}` });
      const content = await readTextIfExists(path.join(workspaceRoot, expectedPath));
      const actualHeadings = content === null ? [] : extractMarkdownHeadings(content);
      for (const heading of resolvedRequiredSections) {
        const passed = content !== null && markdownHasHeading(content, heading);
        results.push({ id: `manifest.requiredSections:${artifactType}:${expectedPath}:${heading}`, passed, message: passed ? undefined : content === null
          ? `断言未满足：${artifactType} 产物 ${expectedPath} 不存在，无法检查 section ${heading}`
          : `断言未满足：${artifactType} 产物 ${expectedPath} 缺少 section ${heading}。实际标题：${summarizeListForMessage(actualHeadings)}` });
      }
      for (const text of arrayOfStrings(assertion.requiredText)) {
        const passed = content !== null && content.includes(text);
        results.push({ id: `manifest.requiredText:${artifactType}:${expectedPath}:${text}`, passed, message: passed ? undefined : `Missing required text ${text} in canonical ${artifactType} artifact ${expectedPath}` });
      }
    }
  }

  if (workspaceManifest) {
    for (const directory of workspaceManifest.requiredDirectories) {
      const exists = afterManifest.some((file) => file.path === directory || file.path.startsWith(`${directory}/`));
      results.push({ id: `manifest.requiredDirectories:${directory}`, passed: exists, message: exists ? undefined : `Expected required directory ${directory}` });
    }
  }

  const mustCall = arrayOfStrings(toolAssertion.mustCall);
  const calledTools = toolEvents
    .filter((event): event is Extract<EvalRun['toolEvents'][number], { type: 'tool_use.start' }> => event.type === 'tool_use.start')
    .map((event) => event.toolName);
  for (const toolName of mustCall) {
    const passed = calledTools.includes(toolName);
    results.push({ id: `toolEvents.mustCall:${toolName}`, passed, message: passed ? undefined : `Expected tool ${toolName} to be called` });
  }

  const mustNotCall = arrayOfStrings(toolAssertion.mustNotCall);
  for (const toolName of mustNotCall) {
    const passed = !calledTools.includes(toolName);
    results.push({ id: `toolEvents.mustNotCall:${toolName}`, passed, message: passed ? undefined : `Forbidden tool ${toolName} was called` });
  }

  const mustCallInOrder = arrayOfStrings(toolAssertion.mustCallInOrder);
  if (mustCallInOrder.length > 0) {
    let cursor = 0;
    for (const toolName of calledTools) {
      if (toolName === mustCallInOrder[cursor]) cursor += 1;
      if (cursor >= mustCallInOrder.length) break;
    }
    const passed = cursor >= mustCallInOrder.length;
    results.push({ id: 'toolEvents.mustCallInOrder', passed, message: passed ? undefined : `Expected tool order ${mustCallInOrder.join(' -> ')}, got ${calledTools.join(' -> ') || 'none'}` });
  }

  const mustRunPhases = arrayOfStrings(workflowAssertion.mustRunPhases);
  const agentPhases = toolEventsAndTraceEvents(toolEvents)
    .filter((event): event is Extract<EvalRun['toolEvents'][number], { type: 'agent.step.start' }> => event.type === 'agent.step.start')
    .map((event) => `${event.agentId}:${event.phase}`);
  for (const phase of mustRunPhases) {
    const passed = agentPhases.includes(phase);
    results.push({ id: `workflow.mustRunPhases:${phase}`, passed, message: passed ? undefined : `Expected workflow phase ${phase}` });
  }

  if (workflowAssertion.mustPassReviewer === true) {
    const passed = toolEventsAndTraceEvents(toolEvents).some((event) => event.type === 'agent.step.end' && event.agentId === 'reviewer-agent' && event.status === 'passed');
    results.push({ id: 'workflow.mustPassReviewer', passed, message: passed ? undefined : 'Expected reviewer-agent to pass' });
  }

  if (workflowAssertion.mustPassWorkflow === true) {
    const passed = toolEventsAndTraceEvents(toolEvents).some((event) => event.type === 'agent.workflow.end' && event.status === 'passed');
    results.push({ id: 'workflow.mustPassWorkflow', passed, message: passed ? undefined : 'Expected workflow to pass' });
  }

  return results;
}

async function collectAssertionTextSnapshot(workspaceRoot: string, assertions: Record<string, unknown>): Promise<TextSnapshotByPath> {
  const paths = new Set<string>();
  const markdownAssertions = Array.isArray(assertions.markdown) ? assertions.markdown.filter(isRecord) : [];
  for (const assertion of markdownAssertions) {
    if (typeof assertion.path === 'string' && assertion.path.trim()) paths.add(assertion.path.trim());
  }
  const diffAssertion = isRecord(assertions.diff) ? assertions.diff : {};
  const markdownSectionAssertions = Array.isArray(diffAssertion.allowedMarkdownSections)
    ? diffAssertion.allowedMarkdownSections.filter(isRecord)
    : [];
  for (const assertion of markdownSectionAssertions) {
    if (typeof assertion.path === 'string' && assertion.path.trim()) paths.add(assertion.path.trim());
  }
  const markdownTableRowAssertions = Array.isArray(diffAssertion.allowedMarkdownTableRows)
    ? diffAssertion.allowedMarkdownTableRows.filter(isRecord)
    : [];
  for (const assertion of markdownTableRowAssertions) {
    if (typeof assertion.path === 'string' && assertion.path.trim()) paths.add(assertion.path.trim());
  }
  const markdownTableCellAssertions = Array.isArray(diffAssertion.allowedMarkdownTableCells)
    ? diffAssertion.allowedMarkdownTableCells.filter(isRecord)
    : [];
  for (const assertion of markdownTableCellAssertions) {
    if (typeof assertion.path === 'string' && assertion.path.trim()) paths.add(assertion.path.trim());
  }
  const markdownParagraphAssertions = Array.isArray(diffAssertion.allowedMarkdownParagraphs)
    ? diffAssertion.allowedMarkdownParagraphs.filter(isRecord)
    : [];
  for (const assertion of markdownParagraphAssertions) {
    if (typeof assertion.path === 'string' && assertion.path.trim()) paths.add(assertion.path.trim());
  }
  const snapshot: TextSnapshotByPath = new Map();
  for (const filePath of paths) {
    snapshot.set(filePath, await readTextIfExists(path.join(workspaceRoot, filePath)));
  }
  return snapshot;
}

function compareMarkdownOutsideAllowedSections(beforeContent: string | null, afterContent: string | null, allowedSections: string[]): { outsideUnchanged: boolean; deletedSections: string[] } {
  if (beforeContent === null || afterContent === null) {
    return { outsideUnchanged: beforeContent === afterContent, deletedSections: beforeContent !== null ? allowedSections : [] };
  }
  const beforeLines = splitMarkdownLines(beforeContent);
  const afterLines = splitMarkdownLines(afterContent);
  const beforeRanges = markdownSectionRanges(beforeLines, allowedSections);
  const afterRanges = markdownSectionRanges(afterLines, allowedSections);
  const deletedSections = allowedSections.filter((section) => beforeRanges.has(section) && !afterRanges.has(section));
  return {
    outsideUnchanged: maskMarkdownSections(beforeLines, beforeRanges) === maskMarkdownSections(afterLines, afterRanges),
    deletedSections,
  };
}

function compareMarkdownTablesOutsideAllowedRows(
  beforeContent: string | null,
  afterContent: string | null,
  keyColumn: string,
  allowedKeys: string[],
): { outsideUnchanged: boolean; changedKeys: string[]; deletedAllowedKeys: string[] } {
  if (beforeContent === null || afterContent === null) {
    return { outsideUnchanged: beforeContent === afterContent, changedKeys: [], deletedAllowedKeys: beforeContent !== null ? allowedKeys : [] };
  }
  const allowed = new Set(allowedKeys);
  const beforeTables = extractMarkdownTables(beforeContent, keyColumn);
  const afterTables = extractMarkdownTables(afterContent, keyColumn);
  if (beforeTables.length !== afterTables.length) {
    return { outsideUnchanged: false, changedKeys: [], deletedAllowedKeys: [] };
  }
  const changedKeys: string[] = [];
  const deletedAllowedKeys: string[] = [];
  for (let index = 0; index < beforeTables.length; index += 1) {
    const beforeRows = beforeTables[index].rows;
    const afterRows = afterTables[index].rows;
    const afterByKey = new Map(afterRows.map((row) => [row.key, row.normalized]));
    const beforeByKey = new Map(beforeRows.map((row) => [row.key, row.normalized]));
    for (const row of beforeRows) {
      const afterRow = afterByKey.get(row.key);
      if (afterRow === undefined) {
        if (allowed.has(row.key)) deletedAllowedKeys.push(row.key);
        else changedKeys.push(row.key);
      } else if (afterRow !== row.normalized && !allowed.has(row.key)) {
        changedKeys.push(row.key);
      }
    }
    for (const row of afterRows) {
      if (!beforeByKey.has(row.key) && !allowed.has(row.key)) changedKeys.push(row.key);
    }
  }
  return { outsideUnchanged: changedKeys.length === 0, changedKeys: [...new Set(changedKeys)], deletedAllowedKeys: [...new Set(deletedAllowedKeys)] };
}

function compareMarkdownTablesOutsideAllowedCells(
  beforeContent: string | null,
  afterContent: string | null,
  keyColumn: string,
  allowedKeys: string[],
  allowedColumns: string[],
): { outsideUnchanged: boolean; changedCells: string[]; deletedAllowedKeys: string[] } {
  if (beforeContent === null || afterContent === null) {
    return { outsideUnchanged: beforeContent === afterContent, changedCells: [], deletedAllowedKeys: beforeContent !== null ? allowedKeys : [] };
  }
  const allowedKeySet = new Set(allowedKeys);
  const allowedColumnSet = new Set(allowedColumns);
  const beforeTables = extractMarkdownTablesWithCells(beforeContent, keyColumn);
  const afterTables = extractMarkdownTablesWithCells(afterContent, keyColumn);
  if (beforeTables.length !== afterTables.length) {
    return { outsideUnchanged: false, changedCells: ['table-count'], deletedAllowedKeys: [] };
  }
  const changedCells: string[] = [];
  const deletedAllowedKeys: string[] = [];
  for (let index = 0; index < beforeTables.length; index += 1) {
    const beforeTable = beforeTables[index];
    const afterTable = afterTables[index];
    if (beforeTable.headers.join('|') !== afterTable.headers.join('|')) {
      changedCells.push(`table-${index + 1}:headers`);
      continue;
    }
    const afterByKey = new Map(afterTable.rows.map((row) => [row.key, row.cells]));
    const beforeByKey = new Map(beforeTable.rows.map((row) => [row.key, row.cells]));
    for (const row of beforeTable.rows) {
      const afterCells = afterByKey.get(row.key);
      if (!afterCells) {
        if (allowedKeySet.has(row.key)) deletedAllowedKeys.push(row.key);
        else changedCells.push(`${row.key}:<deleted>`);
        continue;
      }
      for (const header of beforeTable.headers) {
        const beforeCell = row.cells[header] ?? '';
        const afterCell = afterCells[header] ?? '';
        if (beforeCell === afterCell) continue;
        if (!allowedKeySet.has(row.key) || !allowedColumnSet.has(header)) changedCells.push(`${row.key}:${header}`);
      }
    }
    for (const row of afterTable.rows) {
      if (!beforeByKey.has(row.key)) changedCells.push(`${row.key}:<created>`);
    }
  }
  return { outsideUnchanged: changedCells.length === 0, changedCells: [...new Set(changedCells)], deletedAllowedKeys: [...new Set(deletedAllowedKeys)] };
}

function compareMarkdownParagraphsOutsideAllowedAnchors(
  beforeContent: string | null,
  afterContent: string | null,
  allowedAnchors: string[],
): { outsideUnchanged: boolean; changedAnchors: string[]; deletedAllowedAnchors: string[] } {
  if (beforeContent === null || afterContent === null) {
    return { outsideUnchanged: beforeContent === afterContent, changedAnchors: [], deletedAllowedAnchors: beforeContent !== null ? allowedAnchors : [] };
  }
  const allowed = new Set(allowedAnchors);
  const beforeParagraphs = extractMarkdownParagraphs(beforeContent);
  const afterParagraphs = extractMarkdownParagraphs(afterContent);
  const afterByAnchor = new Map(afterParagraphs.map((paragraph) => [paragraph.anchor, paragraph.normalized]));
  const beforeByAnchor = new Map(beforeParagraphs.map((paragraph) => [paragraph.anchor, paragraph.normalized]));
  const changedAnchors: string[] = [];
  const deletedAllowedAnchors: string[] = [];
  for (const paragraph of beforeParagraphs) {
    const afterParagraph = afterByAnchor.get(paragraph.anchor);
    if (afterParagraph === undefined) {
      if (allowed.has(paragraph.anchor)) deletedAllowedAnchors.push(paragraph.anchor);
      else changedAnchors.push(paragraph.anchor);
    } else if (afterParagraph !== paragraph.normalized && !allowed.has(paragraph.anchor)) {
      changedAnchors.push(paragraph.anchor);
    }
  }
  for (const paragraph of afterParagraphs) {
    if (!beforeByAnchor.has(paragraph.anchor) && !allowed.has(paragraph.anchor)) changedAnchors.push(paragraph.anchor);
  }
  return { outsideUnchanged: changedAnchors.length === 0, changedAnchors: [...new Set(changedAnchors)], deletedAllowedAnchors: [...new Set(deletedAllowedAnchors)] };
}

function extractMarkdownParagraphs(content: string): Array<{ anchor: string; normalized: string }> {
  const paragraphs = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.map((paragraph, index) => {
    const explicitAnchor = /<!--\s*paragraph-id:\s*([a-zA-Z0-9_.:-]+)\s*-->/.exec(paragraph)?.[1];
    const normalized = paragraph.replace(/<!--\s*paragraph-id:\s*[a-zA-Z0-9_.:-]+\s*-->/g, '').replace(/\s+/g, ' ').trim();
    return {
      anchor: explicitAnchor ?? `p${index + 1}:${sha256(normalized).slice(7, 19)}`,
      normalized,
    };
  });
}

function extractMarkdownTables(content: string, keyColumn: string): Array<{ rows: Array<{ key: string; normalized: string }> }> {
  const lines = splitMarkdownLines(content);
  const tables: Array<{ rows: Array<{ key: string; normalized: string }> }> = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isMarkdownTableRow(lines[index]) || !isMarkdownTableDivider(lines[index + 1])) continue;
    const headers = parseMarkdownTableCells(lines[index]);
    const keyIndex = headers.findIndex((header) => header === keyColumn);
    if (keyIndex < 0) continue;
    const rows: Array<{ key: string; normalized: string }> = [];
    let cursor = index + 2;
    while (cursor < lines.length && isMarkdownTableRow(lines[cursor])) {
      const cells = parseMarkdownTableCells(lines[cursor]);
      const key = cells[keyIndex]?.trim();
      if (key) rows.push({ key, normalized: cells.join('|') });
      cursor += 1;
    }
    tables.push({ rows });
    index = cursor;
  }
  return tables;
}

function extractMarkdownTablesWithCells(content: string, keyColumn: string): Array<{ headers: string[]; rows: Array<{ key: string; cells: Record<string, string> }> }> {
  const lines = splitMarkdownLines(content);
  const tables: Array<{ headers: string[]; rows: Array<{ key: string; cells: Record<string, string> }> }> = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isMarkdownTableRow(lines[index]) || !isMarkdownTableDivider(lines[index + 1])) continue;
    const headers = parseMarkdownTableCells(lines[index]);
    const keyIndex = headers.findIndex((header) => header === keyColumn);
    if (keyIndex < 0) continue;
    const rows: Array<{ key: string; cells: Record<string, string> }> = [];
    let cursor = index + 2;
    while (cursor < lines.length && isMarkdownTableRow(lines[cursor])) {
      const cells = parseMarkdownTableCells(lines[cursor]);
      const key = cells[keyIndex]?.trim();
      if (key) {
        rows.push({
          key,
          cells: Object.fromEntries(headers.map((header, headerIndex) => [header, cells[headerIndex] ?? ''])),
        });
      }
      cursor += 1;
    }
    tables.push({ headers, rows });
    index = cursor;
  }
  return tables;
}

function isMarkdownTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isMarkdownTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseMarkdownTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim().replace(/\s+/g, ' '));
}

function splitMarkdownLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function markdownSectionRanges(lines: string[], sectionNames: string[]): Map<string, { start: number; end: number }> {
  const wanted = new Set(sectionNames);
  const headings = lines
    .map((line, index) => {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      return match ? { index, level: match[1].length, title: match[2].trim() } : null;
    })
    .filter((heading): heading is { index: number; level: number; title: string } => Boolean(heading));
  const ranges = new Map<string, { start: number; end: number }>();
  for (const heading of headings) {
    if (!wanted.has(heading.title)) continue;
    const next = headings.find((candidate) => candidate.index > heading.index && candidate.level <= heading.level);
    ranges.set(heading.title, { start: heading.index, end: next ? next.index : lines.length });
  }
  return ranges;
}

function maskMarkdownSections(lines: string[], ranges: Map<string, { start: number; end: number }>): string {
  const masked = [...lines];
  for (const [section, range] of ranges) {
    masked.splice(range.start, range.end - range.start, `<!-- allowed-section:${section} -->`);
  }
  return masked.join('\n');
}

function toolEventsAndTraceEvents(events: EvalRun['toolEvents']): EvalRun['toolEvents'] {
  return events;
}

function resolveManifestAssertionPaths(assertion: Record<string, unknown>, artifactType: string, productId: string | undefined, changedPaths: string[], workspaceManifest?: WorkspaceManifest): string[] {
  const explicitPaths = arrayOfStrings(assertion.paths);
  if (explicitPaths.length > 0) return explicitPaths;
  if (typeof assertion.path === 'string' && assertion.path.trim()) return [assertion.path.trim()];
  const manifestPath = workspaceManifest?.artifactTypes[artifactType]?.canonicalPath;
  if (manifestPath) return [manifestPath];
  if (!productId) return [];
  const profile = resolveProductProfile(productId);
  const artifactPaths = profile.artifactPaths as Record<string, string | string[] | undefined>;
  const configuredPath = artifactPaths[artifactType];
  const paths = Array.isArray(configuredPath) ? configuredPath : typeof configuredPath === 'string' ? [configuredPath] : [];
  const changedCanonicalPaths = paths.filter((candidate) => changedPaths.includes(candidate));
  return changedCanonicalPaths.length > 0 ? changedCanonicalPaths : paths;
}

function resolveWorkspaceManifest(manifests: WorkspaceManifest[], productId: string | undefined): WorkspaceManifest | undefined {
  if (!productId) return undefined;
  return manifests
    .filter((manifest) => manifest.productId === productId && manifest.status === 'active')
    .sort((left, right) => right.templateVersion - left.templateVersion)[0]
    ?? manifests
      .filter((manifest) => manifest.productId === productId)
      .sort((left, right) => right.templateVersion - left.templateVersion)[0];
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function markdownHasHeading(content: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'm').test(content);
}

function summarizeFileDiffForMessage(diff: EvalRun['fileDiff']): string {
  if (diff.length === 0) return '没有文件变更';
  const preview = diff.slice(0, 8).map((item) => `${item.change} ${item.path}`).join('；');
  return diff.length > 8 ? `${preview}；另有 ${diff.length - 8} 个变更` : preview;
}

function summarizeListForMessage(values: string[], limit = 12): string {
  if (values.length === 0) return '未发现标题';
  const preview = values.slice(0, limit).join('；');
  return values.length > limit ? `${preview}；另有 ${values.length - limit} 项` : preview;
}

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (pattern.includes('*')) {
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(filePath);
  }
  return filePath === pattern;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function resolveAgentConfig(state: HarnessState, agentSpec: AgentSpec, workspaceStore?: WorkspaceStore): Promise<EvalRun['resolvedAgentConfig']> {
  const layerConfig = agentSpec.layerConfigRef
    ? state.agentLayerConfigs.find((config) => config.id === agentSpec.layerConfigRef || `${config.id}@${config.version}` === agentSpec.layerConfigRef)
    : state.agentLayerConfigs
      .filter((config) => config.productId === agentSpec.productId && config.status === 'active')
      .sort((left, right) => right.version - left.version)[0];
  const memoryRef = agentSpec.memoryPolicyRef ?? layerConfig?.memoryPolicyRef;
  const retrievalRef = agentSpec.retrievalPolicyRef ?? layerConfig?.retrievalPolicyRef;

  const promptBlockRefs = [...new Set([...(layerConfig?.systemAgent.promptBlockRefs ?? []), ...agentSpec.promptBlockRefs])];
  const skillRefs = agentSpec.skillRefs;
  return {
    agentSpec,
    layerConfig,
    memoryPolicy: memoryRef ? findVersionedRecord(state.memoryPolicies, memoryRef) : undefined,
    retrievalPolicy: retrievalRef ? findVersionedRecord(state.retrievalPolicies, retrievalRef) : undefined,
    promptBlockRefs,
    skillRefs,
    promptBlocks: await resolvePromptBlocks(state, promptBlockRefs, layerConfig, agentSpec),
    skills: await resolveSkillSnapshots(state, skillRefs, layerConfig, workspaceStore),
    toolPolicyRef: agentSpec.toolPolicyRef ?? layerConfig?.toolPolicyRef,
    modelPolicyRef: agentSpec.modelPolicyRef ?? layerConfig?.modelPolicyRef,
    workspaceManifest: resolveWorkspaceManifest(state.workspaceManifests, agentSpec.productId),
  };
}

function resolveActiveAgentConfig(state: HarnessState, productId?: string): EvalRun['resolvedAgentConfig'] | undefined {
  if (!productId) return undefined;
  const agentSpec = state.agentSpecs
    .filter((spec) => spec.productId === productId && spec.status === 'active')
    .sort((left, right) => right.version - left.version)[0];
  if (agentSpec) {
    const layerConfig = agentSpec.layerConfigRef
      ? state.agentLayerConfigs.find((config) => config.id === agentSpec.layerConfigRef || `${config.id}@${config.version}` === agentSpec.layerConfigRef)
      : state.agentLayerConfigs
        .filter((config) => config.productId === agentSpec.productId && config.status === 'active')
        .sort((left, right) => right.version - left.version)[0];
    const memoryRef = agentSpec.memoryPolicyRef ?? layerConfig?.memoryPolicyRef;
    const retrievalRef = agentSpec.retrievalPolicyRef ?? layerConfig?.retrievalPolicyRef;
    return {
      agentSpec,
      layerConfig,
      memoryPolicy: memoryRef ? findVersionedRecord(state.memoryPolicies, memoryRef) : undefined,
      retrievalPolicy: retrievalRef ? findVersionedRecord(state.retrievalPolicies, retrievalRef) : undefined,
      promptBlockRefs: [...new Set([...(layerConfig?.systemAgent.promptBlockRefs ?? []), ...agentSpec.promptBlockRefs])],
      skillRefs: agentSpec.skillRefs,
      toolPolicyRef: agentSpec.toolPolicyRef ?? layerConfig?.toolPolicyRef,
      modelPolicyRef: agentSpec.modelPolicyRef ?? layerConfig?.modelPolicyRef,
      workspaceManifest: resolveWorkspaceManifest(state.workspaceManifests, agentSpec.productId),
    };
  }

  const layerConfig = state.agentLayerConfigs
    .filter((config) => config.productId === productId && config.status === 'active')
    .sort((left, right) => right.version - left.version)[0];
  const memoryRef = layerConfig?.memoryPolicyRef;
  const retrievalRef = layerConfig?.retrievalPolicyRef;
  if (!layerConfig && !memoryRef && !retrievalRef) return undefined;

  return {
    layerConfig,
    memoryPolicy: memoryRef ? findVersionedRecord(state.memoryPolicies, memoryRef) : undefined,
    retrievalPolicy: retrievalRef ? findVersionedRecord(state.retrievalPolicies, retrievalRef) : undefined,
    promptBlockRefs: layerConfig?.systemAgent.promptBlockRefs ?? [],
    skillRefs: [],
    toolPolicyRef: layerConfig?.toolPolicyRef,
    modelPolicyRef: layerConfig?.modelPolicyRef,
    workspaceManifest: resolveWorkspaceManifest(state.workspaceManifests, productId),
  };
}

async function resolvePromptBlocks(state: HarnessState, refs: string[], layerConfig: AgentLayerConfig | undefined, agentSpec: AgentSpec): Promise<NonNullable<EvalRun['resolvedAgentConfig']>['promptBlocks']> {
  return refs.map((ref) => {
    const block = findVersionedRecord(state.promptBlocks, ref);
    if (block) return { ref, content: block.content, contentHash: block.contentHash, source: 'prompt_block' as const };
    const source = agentSpec.promptBlockRefs.includes(ref) ? 'agent_spec' : layerConfig?.systemAgent.promptBlockRefs.includes(ref) ? 'layer_config' : 'missing';
    const content = resolvePromptBlockContent(ref, layerConfig);
    return { ref, content, contentHash: content ? sha256(content) : undefined, source };
  });
}

function resolvePromptBlockContent(ref: string, layerConfig: AgentLayerConfig | undefined): string | undefined {
  if (!layerConfig) return undefined;
  const blocks: string[] = [];
  if (layerConfig.systemAgent.promptBlockRefs.includes(ref) && layerConfig.systemAgent.instructionOverride?.trim()) {
    blocks.push(layerConfig.systemAgent.instructionOverride.trim());
  }
  for (const specialist of layerConfig.specialists) {
    if (specialist.promptBlockRefs.includes(ref) && specialist.instructionOverride?.trim()) {
      blocks.push(specialist.instructionOverride.trim());
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

async function resolveSkillSnapshots(state: HarnessState, skillRefs: AgentSpec['skillRefs'], layerConfig: AgentLayerConfig | undefined, workspaceStore?: WorkspaceStore): Promise<NonNullable<EvalRun['resolvedAgentConfig']>['skills']> {
  const refs = [...skillRefs.map((skill) => ({ ref: `${skill.skillId}${skill.version ? `@${skill.version}` : ''}`, skillId: skill.skillId, expectedHash: skill.contentHash }))];
  for (const specialist of layerConfig?.specialists ?? []) {
    if (!specialist.skillRef) continue;
    const skillId = specialist.skillRef.split('@')[0];
    if (!refs.some((ref) => ref.ref === specialist.skillRef)) refs.push({ ref: specialist.skillRef, skillId, expectedHash: undefined });
  }
  return Promise.all(refs.map(async (ref) => {
    const snapshot = findVersionedRecord(state.skillSnapshots, ref.ref) ?? state.skillSnapshots
      .filter((item) => item.skillId === ref.skillId && item.status === 'active')
      .sort((left, right) => right.version - left.version)[0];
    if (snapshot) return { ref: ref.ref, skillId: ref.skillId, content: snapshot.content, contentHash: snapshot.contentHash, source: 'skill_snapshot' as const };
    const override = layerConfig?.specialists.find((specialist) => specialist.agentId === ref.skillId)?.instructionOverride?.trim();
    if (override) return { ref: ref.ref, skillId: ref.skillId, content: override, contentHash: sha256(override), source: 'agent_config' as const };
    if (workspaceStore) {
      try {
        const content = (await workspaceStore.readGlobalWorkspaceFile(`Agent 配置/skills/${ref.skillId}/SKILL.md`)).content;
        return { ref: ref.ref, skillId: ref.skillId, content, contentHash: sha256(content), source: 'agent_config' as const };
      } catch {
        // Fall through to hash-only evidence below.
      }
    }
    if (ref.expectedHash) return { ref: ref.ref, skillId: ref.skillId, contentHash: ref.expectedHash, source: 'agent_spec_hash' as const };
    return { ref: ref.ref, skillId: ref.skillId, source: 'missing' as const };
  }));
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function findVersionedRecord<T extends { id: string; version: number }>(records: T[], ref: string): T | undefined {
  const [id, versionText] = ref.split('@');
  const version = versionText ? Number(versionText) : undefined;
  return records.find((record) => record.id === id && (version === undefined || record.version === version))
    ?? records.find((record) => record.id === ref);
}

function shouldCopySnapshotPath(projectRoot: string, source: string): boolean {
  const relative = normalizePath(path.relative(projectRoot, source));
  if (!relative || relative === '.') return true;
  return !SNAPSHOT_EXCLUDE_RULES.some((rule) => matchesExcludeRule(relative, rule));
}

function matchesExcludeRule(relativePath: string, rule: string): boolean {
  if (rule.endsWith('/**')) {
    const prefix = rule.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }
  if (rule.startsWith('*.')) {
    return relativePath.endsWith(rule.slice(1));
  }
  return relativePath === rule;
}

async function buildFileManifest(root: string): Promise<RunInputSnapshotFile[]> {
  const files: RunInputSnapshotFile[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizePath(path.relative(root, absolutePath));
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const [fileStat, bytes] = await Promise.all([stat(absolutePath), readFile(absolutePath)]);
        files.push({
          path: relativePath,
          hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          size: fileStat.size,
          mimeType: inferMimeType(relativePath),
        });
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function defaultStoryRubric(): HumanReviewRubric {
  const now = new Date(0).toISOString();
  return {
    id: 'sitcom-story-human-review-v1',
    productId: 'sitcom',
    artifactType: 'story',
    version: 1,
    status: 'active',
    hardChecks: [
      { id: 'has_protagonist_goal', label: '主角目标明确', source: 'program' },
      { id: 'has_obstacle', label: '主要阻力明确', source: 'program' },
      { id: 'has_escalation_chain', label: '存在升级链条', source: 'program' },
      { id: 'writes_canonical_path', label: '写入正式路径', source: 'program' },
    ],
    humanScores: [
      { id: 'causality', label: '因果推进', scale: 5 },
      { id: 'character_consistency', label: '人物一致性', scale: 5 },
      { id: 'comedy_mechanism', label: '喜剧机制', scale: 5 },
      {
        id: 'originality',
        label: '创意度',
        scale: 5,
        subScores: ['premise_freshness', 'mechanism_freshness', 'character_angle_freshness', 'situational_fit', 'setup_payoff_quality'],
      },
      { id: 'performability', label: '可表演性', scale: 5 },
    ],
    decisionRules: {
      minimumAverageScore: 3.5,
      minimumRequiredScores: { causality: 3, character_consistency: 3, comedy_mechanism: 3 },
      requiresHumanDecision: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function syncKnowledgeIndex(store: WorkspaceStore, entries: KnowledgeBaseEntry[]): Promise<void> {
  const lines = [
    'version: 1',
    'entries:',
    ...entries
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((entry) => [
        `  - id: ${yamlScalar(entry.id)}`,
        `    title: ${yamlScalar(entry.title)}`,
        `    path: ${yamlScalar(entry.path)}`,
        `    type: ${entry.type}`,
        `    tags: [${entry.tags.map(yamlScalar).join(', ')}]`,
        `    rightsRisk: ${entry.rightsRisk}`,
        ...(entry.source ? [`    source: ${yamlScalar(entry.source)}`] : []),
        ...(entry.contentHash ? [`    contentHash: ${yamlScalar(entry.contentHash)}`] : []),
        `    updatedAt: ${yamlScalar(entry.updatedAt)}`,
      ]),
    '',
  ];
  await store.writeGlobalWorkspaceFile('知识库/index.yaml', lines.join('\n'));
}

async function ensureKnowledgeCard(store: WorkspaceStore, entry: KnowledgeBaseEntry): Promise<void> {
  if (entry.type === 'inbox') return;
  const cardPath = `知识库/${entry.path}`;
  try {
    await store.readGlobalWorkspaceFile(cardPath);
    return;
  } catch {
    // Create a structured placeholder below. Existing read errors are treated as missing cards.
  }

  const content = [
    '---',
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `tags: [${entry.tags.join(', ')}]`,
    `rightsRisk: ${entry.rightsRisk}`,
    ...(entry.source ? [`source: ${entry.source}`] : []),
    '---',
    '',
    `# ${entry.title}`,
    '',
    '## 机制',
    '',
    '待整理。',
    '',
    '## 适用场景',
    '',
    '- 待整理。',
    '',
    '## 不可复用细节',
    '',
    '- 不复用具体台词。',
    '- 不复用完整桥段。',
    '- 不复用原人物身份。',
    '',
  ].join('\n');
  await store.writeGlobalWorkspaceFile(cardPath, content);
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_.@/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function normalizePath(filePath: string): string {
  return path.normalize(filePath).replaceAll(path.sep, '/');
}

function inferMimeType(filePath: string): string {
  if (/\.md$/i.test(filePath)) return 'text/markdown; charset=utf-8';
  if (/\.txt$/i.test(filePath)) return 'text/plain; charset=utf-8';
  if (/\.json$/i.test(filePath)) return 'application/json; charset=utf-8';
  if (/\.ya?ml$/i.test(filePath)) return 'application/yaml; charset=utf-8';
  if (/\.html?$/i.test(filePath)) return 'text/html; charset=utf-8';
  if (/\.png$/i.test(filePath)) return 'image/png';
  if (/\.jpe?g$/i.test(filePath)) return 'image/jpeg';
  if (/\.webp$/i.test(filePath)) return 'image/webp';
  if (/\.svg$/i.test(filePath)) return 'image/svg+xml';
  return 'application/octet-stream';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
