import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessStore, type HarnessStore } from '../harness/harnessStore';
import { createLangGraphEvalRunExecutor } from '../runs/langGraphRunService';
import { createMockRunService } from '../runs/mockRunService';
import { createWorkspaceStore, type WorkspaceStore } from '../storage/workspaceStore';
import { createHarnessRoutes } from './harness';
import { createRunsRoutes } from './runs';

let root: string;
let app: Hono;
let store: WorkspaceStore;
let harnessStore: HarnessStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-harness-routes-'));
  store = createWorkspaceStore(path.join(root, 'workspaces'));
  harnessStore = createHarnessStore(path.join(root, 'harness'), store);
  app = new Hono()
    .route('/api', createRunsRoutes(createMockRunService(store), undefined, harnessStore))
    .route('/api', createHarnessRoutes(harnessStore));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('harness routes', () => {
  it('seeds product profile prompts as active baseline agent specs', async () => {
    const response = await app.request('/api/harness');

    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary.agentSpecs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'seed_sitcom_story-agent_active_v1', productId: 'sitcom', agentId: 'story-agent', status: 'active' }),
      expect.objectContaining({ id: 'seed_sitcom_character-agent_active_v1', productId: 'sitcom', agentId: 'character-agent', status: 'active' }),
      expect.objectContaining({ id: 'seed_novel-adaptation_adaptation-planner-agent_active_v1', productId: 'novel-adaptation', agentId: 'adaptation-planner-agent', status: 'active' }),
    ]));
    expect(summary.agentLayerConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'seed_sitcom_layer_config', productId: 'sitcom', status: 'active' }),
      expect.objectContaining({ id: 'seed_novel-adaptation_layer_config', productId: 'novel-adaptation', status: 'active' }),
    ]));
  });

  it('captures a full lightweight project snapshot before a run', async () => {
    const project = await store.createProject({ name: 'Harness Snapshot Writers', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '01 人物/老周.md', '# 老周\n\n怕担责但爱面子。');
    await mkdir(path.join(store.getProjectRoot(project.id), 'node_modules', 'ignored'), { recursive: true });
    await writeFile(path.join(store.getProjectRoot(project.id), 'node_modules', 'ignored', 'index.js'), 'ignored', 'utf8');

    const response = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        prompt: '围绕业主群误会写一个故事',
        referencedFiles: [{ path: '01 人物/老周.md', label: '老周' }],
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.run.inputSnapshotId).toMatch(/^snapshot_/);

    const summaryResponse = await app.request('/api/harness');
    expect(summaryResponse.status).toBe(200);
    const summary = await summaryResponse.json();
    expect(summary.snapshots).toHaveLength(1);
    expect(summary.snapshots[0]).toMatchObject({
      id: body.run.inputSnapshotId,
      runId: body.run.id,
      projectId: project.id,
      snapshotMode: 'full_project',
      referencedFiles: [{ path: '01 人物/老周.md', label: '老周' }],
    });
    expect(summary.snapshots[0].fileManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '01 人物/老周.md', hash: expect.stringMatching(/^sha256:/) }),
        expect.objectContaining({ path: 'project.json', hash: expect.stringMatching(/^sha256:/) }),
      ]),
    );
    expect(summary.snapshots[0].fileManifest).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'node_modules/ignored/index.js' })]),
    );
  });

  it('creates an agent spec, fixture, and pending eval run', async () => {
    const project = await store.createProject({ name: 'Harness Fixture Writers', productId: 'sitcom' });
    const runResponse = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写一个社区误会故事', model: 'test-chat-model' }),
    });
    const { run } = await runResponse.json();

    const specResponse = await app.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'draft' }),
    });
    expect(specResponse.status).toBe(201);
    const spec = await specResponse.json();

    const fixtureResponse = await app.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: run.inputSnapshotId, target: 'story-agent-workflow', tags: ['regression'] }),
    });
    expect(fixtureResponse.status).toBe(201);
    const fixture = await fixtureResponse.json();
    expect(fixture).toMatchObject({ sourceRunId: run.id, sourceSnapshotId: run.inputSnapshotId, target: 'story-agent-workflow' });

    const evalRunResponse = await app.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });
    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      fixtureId: fixture.id,
      agentSpecId: spec.id,
      runMode: 'repro',
      status: 'passed',
    });
  });

  it('creates versioned prompt blocks and skill snapshots', async () => {
    const promptResponse = await app.request('/api/harness/prompt-blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        status: 'draft',
        title: 'Story quality gate',
        scope: 'quality',
        content: 'reject weak escalation',
      }),
    });
    expect(promptResponse.status).toBe(201);
    const promptBlock = await promptResponse.json();
    expect(promptBlock).toMatchObject({ version: 1, contentHash: expect.stringMatching(/^sha256:/) });

    const nextPromptResponse = await app.request(`/api/harness/prompt-blocks/${promptBlock.id}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'reject weak escalation and missing consequence', status: 'candidate' }),
    });
    expect(nextPromptResponse.status).toBe(201);
    const nextPromptBlock = await nextPromptResponse.json();
    expect(nextPromptBlock).toMatchObject({ id: promptBlock.id, version: 2, status: 'candidate', contentHash: expect.stringMatching(/^sha256:/) });
    expect(nextPromptBlock.contentHash).not.toBe(promptBlock.contentHash);

    const promptDiffResponse = await app.request(`/api/harness/prompt-blocks/${promptBlock.id}/diff`);
    expect(promptDiffResponse.status).toBe(200);
    const promptDiff = await promptDiffResponse.json();
    expect(promptDiff).toMatchObject({ recordType: 'prompt_block', id: promptBlock.id, previousVersion: 1, nextVersion: 2, changed: true });
    expect(promptDiff.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'removed', text: 'reject weak escalation' }),
      expect.objectContaining({ change: 'added', text: 'reject weak escalation and missing consequence' }),
    ]));

    const activePromptResponse = await app.request(`/api/harness/prompt-blocks/${promptBlock.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, status: 'active' }),
    });
    expect(activePromptResponse.status).toBe(200);
    await expect(activePromptResponse.json()).resolves.toMatchObject({ id: promptBlock.id, version: 2, status: 'active' });

    const skillResponse = await app.request('/api/harness/skill-snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        skillId: 'story-agent',
        status: 'draft',
        source: 'manual',
        content: '# Story Agent\n\nWrite story.',
      }),
    });
    expect(skillResponse.status).toBe(201);
    const skillSnapshot = await skillResponse.json();
    const nextSkillResponse = await app.request(`/api/harness/skill-snapshots/${skillSnapshot.id}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Story Agent\n\nWrite stronger story.', status: 'candidate' }),
    });
    expect(nextSkillResponse.status).toBe(201);
    const nextSkillSnapshot = await nextSkillResponse.json();
    expect(nextSkillSnapshot).toMatchObject({ id: skillSnapshot.id, skillId: 'story-agent', version: 2, status: 'candidate', contentHash: expect.stringMatching(/^sha256:/) });
    expect(nextSkillSnapshot.contentHash).not.toBe(skillSnapshot.contentHash);

    const skillDiffResponse = await app.request(`/api/harness/skill-snapshots/${skillSnapshot.id}/diff`);
    expect(skillDiffResponse.status).toBe(200);
    const skillDiff = await skillDiffResponse.json();
    expect(skillDiff).toMatchObject({ recordType: 'skill_snapshot', id: skillSnapshot.id, previousVersion: 1, nextVersion: 2, changed: true });
    expect(skillDiff.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'removed', text: 'Write story.' }),
      expect.objectContaining({ change: 'added', text: 'Write stronger story.' }),
    ]));

    const activeSkillResponse = await app.request(`/api/harness/skill-snapshots/${skillSnapshot.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, status: 'active' }),
    });
    expect(activeSkillResponse.status).toBe(200);
    await expect(activeSkillResponse.json()).resolves.toMatchObject({ id: skillSnapshot.id, version: 2, status: 'active' });

    const summaryResponse = await app.request('/api/harness');
    const summary = await summaryResponse.json();
    expect(summary.promptBlocks.filter((block: { id: string; status: string }) => block.id === promptBlock.id && block.status === 'active')).toHaveLength(1);
    expect(summary.skillSnapshots.filter((snapshot: { id: string; status: string }) => snapshot.id === skillSnapshot.id && snapshot.status === 'active')).toHaveLength(1);
  });

  it('persists run artifacts, creates fixtures from artifacts, evaluates assertions, stores human review, and activates specs', async () => {
    const project = await store.createProject({ name: 'Harness Artifact Writers', productId: 'novel-adaptation' });
    const runResponse = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写一个社区误会故事', model: 'test-chat-model' }),
    });
    const { run } = await runResponse.json();
    await harnessStore.recordRunArtifactEvent({
      runId: run.id,
      projectId: project.id,
      inputSnapshotId: run.inputSnapshotId,
      model: run.model,
      prompt: run.prompt,
      event: { type: 'tool_use.start', runId: run.id, emittedAt: new Date().toISOString(), toolCallId: 'tool-sensitive-search', toolName: 'searchNotes' },
    });
    await harnessStore.recordRunArtifactEvent({
      runId: run.id,
      projectId: project.id,
      inputSnapshotId: run.inputSnapshotId,
      model: run.model,
      prompt: run.prompt,
      event: { type: 'tool_use.delta', runId: run.id, emittedAt: new Date().toISOString(), toolCallId: 'tool-sensitive-search', stream: 'input', delta: 'query=误会 api_key=sk-test-secret', sequence: 1 },
    });
    await harnessStore.recordRunArtifactEvent({
      runId: run.id,
      projectId: project.id,
      inputSnapshotId: run.inputSnapshotId,
      model: run.model,
      prompt: run.prompt,
      event: { type: 'tool_use.end', runId: run.id, emittedAt: new Date().toISOString(), toolCallId: 'tool-sensitive-search', status: 'succeeded', outputText: 'ok', errorMessage: null },
    });

    const artifactResponse = await app.request(`/api/harness/run-artifacts/${run.id}`);
    expect(artifactResponse.status).toBe(200);
    const artifact = await artifactResponse.json();
    expect(artifact).toMatchObject({
      runId: run.id,
      inputSnapshotId: run.inputSnapshotId,
      status: 'success',
      model: 'test-chat-model',
      modelParams: { model: 'test-chat-model', maxSteps: 1, source: 'run_input' },
    });
    expect(artifact.fileDiff).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '02 改编方案/01 第一集/单集改编方案.md', change: 'modified' }),
    ]));
    expect(artifact.toolIoSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'writeWorkspaceFile', inputChars: expect.any(Number), outputChars: 0, inputTruncated: false, outputTruncated: false }),
    ]));
    expect(artifact.toolIoSummaries.find((summary: { toolName?: string }) => summary.toolName === 'writeWorkspaceFile')?.inputChars).toBeGreaterThan(0);

    const fixtureFromArtifactResponse = await app.request(`/api/harness/run-artifacts/${run.id}/eval-fixtures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'adaptation-planner-agent-workflow' }),
    });
    expect(fixtureFromArtifactResponse.status).toBe(201);
    const fixture = await fixtureFromArtifactResponse.json();
    expect(fixture).toMatchObject({ sourceRunId: run.id, sourceSnapshotId: run.inputSnapshotId });
    expect(fixture.toolRetentionPolicy).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'writeWorkspaceFile', retention: 'summary_hash', sensitivity: 'high' }),
      expect.objectContaining({ toolName: 'searchNotes', retention: 'summary_hash', sensitivity: 'high', reason: expect.stringContaining('sensitive field detected'), matchedSensitiveRules: expect.arrayContaining(['api-key']) }),
    ]));
    expect(fixture.sensitiveFieldRules).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'api-key', enabled: true })]));
    expect(fixture.toolRetentionArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: 'writeWorkspaceFile',
        retention: 'summary_hash',
        inputSummary: expect.stringContaining('content omitted'),
        inputHash: expect.stringMatching(/^sha256:/),
        inputChars: expect.any(Number),
        outputHash: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({
        toolName: 'searchNotes',
        retention: 'summary_hash',
        inputSummary: expect.stringContaining('api_key'),
        inputHash: expect.stringMatching(/^sha256:/),
      }),
    ]));
    expect(fixture.toolRetentionArtifacts.find((artifact: { toolName?: string }) => artifact.toolName === 'searchNotes')?.inputExcerpt).toBeUndefined();
    expect(fixture.toolRetentionArtifacts.find((artifact: { toolName?: string }) => artifact.toolName === 'writeWorkspaceFile')?.inputExcerpt).toBeUndefined();
    expect(fixture.assertions.files.mustCreateOrModify).toContain('02 改编方案/01 第一集/单集改编方案.md');
    expect(fixture.assertions.files.mustModify).toContain('02 改编方案/01 第一集/单集改编方案.md');
    expect(fixture.assertions.markdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '02 改编方案/01 第一集/单集改编方案.md',
        requiredHeadings: expect.arrayContaining(['01 第一集单集改编方案']),
      }),
    ]));
    expect(fixture.assertions.manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactType: 'plan', path: '02 改编方案/01 第一集/单集改编方案.md' }),
    ]));
    expect(fixture.assertions.workflow).toMatchObject({ mustPassReviewer: true, mustPassWorkflow: true });
    expect(fixture.assertions.workflow.mustRunPhases).toEqual(expect.arrayContaining([
      'adaptation-planner-agent:改编方案',
      'reviewer-agent:方案审稿',
    ]));
    expect(fixture.assertions.diff).toMatchObject({
      allowedPaths: ['02 改编方案/01 第一集/单集改编方案.md'],
      allowDeletes: false,
    });

    const updatedFixtureResponse = await app.request(`/api/harness/eval-fixtures/${fixture.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assertions: { ...fixture.assertions, files: { ...fixture.assertions.files, mustNotWrite: ['01 原著资料/**'] } },
        tags: ['confirmed'],
        toolRetentionPolicy: fixture.toolRetentionPolicy.map((policy: { toolCallId: string }) => ({ ...policy, retention: 'excerpt_hash' })),
        toolRetentionArtifacts: fixture.toolRetentionArtifacts.map((artifact: { toolCallId: string }) => ({ ...artifact, retention: 'excerpt_hash', inputExcerpt: 'manually reviewed excerpt' })),
      }),
    });
    expect(updatedFixtureResponse.status).toBe(200);
    const updatedFixture = await updatedFixtureResponse.json();
    expect(updatedFixture.assertions.files.mustNotWrite).toEqual(['01 原著资料/**']);
    expect(updatedFixture.tags).toEqual(['confirmed']);
    expect(updatedFixture.toolRetentionPolicy).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'writeWorkspaceFile', retention: 'excerpt_hash' }),
    ]));
    expect(updatedFixture.toolRetentionArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'writeWorkspaceFile', retention: 'excerpt_hash', inputExcerpt: 'manually reviewed excerpt' }),
    ]));

    const relaxedRulesResponse = await app.request(`/api/harness/eval-fixtures/${fixture.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sensitiveFieldRules: fixture.sensitiveFieldRules.map((rule: { id: string }) => rule.id === 'api-key' || rule.id === 'secret' ? { ...rule, enabled: false } : rule),
      }),
    });
    expect(relaxedRulesResponse.status).toBe(200);
    const relaxedFixture = await relaxedRulesResponse.json();
    expect(relaxedFixture.toolRetentionPolicy.find((policy: { toolName?: string }) => policy.toolName === 'searchNotes')).toMatchObject({
      sensitivity: 'low',
      retention: 'full',
      matchedSensitiveRules: [],
    });
    expect(fixture.expectedChangedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '02 改编方案/01 第一集/单集改编方案.md', content: expect.stringContaining('# 01 第一集单集改编方案') }),
    ]));

    const specResponse = await app.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'novel-adaptation', agentId: 'adaptation-planner-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await app.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: updatedFixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });
    const evalRun = await evalRunResponse.json();
    expect(evalRun.status).toBe('passed');
    expect(evalRun.fileDiff).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '02 改编方案/01 第一集/单集改编方案.md', change: 'modified' }),
    ]));
    expect(evalRun.assertionResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'files.mustCreateOrModify:02 改编方案/01 第一集/单集改编方案.md', passed: true }),
      expect.objectContaining({ id: 'files.mustModify:02 改编方案/01 第一集/单集改编方案.md', passed: true }),
      expect.objectContaining({ id: 'markdown.requiredHeadings:02 改编方案/01 第一集/单集改编方案.md:01 第一集单集改编方案', passed: true }),
      expect.objectContaining({ id: 'manifest.canonicalPath:plan:02 改编方案/01 第一集/单集改编方案.md', passed: true }),
      expect.objectContaining({ id: 'workflow.mustPassReviewer', passed: true }),
      expect.objectContaining({ id: 'workflow.mustPassWorkflow', passed: true }),
      expect.objectContaining({ id: 'workflow.mustRunPhases:adaptation-planner-agent:改编方案', passed: true }),
      expect.objectContaining({ id: 'diff.allowedPaths', passed: true }),
    ]));

    const reviewResponse = await app.request(`/api/harness/eval-runs/${evalRun.id}/human-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rubricId: 'sitcom-story-human-review-v1',
        rubricVersion: 1,
        reviewer: 'default',
        decision: 'pass',
        scores: { causality: 4, character_consistency: 4, comedy_mechanism: 4, originality: 3, performability: 4 },
        annotations: [
          { path: '02 改编方案/01 第一集/单集改编方案.md', line: 12, assertionId: 'diff.allowedPaths', severity: 'issue', comment: '这里的升级链条仍然偏弱。' },
        ],
        notes: 'fixture creation path works',
      }),
    });
    expect(reviewResponse.status).toBe(200);
    await expect(reviewResponse.json()).resolves.toMatchObject({
      humanReview: {
        decision: 'pass',
        reviewer: 'default',
        annotations: [expect.objectContaining({ path: '02 改编方案/01 第一集/单集改编方案.md', line: 12, severity: 'issue' })],
      },
    });

    const activeResponse = await app.request(`/api/harness/agent-specs/${spec.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', reviewer: 'default', notes: 'publish after eval' }),
    });
    expect(activeResponse.status).toBe(200);
    await expect(activeResponse.json()).resolves.toMatchObject({ id: spec.id, status: 'active', activatedAt: expect.any(String) });

    const summaryAfterRelease = await app.request('/api/harness');
    const releaseSummary = await summaryAfterRelease.json();
    expect(releaseSummary.releaseRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'activate', targetSpecId: spec.id, evalRunIds: [evalRun.id] }),
    ]));

    const rollbackResponse = await app.request(`/api/harness/agent-specs/${spec.id}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forceReason: 'bad_release', auditCategory: 'quality_regression', reviewer: 'default', notes: 'rollback test' }),
    });
    expect(rollbackResponse.status).toBe(200);
    await expect(rollbackResponse.json()).resolves.toMatchObject({ id: spec.id, status: 'active' });
    const rollbackSummaryResponse = await app.request('/api/harness');
    await expect(rollbackSummaryResponse.json()).resolves.toMatchObject({
      releaseRecords: expect.arrayContaining([
        expect.objectContaining({ action: 'rollback', targetSpecId: spec.id, forceReason: 'bad_release', auditCategory: 'quality_regression' }),
      ]),
    });

    const filteredResponse = await app.request('/api/harness/release-records?productId=novel-adaptation&agentId=adaptation-planner-agent&action=rollback&auditCategory=quality_regression&force=true&limit=5');
    expect(filteredResponse.status).toBe(200);
    await expect(filteredResponse.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'rollback', targetSpecId: spec.id, force: true, auditCategory: 'quality_regression' }),
    ]));
  });

  it('rejects activation without a passing reviewed eval run unless forced', async () => {
    const activeResponse = await app.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        agentId: 'story-agent',
        status: 'active',
        promptBlockRefs: ['story-quality@1'],
        skillRefs: [{ skillId: 'story-agent', version: 1, contentHash: 'sha256:old' }],
        memoryPolicyRef: 'memory_policy_old@1',
        retrievalPolicyRef: 'retrieval_policy_old@1',
        toolPolicyRef: 'workspace-safe-write@1',
        modelPolicyRef: 'default-chat-model@1',
      }),
    });
    expect(activeResponse.status).toBe(201);
    const activeSpec = await activeResponse.json();

    const specResponse = await app.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        agentId: 'story-agent',
        status: 'candidate',
        promptBlockRefs: ['story-quality@2'],
        skillRefs: [{ skillId: 'story-agent', version: 2, contentHash: 'sha256:new' }],
        memoryPolicyRef: 'memory_policy_new@1',
        retrievalPolicyRef: 'retrieval_policy_new@1',
        toolPolicyRef: 'workspace-safe-write@2',
        modelPolicyRef: 'default-chat-model@2',
      }),
    });
    const spec = await specResponse.json();

    const rejectedResponse = await app.request(`/api/harness/agent-specs/${spec.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(rejectedResponse.status).toBe(404);
    await expect(rejectedResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining('at least one passed EvalRun'),
    });

    const gateResponse = await app.request(`/api/harness/agent-specs/${spec.id}/release-gate`);
    expect(gateResponse.status).toBe(200);
    await expect(gateResponse.json()).resolves.toMatchObject({
      agentSpecId: spec.id,
      passed: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'has_eval_run', passed: false }),
        expect.objectContaining({ id: 'has_passing_eval_run', passed: false }),
        expect.objectContaining({ id: 'has_positive_human_review', passed: false }),
      ]),
      configChanges: expect.arrayContaining([
        expect.objectContaining({ field: 'promptBlockRefs', changed: true }),
        expect.objectContaining({ field: 'skillRefs', changed: true }),
        expect.objectContaining({ field: 'memoryPolicyRef', changed: true }),
        expect.objectContaining({ field: 'retrievalPolicyRef', changed: true }),
        expect.objectContaining({ field: 'toolPolicyRef', changed: true }),
        expect.objectContaining({ field: 'modelPolicyRef', changed: true }),
      ]),
    });

    const invalidForcedResponse = await app.request(`/api/harness/agent-specs/${spec.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', force: true, forceReason: 'emergency_fix' }),
    });
    expect(invalidForcedResponse.status).toBe(400);
    await expect(invalidForcedResponse.json()).resolves.toMatchObject({ error: 'Invalid agent spec status' });

    const forcedResponse = await app.request(`/api/harness/agent-specs/${spec.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', force: true, forceReason: 'emergency_fix', auditCategory: 'operational_incident', reviewer: 'default', notes: 'emergency override' }),
    });
    expect(forcedResponse.status).toBe(200);
    await expect(forcedResponse.json()).resolves.toMatchObject({ id: spec.id, status: 'active' });

    const summaryResponse = await app.request('/api/harness');
    expect(summaryResponse.status).toBe(200);
    await expect(summaryResponse.json()).resolves.toMatchObject({
      releaseRecords: expect.arrayContaining([
        expect.objectContaining({
          action: 'activate',
          targetSpecId: spec.id,
          previousActiveSpecId: activeSpec.id,
          force: true,
          forceReason: 'emergency_fix',
          auditCategory: 'operational_incident',
          notes: 'emergency override',
          gate: expect.objectContaining({
            passed: false,
            configChanges: expect.arrayContaining([expect.objectContaining({ field: 'skillRefs', changed: true })]),
          }),
        }),
      ]),
    });

    const forcedRecordsResponse = await app.request('/api/harness/release-records?productId=sitcom&agentId=story-agent&force=true&limit=1');
    expect(forcedRecordsResponse.status).toBe(200);
    await expect(forcedRecordsResponse.json()).resolves.toEqual([
      expect.objectContaining({ targetSpecId: spec.id, force: true, forceReason: 'emergency_fix' }),
    ]);

  });

  it('applies a batch human review to multiple eval runs', async () => {
    const project = await store.createProject({ name: 'Harness Batch Review Writers', productId: 'sitcom' });
    const runResponse = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写两个评估样例' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await app.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: run.inputSnapshotId, target: 'story-agent-workflow' }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await app.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();
    const evalRunResponses = await Promise.all([0, 1].map(() => app.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    })));
    const evalRuns = await Promise.all(evalRunResponses.map((response) => response.json()));

    const reviewResponse = await app.request('/api/harness/human-reviews/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        evalRunIds: evalRuns.map((item) => item.id),
        rubricId: 'sitcom-story-human-review-v1',
        rubricVersion: 1,
        reviewer: 'default',
        decision: 'pass',
        scores: { causality: 4, character: 4, comedy: 4, originality: 4, performability: 4 },
        annotations: [{ path: '02 故事/01 第一集/单集大纲.md', severity: 'note', comment: '批量评分备注。' }],
      }),
    });

    expect(reviewResponse.status).toBe(200);
    const reviewed = await reviewResponse.json();
    expect(reviewed).toHaveLength(2);
    expect(reviewed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: evalRuns[0].id, humanReview: expect.objectContaining({ decision: 'pass', reviewer: 'default' }) }),
      expect.objectContaining({ id: evalRuns[1].id, humanReview: expect.objectContaining({ decision: 'pass', reviewer: 'default' }) }),
    ]));
    expect(reviewed[0].humanReview.annotations).toEqual(expect.arrayContaining([expect.objectContaining({ path: '02 故事/01 第一集/单集大纲.md', severity: 'note' })]));
  });

  it('uses an injected eval run executor for isolated execution', async () => {
    const executorRoot = path.join(root, 'executor-workspaces');
    const executorStore = createHarnessStore(path.join(root, 'harness-executor'), store, {
      evalRunExecutor: async ({ workspaceRoot }) => {
        const target = path.join(workspaceRoot, '02 故事', '01 第一集', '单集大纲.md');
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, '# 单集大纲\n\n## 主角目标\n\n证明自己没有误会业主。\n', 'utf8');
        await mkdir(executorRoot, { recursive: true });
        await writeFile(path.join(executorRoot, 'called.txt'), workspaceRoot, 'utf8');
        return { outputMessage: 'executor ran in isolated workspace', toolEvents: [] };
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Executor Writers', productId: 'sitcom' });
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写一个故事' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'story-agent-workflow',
        inputMessages: [{ role: 'user', content: '请根据记忆和知识卡补齐大纲' }],
        assertions: {
          files: { mustCreateOrModify: ['02 故事/01 第一集/单集大纲.md'] },
          markdown: [{ path: '02 故事/01 第一集/单集大纲.md', requiredHeadings: ['主角目标'] }],
        },
      }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });
    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'passed',
      executionMode: 'custom_executor',
      outputMessage: 'executor ran in isolated workspace',
      fileDiff: expect.arrayContaining([expect.objectContaining({ path: '02 故事/01 第一集/单集大纲.md', change: 'modified' })]),
    });
  });

  it('runs the LangGraph eval executor against an isolated fixture workspace', async () => {
    const memoryRecord = {
      id: 'mem-fixture-owner-group',
      namespace: ['viwork', 'sitcom', 'workspaces', 'fixture', 'memories'],
      scope: 'workspace' as const,
      memoryType: 'decision' as const,
      authority: 'user_explicit' as const,
      updateMode: 'append' as const,
      key: 'owner-group-misread',
      content: '用户确认本集必须围绕业主群误会升级，不要改成广场舞比赛。',
      evidenceRefs: [],
      confidence: 1,
      createdByAgent: 'fixture',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      tombstonedAt: null,
    };
    const knowledgeEntry = {
      id: 'kb-fixture-misread-escalation',
      title: '业主群误会升级机制',
      path: 'mechanisms/业主群误会升级机制.md',
      type: 'mechanism' as const,
      tags: ['误会', '群聊'],
      rightsRisk: 'low' as const,
      updatedAt: new Date(0).toISOString(),
    };
    let capturedEvalPrompt = '';
    let capturedInstructions = '';
    const langGraphStore = createHarnessStore(path.join(root, 'harness-langgraph-executor'), store, {
      evalRunExecutor: createLangGraphEvalRunExecutor(store, {
        createAgent: ({ instructions, tools }) => {
          capturedInstructions = instructions;
          return {
            id: 'test-agent',
            name: 'Test Agent',
            async stream(prompt) {
              capturedEvalPrompt = typeof prompt === "string" ? prompt : prompt.map((message) => message.content).join("\n\n");
              await tools.recall_project_memory.invoke({ query: '业主群误会', topK: 3 });
              await tools.retrieve_knowledge_cards.invoke({ query: '业主群误会升级', tags: ['误会'], topK: 3 });
              await tools.write_workspace_file.invoke({
                path: '02 故事/01 第一集/单集大纲.md',
                content: '# 单集大纲\n\n## 主角目标\n\n老周要证明业主群误会不是自己造成的。\n',
              });
              return {
                fullStream: (async function* () {
                  yield { type: 'tool-call' as const, payload: { toolCallId: 'tool-recall', toolName: 'recall_project_memory', args: { query: '业主群误会', topK: 3 } } };
                  yield { type: 'tool-result' as const, payload: { toolCallId: 'tool-recall', toolName: 'recall_project_memory', result: { ok: true } } };
                  yield { type: 'tool-call' as const, payload: { toolCallId: 'tool-knowledge', toolName: 'retrieve_knowledge_cards', args: { query: '业主群误会升级', tags: ['误会'], topK: 3 } } };
                  yield { type: 'tool-result' as const, payload: { toolCallId: 'tool-knowledge', toolName: 'retrieve_knowledge_cards', result: { ok: true } } };
                  yield { type: 'tool-call' as const, payload: { toolCallId: 'tool-write', toolName: 'write_workspace_file', args: { path: '02 故事/01 第一集/单集大纲.md' } } };
                  yield { type: 'tool-result' as const, payload: { toolCallId: 'tool-write', toolName: 'write_workspace_file', result: { ok: true } } };
                  yield { type: 'text-delta' as const, payload: { text: 'isolated langgraph executor wrote story outline' } };
                })(),
              };
            },
            async generate() {
              return { text: 'unused' };
            },
          };
        },
      }),
    });
    const langGraphApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, langGraphStore))
      .route('/api', createHarnessRoutes(langGraphStore));
    const project = await store.createProject({ name: 'Harness LangGraph Executor Writers', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '02 故事/01 第一集/单集大纲.md', '# 旧大纲\n');
    const runResponse = await langGraphApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写一个故事' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await langGraphApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'story-agent-workflow',
        inputMessages: [{ role: 'user', content: '请根据记忆和知识卡补齐大纲' }],
        assertions: {
          files: { mustModify: ['02 故事/01 第一集/单集大纲.md'] },
          markdown: [{ path: '02 故事/01 第一集/单集大纲.md', requiredHeadings: ['主角目标'] }],
          toolEvents: { mustCall: ['recall_project_memory', 'retrieve_knowledge_cards', 'write_workspace_file'] },
        },
        memoryFixture: [memoryRecord],
        knowledgeFixture: [knowledgeEntry],
      }),
    });
    const fixture = await fixtureResponse.json();
    const layerResponse = await langGraphApp.request('/api/harness/agent-layer-configs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        status: 'active',
        systemAgent: {
          agentId: 'system',
          promptBlockRefs: ['eval-system-policy@1'],
          allowedTools: ['recall_project_memory', 'retrieve_knowledge_cards', 'write_workspace_file'],
          instructionOverride: 'EVAL SYSTEM OVERRIDE: obey fixture assertions exactly.',
        },
        specialists: [{
          agentId: 'story-agent',
          skillRef: 'story-agent@2',
          promptBlockRefs: ['sitcom-story-quality@2'],
          defaultEnabled: true,
          allowedTools: ['read_workspace_file', 'write_workspace_file'],
          instructionOverride: 'EVAL STORY OVERRIDE: use owner group misunderstanding.',
        }],
        memoryPolicyRef: 'sitcom-memory-default@1',
        retrievalPolicyRef: 'sitcom-kb-retrieval@1',
        toolPolicyRef: 'workspace-safe-write@2',
        modelPolicyRef: 'eval-test-model',
      }),
    });
    expect(layerResponse.status).toBe(201);
    const layer = await layerResponse.json();
    const specResponse = await langGraphApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        agentId: 'story-agent',
        status: 'candidate',
        layerConfigRef: layer.id,
        promptBlockRefs: ['sitcom-story-quality@2'],
        skillRefs: [{ skillId: 'story-agent', version: 2, contentHash: 'sha256:story-skill' }],
      }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await langGraphApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });

    expect(evalRunResponse.status).toBe(201);
    const evalRun = await evalRunResponse.json();
    expect(evalRun).toMatchObject({
      status: 'passed',
      executionMode: 'langgraph_isolated',
      outputMessage: expect.stringContaining('isolated langgraph executor wrote story outline'),
      fileDiff: expect.arrayContaining([expect.objectContaining({ path: '02 故事/01 第一集/单集大纲.md', change: 'modified' })]),
      assertionResults: expect.arrayContaining([
        expect.objectContaining({ id: 'files.mustModify:02 故事/01 第一集/单集大纲.md', passed: true }),
        expect.objectContaining({ id: 'markdown.requiredHeadings:02 故事/01 第一集/单集大纲.md:主角目标', passed: true }),
        expect.objectContaining({ id: 'toolEvents.mustCall:recall_project_memory', passed: true }),
        expect.objectContaining({ id: 'toolEvents.mustCall:retrieve_knowledge_cards', passed: true }),
      ]),
      toolEvents: expect.arrayContaining([
        expect.objectContaining({ type: 'memory.recall', matches: [expect.objectContaining({ id: memoryRecord.id })] }),
        expect.objectContaining({ type: 'knowledge.retrieve', matches: [expect.objectContaining({ id: knowledgeEntry.id })] }),
      ]),
      resolvedAgentConfig: expect.objectContaining({
        layerConfig: expect.objectContaining({ id: layer.id }),
        modelPolicyRef: 'eval-test-model',
        toolPolicyRef: 'workspace-safe-write@2',
      }),
    });
    expect(evalRun.resolvedAgentConfig.promptBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'eval-system-policy@1', contentHash: expect.stringMatching(/^sha256:/), source: 'layer_config' }),
      expect.objectContaining({ ref: 'sitcom-story-quality@2', contentHash: expect.stringMatching(/^sha256:/) }),
    ]));
    expect(evalRun.resolvedAgentConfig.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'story-agent@2', skillId: 'story-agent', contentHash: expect.stringMatching(/^sha256:/), source: 'agent_config' }),
    ]));
    expect(capturedInstructions).toContain('EVAL SYSTEM OVERRIDE');
    expect(capturedEvalPrompt).toBe('请根据记忆和知识卡补齐大纲');
    expect(capturedEvalPrompt).not.toContain('Agent Harness EvalRun');
    expect(capturedEvalPrompt).not.toContain('程序检查项');
    await expect(store.readWorkspaceFile(project.id, '02 故事/01 第一集/单集大纲.md')).resolves.toMatchObject({
      content: '# 旧大纲\n',
    });
  });

  it('records eval executor errors without throwing the route', async () => {
    const executorStore = createHarnessStore(path.join(root, 'harness-executor-error'), store, {
      evalRunExecutor: async () => {
        throw new Error('isolated runner failed');
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Executor Error Writers', productId: 'sitcom' });
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写一个故事' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: run.inputSnapshotId, target: 'story-agent-workflow' }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });
    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'error',
      executionMode: 'custom_executor',
      errorMessage: 'isolated runner failed',
    });
  });

  it('evaluates workspace manifest paths and detailed diff constraints', async () => {
    const executorStore = createHarnessStore(path.join(root, 'harness-assertions'), store, {
      evalRunExecutor: async ({ workspaceRoot }) => {
        const target = path.join(workspaceRoot, '02 故事', '01 第一集', '单集大纲.md');
        await writeFile(target, '# 单集大纲\n\n## 主角目标\n\n老周要止住业主群误会。\n\n## 主要阻力\n\n每次解释都会引发新截图。\n', 'utf8');
        return { outputMessage: 'assertion executor wrote canonical story plan', toolEvents: [] };
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Assertions Writers', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '02 故事/01 第一集/单集大纲.md', '# 旧大纲\n');
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写一个故事' }),
    });
    const { run } = await runResponse.json();
    const manifestResponse = await executorApp.request('/api/harness/workspace-manifests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        templateVersion: 1,
        status: 'active',
        requiredDirectories: ['01 基本设定', '02 故事', '03 剧本'],
        artifactTypes: {
          plan: { canonicalPath: '02 故事/01 第一集/单集大纲.md', requiredSections: ['主角目标', '主要阻力'] },
        },
        validationRules: ['reviewer_required_before_story_save'],
      }),
    });
    expect(manifestResponse.status).toBe(201);
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'story-agent-workflow',
        assertions: {
          manifest: [{ artifactType: 'plan' }],
          diff: {
            allowedChanges: { modified: ['02 故事/01 第一集/单集大纲.md'] },
            maxChangedFiles: 1,
            maxModifiedFiles: 1,
            maxCreatedFiles: 0,
            maxDeletedFiles: 0,
          },
        },
      }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });

    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'passed',
      assertionResults: expect.arrayContaining([
        expect.objectContaining({ id: 'manifest.canonicalPath:plan:02 故事/01 第一集/单集大纲.md', passed: true }),
        expect.objectContaining({ id: 'manifest.requiredSections:plan:02 故事/01 第一集/单集大纲.md:主角目标', passed: true }),
        expect.objectContaining({ id: 'manifest.requiredSections:plan:02 故事/01 第一集/单集大纲.md:主要阻力', passed: true }),
        expect.objectContaining({ id: 'manifest.requiredDirectories:02 故事', passed: true }),
        expect.objectContaining({ id: 'diff.allowedChanges:modified', passed: true }),
        expect.objectContaining({ id: 'diff.maxChangedFiles', passed: true }),
        expect.objectContaining({ id: 'diff.maxCreatedFiles', passed: true }),
        expect.objectContaining({ id: 'diff.maxDeletedFiles', passed: true }),
      ]),
    });
  });

  it('supports section-scoped markdown diff assertions', async () => {
    const executorStore = createHarnessStore(path.join(root, 'harness-section-diff'), store, {
      evalRunExecutor: async ({ workspaceRoot }) => {
        await writeFile(path.join(workspaceRoot, '02 故事/01 第一集/单集大纲.md'), [
          '# 单集大纲',
          '',
          '## 主角目标',
          '',
          '老周要澄清业主群误会。',
          '',
          '## 主要阻力',
          '',
          '邻居把他的解释当成甩锅。',
          '',
        ].join('\n'), 'utf8');
        return { outputMessage: 'updated allowed section', toolEvents: [] };
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Section Diff', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '02 故事/01 第一集/单集大纲.md', [
      '# 单集大纲',
      '',
      '## 主角目标',
      '',
      '老周要证明自己没看错通知。',
      '',
      '## 主要阻力',
      '',
      '邻居不相信他。',
      '',
    ].join('\n'));
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '只改主角目标' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'story-agent-workflow',
        assertions: {
          diff: {
            allowedMarkdownSections: [
              { path: '02 故事/01 第一集/单集大纲.md', sections: ['主角目标'] },
            ],
          },
        },
      }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });

    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'failed',
      assertionResults: expect.arrayContaining([
        expect.objectContaining({ id: 'diff.allowedMarkdownSections:02 故事/01 第一集/单集大纲.md', passed: false }),
        expect.objectContaining({ id: 'diff.forbidMarkdownSectionDelete:02 故事/01 第一集/单集大纲.md:主角目标', passed: true }),
      ]),
    });
  });

  it('supports markdown table row-scoped diff assertions', async () => {
    const executorStore = createHarnessStore(path.join(root, 'harness-table-row-diff'), store, {
      evalRunExecutor: async ({ workspaceRoot }) => {
        await writeFile(path.join(workspaceRoot, '01 基本设定/人物表.md'), [
          '# 人物表',
          '',
          '| 角色 | 状态 | 备注 |',
          '| --- | --- | --- |',
          '| 老周 | 焦虑 | 想澄清业主群误会 |',
          '| 小林 | 旁观 | 偷偷截图 |',
          '',
        ].join('\n'), 'utf8');
        return { outputMessage: 'updated allowed table row', toolEvents: [] };
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Table Row Diff', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '01 基本设定/人物表.md', [
      '# 人物表',
      '',
      '| 角色 | 状态 | 备注 |',
      '| --- | --- | --- |',
      '| 老周 | 犹豫 | 想证明自己没看错通知 |',
      '| 小林 | 旁观 | 偷偷截图 |',
      '',
    ].join('\n'));
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '只改老周这一行' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'character-agent-workflow',
        assertions: {
          diff: {
            allowedMarkdownTableRows: [
              { path: '01 基本设定/人物表.md', keyColumn: '角色', allowedKeys: ['老周'] },
            ],
          },
        },
      }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'character-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });

    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'passed',
      assertionResults: expect.arrayContaining([
        expect.objectContaining({ id: 'diff.allowedMarkdownTableRows:01 基本设定/人物表.md:角色', passed: true }),
        expect.objectContaining({ id: 'diff.forbidMarkdownTableRowDelete:01 基本设定/人物表.md:角色:老周', passed: true }),
      ]),
    });
  });

  it('supports markdown table cell-scoped diff assertions', async () => {
    const executorStore = createHarnessStore(path.join(root, 'harness-table-cell-diff'), store, {
      evalRunExecutor: async ({ workspaceRoot }) => {
        await writeFile(path.join(workspaceRoot, '01 基本设定/人物表.md'), [
          '# 人物表',
          '',
          '| 角色 | 状态 | 备注 |',
          '| --- | --- | --- |',
          '| 老周 | 焦虑 | 想证明自己没看错通知 |',
          '| 小林 | 旁观 | 偷偷截图 |',
          '',
        ].join('\n'), 'utf8');
        return { outputMessage: 'updated allowed table cell', toolEvents: [] };
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Table Cell Diff', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '01 基本设定/人物表.md', [
      '# 人物表',
      '',
      '| 角色 | 状态 | 备注 |',
      '| --- | --- | --- |',
      '| 老周 | 犹豫 | 想证明自己没看错通知 |',
      '| 小林 | 旁观 | 偷偷截图 |',
      '',
    ].join('\n'));
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '只改老周状态这一格' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'character-agent-workflow',
        assertions: {
          diff: {
            allowedMarkdownTableCells: [
              { path: '01 基本设定/人物表.md', keyColumn: '角色', allowedKeys: ['老周'], allowedColumns: ['状态'] },
            ],
          },
        },
      }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'character-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });

    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'passed',
      assertionResults: expect.arrayContaining([
        expect.objectContaining({ id: 'diff.allowedMarkdownTableCells:01 基本设定/人物表.md:角色', passed: true }),
        expect.objectContaining({ id: 'diff.forbidMarkdownTableCellRowDelete:01 基本设定/人物表.md:角色:老周', passed: true }),
      ]),
    });
  });

  it('supports paragraph-scoped markdown diff assertions', async () => {
    const executorStore = createHarnessStore(path.join(root, 'harness-paragraph-diff'), store, {
      evalRunExecutor: async ({ workspaceRoot }) => {
        await writeFile(path.join(workspaceRoot, '02 故事/01 第一集/单集大纲.md'), [
          '# 单集大纲',
          '',
          '<!-- paragraph-id:goal -->',
          '老周要澄清业主群误会，并在群里给出证据。',
          '',
          '<!-- paragraph-id:obstacle -->',
          '邻居不相信他。',
          '',
        ].join('\n'), 'utf8');
        return { outputMessage: 'updated allowed paragraph', toolEvents: [] };
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Paragraph Diff', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '02 故事/01 第一集/单集大纲.md', [
      '# 单集大纲',
      '',
      '<!-- paragraph-id:goal -->',
      '老周要证明自己没看错通知。',
      '',
      '<!-- paragraph-id:obstacle -->',
      '邻居不相信他。',
      '',
    ].join('\n'));
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '只改 goal 段落' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'story-agent-workflow',
        assertions: {
          diff: {
            allowedMarkdownParagraphs: [
              { path: '02 故事/01 第一集/单集大纲.md', allowedAnchors: ['goal'] },
            ],
          },
        },
      }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });

    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'passed',
      assertionResults: expect.arrayContaining([
        expect.objectContaining({ id: 'diff.allowedMarkdownParagraphs:02 故事/01 第一集/单集大纲.md', passed: true }),
        expect.objectContaining({ id: 'diff.forbidMarkdownParagraphDelete:02 故事/01 第一集/单集大纲.md:goal', passed: true }),
      ]),
    });
  });

  it('rejects markdown table row changes outside the allowed keys', async () => {
    const executorStore = createHarnessStore(path.join(root, 'harness-table-row-diff-fail'), store, {
      evalRunExecutor: async ({ workspaceRoot }) => {
        await writeFile(path.join(workspaceRoot, '01 基本设定/人物表.md'), [
          '# 人物表',
          '',
          '| 角色 | 状态 | 备注 |',
          '| --- | --- | --- |',
          '| 老周 | 焦虑 | 想澄清业主群误会 |',
          '| 小林 | 主动 | 偷偷截图并转发 |',
          '',
        ].join('\n'), 'utf8');
        return { outputMessage: 'updated disallowed table row', toolEvents: [] };
      },
    });
    const executorApp = new Hono()
      .route('/api', createRunsRoutes(createMockRunService(store), undefined, executorStore))
      .route('/api', createHarnessRoutes(executorStore));
    const project = await store.createProject({ name: 'Harness Table Row Diff Fail', productId: 'sitcom' });
    await store.writeWorkspaceFile(project.id, '01 基本设定/人物表.md', [
      '# 人物表',
      '',
      '| 角色 | 状态 | 备注 |',
      '| --- | --- | --- |',
      '| 老周 | 犹豫 | 想证明自己没看错通知 |',
      '| 小林 | 旁观 | 偷偷截图 |',
      '',
    ].join('\n'));
    const runResponse = await executorApp.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '只改老周这一行' }),
    });
    const { run } = await runResponse.json();
    const fixtureResponse = await executorApp.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'character-agent-workflow',
        assertions: {
          diff: {
            allowedMarkdownTableRows: [
              { path: '01 基本设定/人物表.md', keyColumn: '角色', allowedKeys: ['老周'] },
            ],
          },
        },
      }),
    });
    const fixture = await fixtureResponse.json();
    const specResponse = await executorApp.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'character-agent', status: 'candidate' }),
    });
    const spec = await specResponse.json();

    const evalRunResponse = await executorApp.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });

    expect(evalRunResponse.status).toBe(201);
    await expect(evalRunResponse.json()).resolves.toMatchObject({
      status: 'failed',
      assertionResults: expect.arrayContaining([
        expect.objectContaining({ id: 'diff.allowedMarkdownTableRows:01 基本设定/人物表.md:角色', passed: false }),
      ]),
    });
  });

  it('records agent layering, memory, and retrieval policies in eval runs', async () => {
    const project = await store.createProject({ name: 'Harness Policy Writers', productId: 'sitcom' });
    const runResponse = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: '写一个有明确误会升级的故事' }),
    });
    const { run } = await runResponse.json();

    const memoryResponse = await app.request('/api/harness/memory-policies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        status: 'active',
        namespaces: {
          session: ['viwork', 'sitcom', 'sessions', '{sessionId}', 'memories'],
          workspace: ['viwork', 'sitcom', 'workspaces', '{projectId}', 'memories'],
          global: ['viwork', 'sitcom', 'users', '{userId}', 'global', 'memories'],
        },
        recallOrder: ['session', 'workspace', 'global'],
        writeRules: { user_explicit: 'allow', agent_inferred: 'confirm_for_long_term' },
        conflictPolicy: 'formal_file_wins',
        tombstoneRequired: true,
      }),
    });
    expect(memoryResponse.status).toBe(201);
    const memoryPolicy = await memoryResponse.json();

    const retrievalResponse = await app.request('/api/harness/retrieval-policies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        status: 'active',
        enabledTypes: ['mechanism', 'viewpoint', 'joke_pattern'],
        defaultTopK: 5,
        rightsRiskMax: 'medium',
        writeFlow: 'inbox_then_confirm',
        forbiddenUse: ['copy_dialogue', 'copy_full_plot'],
        mockable: true,
      }),
    });
    expect(retrievalResponse.status).toBe(201);
    const retrievalPolicy = await retrievalResponse.json();

    const layerResponse = await app.request('/api/harness/agent-layer-configs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: 'sitcom',
        status: 'active',
        systemAgent: {
          agentId: 'system',
          promptBlockRefs: ['global-routing-policy@1'],
          allowedTools: ['read_workspace_file', 'write_workspace_file', 'delegate_to_specialist_agent'],
        },
        specialists: [
          { agentId: 'story-agent', skillRef: 'story-agent@1', promptBlockRefs: ['sitcom-story-quality@1'], defaultEnabled: true },
          { agentId: 'reviewer-agent', skillRef: 'reviewer-agent@1', promptBlockRefs: ['sitcom-review-rubric@1'], defaultEnabled: true },
        ],
        memoryPolicyRef: `${memoryPolicy.id}@${memoryPolicy.version}`,
        retrievalPolicyRef: `${retrievalPolicy.id}@${retrievalPolicy.version}`,
        toolPolicyRef: 'workspace-safe-write@1',
        modelPolicyRef: 'default-chat-model@1',
      }),
    });
    expect(layerResponse.status).toBe(201);
    const layerConfig = await layerResponse.json();

    const knowledgeResponse = await app.request('/api/harness/knowledge-base-entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'kb-mechanism-owner-group-misread',
        title: '业主群误会升级',
        path: 'mechanisms/误会升级/业主群误会升级.md',
        type: 'mechanism',
        tags: ['误会', '群聊'],
        rightsRisk: 'low',
        contentHash: 'sha256:test',
      }),
    });
    expect(knowledgeResponse.status).toBe(201);
    const knowledgeEntry = await knowledgeResponse.json();
    await expect(store.readGlobalWorkspaceFile('知识库/index.yaml')).resolves.toMatchObject({
      content: expect.stringContaining('kb-mechanism-owner-group-misread'),
    });
    await expect(store.readGlobalWorkspaceFile('知识库/mechanisms/误会升级/业主群误会升级.md')).resolves.toMatchObject({
      content: expect.stringContaining('# 业主群误会升级'),
    });

    const specResponse = await app.request('/api/harness/agent-specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom', agentId: 'story-agent', status: 'candidate', layerConfigRef: layerConfig.id }),
    });
    const spec = await specResponse.json();

    const fixtureResponse = await app.request('/api/harness/eval-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: run.inputSnapshotId,
        target: 'story-agent-workflow',
        knowledgeFixture: [knowledgeEntry],
      }),
    });
    const fixture = await fixtureResponse.json();
    expect(fixture.knowledgeFixture).toHaveLength(1);

    const evalRunResponse = await app.request('/api/harness/eval-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureId: fixture.id, agentSpecId: spec.id, runMode: 'repro' }),
    });
    const evalRun = await evalRunResponse.json();
    expect(evalRun.resolvedAgentConfig).toMatchObject({
      agentSpec: { id: spec.id },
      layerConfig: { id: layerConfig.id },
      memoryPolicy: { id: memoryPolicy.id },
      retrievalPolicy: { id: retrievalPolicy.id },
      promptBlockRefs: expect.arrayContaining(['global-routing-policy@1']),
      toolPolicyRef: 'workspace-safe-write@1',
      modelPolicyRef: 'default-chat-model@1',
    });
  });
});
