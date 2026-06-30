import { useEffect, useState } from 'react';

import { PRODUCT_PROFILES } from '@viwork/shared';
import type { AgentLayerConfig, AgentSpec, AgentSpecReleaseAuditCategory, AgentSpecReleaseForceReason, AgentSpecReleaseGate, EvalRun, HarnessSummary, HarnessVersionDiff, HumanReviewRubric, MemoryPolicy, PromptBlock, RetrievalPolicy, RunInputSnapshot, WorkspaceManifest } from '@viwork/shared';

import type { ApiClient } from '../api';

type HarnessPanelProps = {
  apiClient: ApiClient;
};

type FixtureAssertionKind = 'changed-file' | 'heading' | 'forbidden-write' | 'max-changed' | 'allowed-section';

export function HarnessPanel({ apiClient }: HarnessPanelProps): JSX.Element {
  const [summary, setSummary] = useState<HarnessSummary | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [selectedFixtureId, setSelectedFixtureId] = useState('');
  const [selectedAgentSpecId, setSelectedAgentSpecId] = useState('');
  const [selectedEvalRunId, setSelectedEvalRunId] = useState('');
  const [selectedRunArtifactId, setSelectedRunArtifactId] = useState('');
  const [agentId, setAgentId] = useState('story-agent');
  const [productId, setProductId] = useState(Object.keys(PRODUCT_PROFILES)[0] ?? 'novel-adaptation');
  const [reviewScores, setReviewScores] = useState<Record<string, number>>({});
  const [reviewDecision, setReviewDecision] = useState<'pass' | 'fail' | 'improved' | 'regressed' | 'needs_regression_case'>('pass');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewSubScores, setReviewSubScores] = useState<Record<string, Record<string, number>>>({});
  const [reviewAnnotationPath, setReviewAnnotationPath] = useState('');
  const [reviewAnnotationLine, setReviewAnnotationLine] = useState('');
  const [reviewAnnotationSeverity, setReviewAnnotationSeverity] = useState<'note' | 'issue' | 'blocker'>('issue');
  const [reviewAnnotationComment, setReviewAnnotationComment] = useState('');
  const [reviewAnnotations, setReviewAnnotations] = useState<NonNullable<EvalRun['humanReview']>['annotations']>([]);
  const [releaseGate, setReleaseGate] = useState<AgentSpecReleaseGate | null>(null);
  const [fixtureAssertionsText, setFixtureAssertionsText] = useState('');
  const [fixtureTagsText, setFixtureTagsText] = useState('');
  const [selectedRubricId, setSelectedRubricId] = useState('');
  const [evalRunMode, setEvalRunMode] = useState<EvalRun['runMode']>('repro');
  const [forceReason, setForceReason] = useState<AgentSpecReleaseForceReason>('manual_override');
  const [auditCategory, setAuditCategory] = useState<AgentSpecReleaseAuditCategory>('gate_bypass');
  const [rollbackSourceReleaseId, setRollbackSourceReleaseId] = useState('');
  const [forceNotes, setForceNotes] = useState('');
  const [releaseActionFilter, setReleaseActionFilter] = useState<'all' | 'activate' | 'rollback'>('all');
  const [releaseAuditFilter, setReleaseAuditFilter] = useState<AgentSpecReleaseAuditCategory | 'all'>('all');
  const [releaseForceFilter, setReleaseForceFilter] = useState<'all' | 'forced' | 'normal'>('all');
  const [filteredReleaseRecords, setFilteredReleaseRecords] = useState<HarnessSummary['releaseRecords'] | null>(null);
  const [assertionPath, setAssertionPath] = useState('');
  const [assertionHeading, setAssertionHeading] = useState('');
  const [assertionSection, setAssertionSection] = useState('');
  const [assertionMaxChanged, setAssertionMaxChanged] = useState('1');
  const [assertionKind, setAssertionKind] = useState<FixtureAssertionKind>('changed-file');
  const [promptBlockTitle, setPromptBlockTitle] = useState('Story quality gate');
  const [promptBlockContent, setPromptBlockContent] = useState('Reviewer must reject stories without clear goal, obstacle, escalation, choice, and consequence.');
  const [selectedPromptBlockRef, setSelectedPromptBlockRef] = useState('');
  const [selectedPromptBlockId, setSelectedPromptBlockId] = useState('');
  const [versionDiff, setVersionDiff] = useState<HarnessVersionDiff | null>(null);
  const [showResolvedPreview, setShowResolvedPreview] = useState(false);

  async function loadSummary(): Promise<void> {
    setState('loading');
    setError(null);
    try {
      const next = await apiClient.getHarnessSummary();
      setSummary(next);
      setSelectedSnapshotId((current) => current || next.snapshots[0]?.id || '');
      setSelectedFixtureId((current) => current || next.evalFixtures[0]?.id || '');
      setSelectedAgentSpecId((current) => current || next.agentSpecs[0]?.id || '');
      setSelectedEvalRunId((current) => current || next.evalRuns[0]?.id || '');
      setSelectedRunArtifactId((current) => current || next.runArtifacts[0]?.runId || '');
      setSelectedPromptBlockId((current) => current || next.promptBlocks[0]?.id || '');
      setSelectedRubricId((current) => current || next.humanReviewRubrics.find((rubric) => rubric.productId === productId)?.id || next.humanReviewRubrics[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 Harness 状态失败');
    } finally {
      setState('idle');
    }
  }

  useEffect(() => {
    void loadSummary();
  }, []);

  useEffect(() => {
    const fixture = summary?.evalFixtures.find((item) => item.id === selectedFixtureId);
    setFixtureAssertionsText(fixture ? JSON.stringify(fixture.assertions, null, 2) : '');
    setFixtureTagsText(fixture ? fixture.tags.join(', ') : '');
  }, [selectedFixtureId, summary]);

  useEffect(() => {
    const run = summary?.evalRuns.find((item) => item.id === selectedEvalRunId);
    setReviewAnnotations(run?.humanReview?.annotations ?? []);
  }, [selectedEvalRunId, summary]);

  async function createAgentSpec(): Promise<void> {
    setState('saving');
    setError(null);
    try {
      const baseSpec = activeAgentSpec ?? agentSpecs
        .filter((spec) => spec.productId === productId && spec.agentId === agentId)
        .sort((left, right) => right.version - left.version)[0];
      const nextPromptBlockRefs = uniqueStrings([
        ...(baseSpec?.promptBlockRefs ?? []),
        selectedPromptBlockRef,
      ]);
      const created = await apiClient.createAgentSpec({
        productId,
        agentId,
        status: 'draft',
        layerConfigRef: baseSpec?.layerConfigRef,
        promptBlockRefs: nextPromptBlockRefs,
        skillRefs: baseSpec?.skillRefs ?? [],
        memoryPolicyRef: baseSpec?.memoryPolicyRef,
        retrievalPolicyRef: baseSpec?.retrievalPolicyRef,
        toolPolicyRef: baseSpec?.toolPolicyRef,
        modelPolicyRef: baseSpec?.modelPolicyRef,
        changelog: baseSpec ? `Created from ${baseSpec.id} with selected behavior rule changes.` : 'Created from Agent Harness workflow.',
      });
      setSelectedAgentSpecId(created.id);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 AgentSpec 失败');
    } finally {
      setState('idle');
    }
  }

  async function createDefaults(): Promise<void> {
    setState('saving');
    setError(null);
    try {
      const memoryPolicy = await apiClient.createMemoryPolicy(defaultMemoryPolicy(productId));
      const retrievalPolicy = await apiClient.createRetrievalPolicy(defaultRetrievalPolicy(productId));
      await apiClient.createWorkspaceManifest(defaultWorkspaceManifest(productId));
      const layerConfig = await apiClient.createAgentLayerConfig(defaultLayerConfig(productId, memoryPolicy, retrievalPolicy));
      await apiClient.createKnowledgeBaseEntry({
        id: 'kb-mechanism-owner-group-misread',
        title: '业主群误会升级',
        path: 'mechanisms/误会升级/业主群误会升级.md',
        type: 'mechanism',
        tags: ['误会', '群聊', '升级'],
        rightsRisk: 'low',
      });
      const spec = await apiClient.createAgentSpec({
        productId,
        agentId,
        status: 'draft',
        layerConfigRef: layerConfig.id,
        memoryPolicyRef: `${memoryPolicy.id}@${memoryPolicy.version}`,
        retrievalPolicyRef: `${retrievalPolicy.id}@${retrievalPolicy.version}`,
        promptBlockRefs: [],
        skillRefs: [],
        changelog: 'Created with default harness policies.',
      });
      setSelectedAgentSpecId(spec.id);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化 Harness 默认配置失败');
    } finally {
      setState('idle');
    }
  }

  async function createPromptBlockModel(): Promise<void> {
    if (!promptBlockTitle.trim() || !promptBlockContent.trim()) {
      setError('行为规则标题和内容都需要填写');
      return;
    }
    if (promptBlockTitle === 'Story quality gate' && promptBlockContent === 'Reviewer must reject stories without clear goal, obstacle, escalation, choice, and consequence.') {
      setError('请先修改默认标题或内容，再创建行为规则');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const promptBlock = await apiClient.createPromptBlock({
        productId,
        status: 'draft',
        title: promptBlockTitle,
        scope: 'quality',
        content: promptBlockContent,
      });
      setSelectedPromptBlockId(promptBlock.id);
      setSelectedPromptBlockRef(`${promptBlock.id}@${promptBlock.version}`);
      const spec = await apiClient.createAgentSpec({
        productId,
        agentId,
        status: 'draft',
        promptBlockRefs: [`${promptBlock.id}@${promptBlock.version}`],
        skillRefs: [],
        changelog: 'Created with explicit behavior rule model.',
      });
      setSelectedAgentSpecId(spec.id);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 Agent 行为规则失败');
    } finally {
      setState('idle');
    }
  }

  async function loadPromptBlockDiff(): Promise<void> {
    if (!selectedPromptBlockId) return;
    setState('loading');
    setError(null);
    try {
      setVersionDiff(await apiClient.getPromptBlockDiff(selectedPromptBlockId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 PromptBlock diff 失败');
    } finally {
      setState('idle');
    }
  }

  async function updateSelectedPromptBlockStatus(status: PromptBlock['status']): Promise<void> {
    const block = latestPromptBlock(promptBlocks, selectedPromptBlockId);
    if (!block) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.updatePromptBlockStatus(block.id, { version: block.version, status });
      await loadSummary();
      await loadPromptBlockDiff();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新 PromptBlock 状态失败');
    } finally {
      setState('idle');
    }
  }

  async function archiveSelectedAgentSpec(): Promise<void> {
    if (!selectedAgentSpecId) return;
    const spec = summary?.agentSpecs.find((item) => item.id === selectedAgentSpecId);
    if (spec?.status === 'active') {
      setError('不能从清理入口归档 active AgentSpec；请先发布其他版本或执行回滚');
      return;
    }
    const confirmed = window.confirm('归档只会隐藏这个 draft/candidate AgentSpec，不会删除历史评测记录。确认归档？');
    if (!confirmed) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.deleteAgentSpec(selectedAgentSpecId);
      setSelectedAgentSpecId('');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '归档 AgentSpec 失败');
    } finally {
      setState('idle');
    }
  }

  async function createFixture(): Promise<void> {
    if (!selectedSnapshotId) return;
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.createEvalFixture({
        snapshotId: selectedSnapshotId,
        target: `${agentId}-workflow`,
        tags: ['manual'],
      });
      setSelectedFixtureId(created.id);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 EvalFixture 失败');
    } finally {
      setState('idle');
    }
  }

  async function createFixtureFromArtifact(): Promise<void> {
    if (!selectedRunArtifactId) return;
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.createEvalFixtureFromRunArtifact(selectedRunArtifactId, {
        target: `${agentId}-workflow`,
        tags: ['from-run-artifact'],
      });
      setSelectedFixtureId(created.id);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '从 RunArtifact 创建 EvalFixture 失败');
    } finally {
      setState('idle');
    }
  }

  async function createEvalRun(): Promise<void> {
    if (!selectedFixtureId || !selectedAgentSpecId) return;
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.createEvalRun({ fixtureId: selectedFixtureId, agentSpecId: selectedAgentSpecId, runMode: evalRunMode });
      setSelectedEvalRunId(created.id);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 EvalRun 失败');
    } finally {
      setState('idle');
    }
  }

  async function saveFixtureAssertions(): Promise<void> {
    if (!selectedFixtureId) return;
    setState('saving');
    setError(null);
    try {
      const assertions = JSON.parse(fixtureAssertionsText || '{}') as Record<string, unknown>;
      await apiClient.updateEvalFixture(selectedFixtureId, { assertions });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 Fixture assertions 失败');
    } finally {
      setState('idle');
    }
  }

  async function patchSelectedFixture(input: Parameters<ApiClient['updateEvalFixture']>[1]): Promise<void> {
    if (!selectedFixtureId) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.updateEvalFixture(selectedFixtureId, input);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 Fixture 失败');
    } finally {
      setState('idle');
    }
  }

  async function saveFixtureTags(): Promise<void> {
    const tags = fixtureTagsText.split(',').map((tag) => tag.trim()).filter(Boolean);
    await patchSelectedFixture({ tags });
  }

  async function addFixtureAssertion(): Promise<void> {
    if (!selectedFixtureId) return;
    const current = parseAssertionsText(fixtureAssertionsText);
    const next = structuredClone(current);
    const filePath = assertionPath.trim();
    if ((assertionKind === 'changed-file' || assertionKind === 'heading' || assertionKind === 'forbidden-write' || assertionKind === 'allowed-section') && !filePath) {
      setError('需要先填写文件路径');
      return;
    }
    if (assertionKind === 'changed-file') {
      const files = ensureRecord(next, 'files');
      files.mustCreateOrModify = appendUniqueString(files.mustCreateOrModify, filePath);
    } else if (assertionKind === 'heading') {
      const heading = assertionHeading.trim();
      if (!heading) {
        setError('需要先填写 Markdown 标题');
        return;
      }
      const markdown = Array.isArray(next.markdown) ? next.markdown.filter(isPlainRecord) : [];
      const existing = markdown.find((item) => item.path === filePath);
      if (existing) {
        existing.requiredHeadings = appendUniqueString(existing.requiredHeadings, heading);
      } else {
        markdown.push({ path: filePath, requiredHeadings: [heading] });
      }
      next.markdown = markdown;
    } else if (assertionKind === 'forbidden-write') {
      const files = ensureRecord(next, 'files');
      files.mustNotWrite = appendUniqueString(files.mustNotWrite, filePath);
    } else if (assertionKind === 'allowed-section') {
      const section = assertionSection.trim() || assertionHeading.trim();
      if (!section) {
        setError('需要先填写允许修改的 Markdown section');
        return;
      }
      const diff = ensureRecord(next, 'diff');
      const sections = Array.isArray(diff.allowedMarkdownSections) ? diff.allowedMarkdownSections.filter(isPlainRecord) : [];
      const existing = sections.find((item) => item.path === filePath);
      if (existing) {
        existing.sections = appendUniqueString(existing.sections, section);
      } else {
        sections.push({ path: filePath, sections: [section], forbidSectionDelete: true });
      }
      diff.allowedMarkdownSections = sections;
    } else {
      const limit = Number(assertionMaxChanged);
      if (!Number.isFinite(limit) || limit < 0) {
        setError('最大变更文件数必须是非负数字');
        return;
      }
      const diff = ensureRecord(next, 'diff');
      diff.maxChangedFiles = limit;
    }
    setFixtureAssertionsText(JSON.stringify(next, null, 2));
    await patchSelectedFixture({ assertions: next });
  }

  async function saveHumanReview(): Promise<void> {
    if (!selectedEvalRunId) return;
    const rubric = selectedRubric;
    if (!rubric) {
      setError('没有可用 HumanReviewRubric');
      return;
    }
    setState('saving');
    setError(null);
    try {
      await apiClient.addHumanReview(selectedEvalRunId, {
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        reviewer: 'default',
        decision: reviewDecision,
        scores: buildReviewScores(rubric, reviewScores),
        subScores: buildReviewSubScores(rubric, reviewSubScores),
        annotations: reviewAnnotations,
        notes: reviewNotes || undefined,
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存人工评分失败');
    } finally {
      setState('idle');
    }
  }

  async function saveBatchHumanReviewForSelectedSpec(): Promise<void> {
    const rubric = selectedRubric;
    if (!rubric || !selectedAgentSpecId) return;
    const targetRunIds = selectedSpecRuns.filter((run) => !run.humanReview).map((run) => run.id);
    if (targetRunIds.length === 0) {
      setError('当前 AgentSpec 没有未评分 EvalRun');
      return;
    }
    const confirmed = window.confirm(`将当前评分应用到 ${targetRunIds.length} 个未评分 EvalRun。确定继续？`);
    if (!confirmed) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.addBatchHumanReview({
        evalRunIds: targetRunIds,
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        reviewer: 'default',
        decision: reviewDecision,
        scores: buildReviewScores(rubric, reviewScores),
        subScores: buildReviewSubScores(rubric, reviewSubScores),
        annotations: reviewAnnotations,
        notes: reviewNotes || `Batch review for ${selectedAgentSpecId}`,
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量保存人工评分失败');
    } finally {
      setState('idle');
    }
  }

  function addReviewAnnotation(): void {
    const path = reviewAnnotationPath.trim();
    const comment = reviewAnnotationComment.trim();
    const line = reviewAnnotationLine.trim() ? Number(reviewAnnotationLine) : undefined;
    if (!path || !comment) {
      setError('行备注需要填写文件路径和评论');
      return;
    }
    if (line !== undefined && (!Number.isInteger(line) || line <= 0)) {
      setError('行号必须是正整数');
      return;
    }
    const failedAssertion = selectedEvalRun?.assertionResults.find((result) => !result.passed)?.id;
    setReviewAnnotations((current) => [
      ...(current ?? []),
      { path, line, assertionId: failedAssertion, severity: reviewAnnotationSeverity, comment },
    ]);
    setReviewAnnotationComment('');
    setReviewAnnotationLine('');
    setError(null);
  }

  function removeReviewAnnotation(index: number): void {
    setReviewAnnotations((current) => (current ?? []).filter((_, itemIndex) => itemIndex !== index));
  }

  async function activateSelectedSpec(): Promise<void> {
    if (!selectedAgentSpecId) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.updateAgentSpecStatus(selectedAgentSpecId, 'active', { reviewer: 'default', notes: 'Published from harness panel.' });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布 AgentSpec 失败');
    } finally {
      setState('idle');
    }
  }

  async function forceActivateSelectedSpec(): Promise<void> {
    if (!selectedAgentSpecId) return;
    if (!forceNotes.trim()) {
      setError('强制发布需要填写审计备注');
      return;
    }
    const confirmed = window.confirm('强制发布会绕过 EvalRun 和人工评分 gate，并写入审计记录。确定继续？');
    if (!confirmed) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.updateAgentSpecStatus(selectedAgentSpecId, 'active', {
        force: true,
        forceReason,
        auditCategory,
        reviewer: 'default',
        notes: forceNotes,
      });
      await loadSummary();
      await loadReleaseGate();
    } catch (err) {
      setError(err instanceof Error ? err.message : '强制发布 AgentSpec 失败');
    } finally {
      setState('idle');
    }
  }

  async function loadReleaseGate(): Promise<void> {
    if (!selectedAgentSpecId) return;
    setState('loading');
    setError(null);
    try {
      setReleaseGate(await apiClient.getAgentSpecReleaseGate(selectedAgentSpecId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取发布 gate 失败');
    } finally {
      setState('idle');
    }
  }

  async function rollbackSelectedSpec(): Promise<void> {
    if (!selectedAgentSpecId) return;
    if (!forceNotes.trim()) {
      setError('回滚需要填写审计备注');
      return;
    }
    setState('saving');
    setError(null);
    try {
      await apiClient.rollbackAgentSpec(selectedAgentSpecId, { forceReason, auditCategory, sourceReleaseRecordId: rollbackSourceReleaseId || undefined, reviewer: 'default', notes: forceNotes });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '回滚 AgentSpec 失败');
    } finally {
      setState('idle');
    }
  }

  async function loadFilteredReleaseRecords(): Promise<void> {
    setState('loading');
    setError(null);
    try {
      setFilteredReleaseRecords(await apiClient.listReleaseRecords({
        productId: productId || undefined,
        agentId: agentId || undefined,
        action: releaseActionFilter === 'all' ? undefined : releaseActionFilter,
        auditCategory: releaseAuditFilter === 'all' ? undefined : releaseAuditFilter,
        force: releaseForceFilter === 'all' ? undefined : releaseForceFilter === 'forced',
        limit: 20,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '筛选发布记录失败');
    } finally {
      setState('idle');
    }
  }

  const snapshots = summary?.snapshots ?? [];
  const agentSpecs = summary?.agentSpecs ?? [];
  const fixtures = summary?.evalFixtures ?? [];
  const evalRuns = summary?.evalRuns ?? [];
  const runArtifacts = summary?.runArtifacts ?? [];
  const layerConfigs = summary?.agentLayerConfigs ?? [];
  const memoryPolicies = summary?.memoryPolicies ?? [];
  const retrievalPolicies = summary?.retrievalPolicies ?? [];
  const promptBlocks = summary?.promptBlocks ?? [];
  const workspaceManifests = summary?.workspaceManifests ?? [];
  const knowledgeEntries = summary?.knowledgeBaseEntries ?? [];
  const rubrics = summary?.humanReviewRubrics ?? [];
  const releaseRecords = summary?.releaseRecords ?? [];
  const visibleReleaseRecords = filteredReleaseRecords ?? releaseRecords;
  const productOptions = uniqueStrings([
    ...Object.keys(PRODUCT_PROFILES),
    productId,
    ...agentSpecs.map((spec) => spec.productId),
    ...layerConfigs.map((config) => config.productId),
    ...promptBlocks.map((block) => block.productId),
    ...snapshots.map((snapshot) => snapshot.productId ?? ''),
  ]);
  const agentOptions = uniqueStrings([
    ...((PRODUCT_PROFILES as Record<string, { defaultAgentSkillNames?: string[] }>)[productId]?.defaultAgentSkillNames ?? []),
    ...agentSpecs.filter((spec) => spec.productId === productId).map((spec) => spec.agentId),
    ...layerConfigs.filter((config) => config.productId === productId).flatMap((config) => [config.systemAgent.agentId, ...config.specialists.map((specialist) => specialist.agentId)]),
    agentId,
  ]);
  const promptBlockOptions = promptBlocks.filter((block) => block.productId === productId).sort((left, right) => right.version - left.version);
  const selectedPromptBlock = latestPromptBlock(promptBlocks, selectedPromptBlockId);
  const selectedAgentSpec = agentSpecs.find((spec) => spec.id === selectedAgentSpecId);
  const selectedAgentSpecPreview = selectedAgentSpec ? buildAgentSpecPreview(selectedAgentSpec, { layerConfigs, promptBlocks, memoryPolicies, retrievalPolicies, workspaceManifests }) : null;
  const activeAgentSpec = agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
  const activeAgentSpecPreview = activeAgentSpec ? buildAgentSpecPreview(activeAgentSpec, { layerConfigs, promptBlocks, memoryPolicies, retrievalPolicies, workspaceManifests }) : null;
  const defaultPromptBlock = promptBlocks.find((block) => block.productId === productId && block.status === 'active' && block.scope !== 'tool');
  const defaultPromptBlockRef = defaultPromptBlock ? `${defaultPromptBlock.id}@${defaultPromptBlock.version}` : '';
  const selectedPromptBlockPreview = buildPromptBlockPreview(selectedPromptBlockRef || defaultPromptBlockRef, promptBlocks);
  const hasHarnessBasics = layerConfigs.some((config) => config.productId === productId)
    && memoryPolicies.some((policy) => policy.productId === productId)
    && retrievalPolicies.some((policy) => policy.productId === productId)
    && workspaceManifests.some((manifest) => manifest.productId === productId);
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId);
  const selectedEvalRun = evalRuns.find((run) => run.id === selectedEvalRunId);
  const selectedRubric = rubrics.find((rubric) => rubric.id === selectedRubricId) ?? rubrics.find((rubric) => rubric.productId === productId) ?? rubrics[0];
  const reviewedRuns = evalRuns.filter((run) => run.humanReview).slice().sort((left, right) => (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt));
  const selectedSpecRuns = selectedAgentSpecId ? evalRuns.filter((run) => run.agentSpecId === selectedAgentSpecId) : [];
  const selectedSpecReviewStats = summarizeHumanReviews(selectedSpecRuns);

  return (
    <div className="harness-panel">
      <div className="harness-toolbar">
        <button type="button" onClick={() => void loadSummary()} disabled={state !== 'idle'}>刷新</button>
      </div>
      {error ? <p className="git-result error">{error}</p> : null}
      {state === 'loading' ? <p className="muted">正在读取 Harness 状态...</p> : null}

      <div className="harness-workflow harness-workflow--pipeline">
        <WorkflowStep index="1" title="配置候选" detail="选择产品、agent、行为规则并生成 draft spec。" active />
        <WorkflowStep index="2" title="沉淀案例" detail="从 snapshot 或失败 artifact 固定复现输入。" />
        <WorkflowStep index="3" title="执行评测" detail="用 Repro/Live 跑 fixture 并比较 active/candidate。" />
        <WorkflowStep index="4" title="人工审阅" detail="评分、行备注和退化判断。" />
        <WorkflowStep index="5" title="发布运行" detail="评测通过后激活或审计回滚。" />
      </div>

      <div className="harness-metrics">
        <Metric label="AgentSpec" value={agentSpecs.length} />
        <Metric label="LayerConfig" value={layerConfigs.length} />
        <Metric label="MemoryPolicy" value={memoryPolicies.length} />
        <Metric label="Knowledge" value={knowledgeEntries.length} />
        <Metric label="行为规则" value={promptBlocks.length} />
        <Metric label="Manifest" value={workspaceManifests.length} />
        <Metric label="Snapshots" value={snapshots.length} />
        <Metric label="Artifacts" value={runArtifacts.length} />
        <Metric label="Fixtures" value={fixtures.length} />
        <Metric label="EvalRuns" value={evalRuns.length} />
      </div>

      <section className="harness-section harness-pipeline-node">
        <NodeHeader index="1" title="配置候选" description="一个 Agent 行为规则可以被多个 AgentSpec 引用，也就能被多个 agent 复用；是否复用由评测结果证明，而不是默认共享。" />
        <div className={`harness-readiness ${hasHarnessBasics ? 'ready' : 'blocked'}`}>
          <strong>{hasHarnessBasics ? '评测基础已就绪' : '当前产品缺少评测基础'}</strong>
          <small>{hasHarnessBasics ? '日常调试只需要创建候选 AgentSpec。' : '首次使用该产品时，先初始化默认分层、记忆、检索和 manifest。'}</small>
        </div>
        <div className="harness-form-grid">
          <label><span>产品</span><select value={productId} onChange={(event) => setProductId(event.target.value)}>{productOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
          <label><span>Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agentOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
          <label><span>Agent 行为规则</span><select value={selectedPromptBlockRef} onChange={(event) => setSelectedPromptBlockRef(event.target.value)}><option value="">暂不绑定行为规则</option>{promptBlockOptions.map((block) => <option key={`${block.id}@${block.version}`} value={`${block.id}@${block.version}`}>{block.title} · v{block.version} · {block.status}</option>)}</select></label>
          <label><span>候选配置</span><select value={selectedAgentSpecId} onChange={(event) => setSelectedAgentSpecId(event.target.value)}>
            <option value="">选择 AgentSpec</option>
            {agentSpecs.filter((spec) => spec.productId === productId && spec.agentId === agentId).map((spec) => <option key={spec.id} value={spec.id}>{formatAgentSpec(spec)}</option>)}
          </select></label>
        </div>
        <div className="harness-columns two">
          <AgentSpecPreview title="当前 active" preview={activeAgentSpecPreview} emptyText="当前产品/agent 还没有 active AgentSpec" mode="summary" />
          <AgentSpecPreview title="当前行为规则" preview={selectedPromptBlockPreview} emptyText="请选择一条行为规则" />
        </div>
        <div className="harness-action-row">
          <button type="button" onClick={() => void createAgentSpec()} disabled={state !== 'idle'} title="创建一个未发布的候选配置，用于后续评估。">创建候选 AgentSpec</button>
          <button type="button" onClick={() => void archiveSelectedAgentSpec()} disabled={state !== 'idle' || !selectedAgentSpecId || selectedAgentSpec?.status === 'active'} title="删除未被任何评测或发布引用的草稿候选。">删除候选</button>
          {!hasHarnessBasics ? <button type="button" onClick={() => void createDefaults()} disabled={state !== 'idle'} title="首次接入产品时创建默认 layer、memory、retrieval、manifest 和一条示例知识卡。">初始化评测基础</button> : null}
        </div>
        <details className="harness-advanced-editor">
          <summary>高级：新建 Agent 行为规则</summary>
          <input value={promptBlockTitle} onChange={(event) => setPromptBlockTitle(event.target.value)} placeholder="行为规则标题" />
          <textarea value={promptBlockContent} onChange={(event) => setPromptBlockContent(event.target.value)} rows={4} placeholder="行为规则内容：只写 agent 应该如何工作，不写项目事实" />
          <div className="harness-action-row">
            <button type="button" onClick={() => void createPromptBlockModel()} disabled={state !== 'idle' || !promptBlockTitle.trim() || !promptBlockContent.trim()}>创建规则并生成候选配置</button>
          </div>
        </details>
        <details className="harness-resolved-preview" open={showResolvedPreview} onToggle={(event) => setShowResolvedPreview(event.currentTarget.open)}>
          <summary>Agent 上下文全貌</summary>
          <div className="harness-columns two">
            <AgentSpecPreview title="当前 active" preview={activeAgentSpecPreview} emptyText="当前产品/agent 还没有 active AgentSpec" mode="full" />
            <AgentSpecPreview title="选中候选" preview={selectedAgentSpecPreview} emptyText="请选择或创建候选 AgentSpec" mode="full" />
          </div>
        </details>
      </section>

      <details className="harness-section harness-secondary-section">
        <summary>运行上下文配置</summary>
        <p className="muted">这里展示的是候选配置运行时会解析到的底层策略：agent 分层、记忆策略、检索策略和项目结构约束。当前主要用于确认和审计，不是日常第一入口。</p>
        <div className="harness-columns">
          <ConfigList title="LayerConfig" items={layerConfigs.map(formatLayerConfig)} />
          <ConfigList title="MemoryPolicy" items={memoryPolicies.map(formatMemoryPolicy)} />
          <ConfigList title="RetrievalPolicy" items={retrievalPolicies.map(formatRetrievalPolicy)} />
          <ConfigList title="Agent 行为规则" items={promptBlocks.map(formatPromptBlock)} />
          <ConfigList title="WorkspaceManifest" items={workspaceManifests.map(formatWorkspaceManifest)} />
        </div>
        <ul className="harness-list">
          {knowledgeEntries.slice(-5).reverse().map((entry) => (
            <li key={entry.id}><span>{entry.type}</span><strong>{entry.title}</strong><small>{entry.rightsRisk} · {entry.path}</small></li>
          ))}
          {knowledgeEntries.length === 0 ? <li><span>empty</span><small>还没有知识卡索引</small></li> : null}
        </ul>
      </details>

      <details className="harness-section harness-secondary-section">
        <summary>Agent 行为规则版本</summary>
        <p className="muted">Agent 行为规则是可复用的 prompt 规则块，可被多个 AgentSpec 引用；skill 是独立能力包，不在这里编辑。</p>
        <div className="harness-form-row compact">
          <select value={selectedPromptBlockId} onChange={(event) => setSelectedPromptBlockId(event.target.value)}>
            <option value="">选择行为规则</option>
            {uniquePromptBlockIds(promptBlocks).map((id) => <option key={id} value={id}>{formatPromptBlockGroup(promptBlocks, id)}</option>)}
          </select>
          <button type="button" onClick={() => void loadPromptBlockDiff()} disabled={state !== 'idle' || !selectedPromptBlockId}>查看规则 diff</button>
          <button type="button" onClick={() => void updateSelectedPromptBlockStatus('candidate')} disabled={state !== 'idle' || !selectedPromptBlock}>设为 candidate</button>
          <button type="button" onClick={() => void updateSelectedPromptBlockStatus('active')} disabled={state !== 'idle' || !selectedPromptBlock}>设为 active</button>
        </div>
        {versionDiff ? <VersionDiffView diff={versionDiff} /> : <p className="muted">选择一个行为规则查看最近两个版本的 diff。</p>}
      </details>

      <section className="harness-section harness-pipeline-node">
        <NodeHeader index="2" title="沉淀案例" description="优先从失败运行的 artifact 创建 fixture；snapshot 入口保留给主动构造回归案例。" />
        <h3>RunInputSnapshot</h3>
        <select value={selectedSnapshotId} onChange={(event) => setSelectedSnapshotId(event.target.value)}>
          <option value="">选择 Snapshot</option>
          {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{formatSnapshot(snapshot)}</option>)}
        </select>
        <button type="button" onClick={() => void createFixture()} disabled={state !== 'idle' || !selectedSnapshotId}>从 Snapshot 创建 Fixture</button>
      </section>

      <section className="harness-section">
        <h3>RunArtifact</h3>
        <select value={selectedRunArtifactId} onChange={(event) => setSelectedRunArtifactId(event.target.value)}>
          <option value="">选择 RunArtifact</option>
          {runArtifacts.map((artifact) => <option key={artifact.runId} value={artifact.runId}>{artifact.status} · {artifact.fileDiff.length} diffs · {artifact.runId.slice(0, 18)}</option>)}
        </select>
        <button type="button" onClick={() => void createFixtureFromArtifact()} disabled={state !== 'idle' || !selectedRunArtifactId}>从 Artifact 创建 Fixture</button>
        {selectedRunArtifactId ? <ArtifactDetails artifact={runArtifacts.find((artifact) => artifact.runId === selectedRunArtifactId)} /> : null}
      </section>

      <section className="harness-section harness-pipeline-node">
        <NodeHeader index="3" title="执行评测" description="Repro 固定 memory 和 knowledge 输入，Live 用于确认当前运行环境是否仍然一致。" />
        <h3>EvalFixture / EvalRun</h3>
        <select value={selectedFixtureId} onChange={(event) => setSelectedFixtureId(event.target.value)}>
          <option value="">选择 Fixture</option>
          {fixtures.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.target} · {fixture.id.slice(0, 18)}</option>)}
        </select>
        <textarea
          value={fixtureAssertionsText}
          onChange={(event) => setFixtureAssertionsText(event.target.value)}
          rows={8}
          spellCheck={false}
          placeholder="assertions JSON"
        />
        <div className="harness-assertion-builder">
          <strong>断言构建器</strong>
          <div className="harness-assertion-builder-grid">
            <label>
              <span>类型</span>
              <select value={assertionKind} onChange={(event) => setAssertionKind(event.target.value as FixtureAssertionKind)}>
                <option value="changed-file">要求创建/修改文件</option>
                <option value="heading">要求 Markdown 标题</option>
                <option value="forbidden-write">禁止写入路径</option>
                <option value="allowed-section">限制可修改 section</option>
                <option value="max-changed">限制变更文件数</option>
              </select>
            </label>
            {assertionKind !== 'max-changed' ? (
              <label>
                <span>路径</span>
                <input value={assertionPath} onChange={(event) => setAssertionPath(event.target.value)} placeholder="例如 02 故事/**" />
              </label>
            ) : null}
            {assertionKind === 'heading' ? (
              <label>
                <span>Markdown 标题</span>
                <input value={assertionHeading} onChange={(event) => setAssertionHeading(event.target.value)} placeholder="例如 主角目标" />
              </label>
            ) : null}
            {assertionKind === 'allowed-section' ? (
              <label>
                <span>允许修改的 section</span>
                <input value={assertionSection} onChange={(event) => setAssertionSection(event.target.value)} placeholder="例如 升级链条" />
              </label>
            ) : null}
            {assertionKind === 'max-changed' ? (
              <label>
                <span>最大变更文件数</span>
                <input value={assertionMaxChanged} onChange={(event) => setAssertionMaxChanged(event.target.value)} placeholder="例如 1" />
              </label>
            ) : null}
            <button type="button" onClick={() => void addFixtureAssertion()} disabled={state !== 'idle' || !selectedFixtureId}>添加断言</button>
          </div>
        </div>
        <div className="harness-form-row compact">
          <select value={evalRunMode} onChange={(event) => setEvalRunMode(event.target.value as EvalRun['runMode'])}>
            <option value="repro">Repro fixture</option>
            <option value="live">Live memory/knowledge</option>
          </select>
          <button type="button" onClick={() => void saveFixtureAssertions()} disabled={state !== 'idle' || !selectedFixtureId}>保存 Assertions</button>
          <button type="button" onClick={() => void createEvalRun()} disabled={state !== 'idle' || !selectedFixtureId || !selectedAgentSpecId}>创建 EvalRun</button>
        </div>
        {selectedFixture ? (
          <FixtureDetails
            fixture={selectedFixture}
            tagsText={fixtureTagsText}
            onTagsTextChange={setFixtureTagsText}
            onSaveTags={() => void saveFixtureTags()}
            onPatch={(input) => void patchSelectedFixture(input)}
            disabled={state !== 'idle'}
          />
        ) : null}
      </section>

      <section className="harness-section harness-pipeline-node">
        <NodeHeader index="4" title="人工审阅" description="程序检查只证明没有破坏约束，发布前仍要确认创作质量没有退化。" />
        <h3>HumanReview</h3>
        {selectedRubric ? (
          <div className="harness-review-form">
            <select value={selectedRubric.id} onChange={(event) => setSelectedRubricId(event.target.value)}>
              {rubrics.map((rubric) => <option key={rubric.id} value={rubric.id}>{rubric.productId}/{rubric.artifactType} v{rubric.version} {rubric.status}</option>)}
            </select>
            <select value={selectedEvalRunId} onChange={(event) => setSelectedEvalRunId(event.target.value)}>
              <option value="">选择 EvalRun</option>
          {evalRuns.map((run) => <option key={run.id} value={run.id}>{formatEvalRun(run)}</option>)}
            </select>
            <div className="harness-review-summary">
              <small>当前 AgentSpec：{selectedSpecRuns.length} evals · {selectedSpecReviewStats.reviewed} reviewed · avg {selectedSpecReviewStats.averageText}</small>
              <small>决策：{selectedSpecReviewStats.decisionsText}</small>
            </div>
            <select value={reviewDecision} onChange={(event) => setReviewDecision(event.target.value as typeof reviewDecision)}>
              <option value="pass">pass</option>
              <option value="improved">improved</option>
              <option value="fail">fail</option>
              <option value="regressed">regressed</option>
              <option value="needs_regression_case">needs regression case</option>
            </select>
            <div className="harness-score-grid">
              {selectedRubric.humanScores.map((score) => (
                <label key={score.id}>
                  <span>{score.label}</span>
                  <input
                    type="number"
                    min="0"
                    max={score.scale}
                    step="1"
                    value={reviewScores[score.id] ?? Math.min(4, score.scale)}
                    onChange={(event) => setReviewScores((current) => ({ ...current, [score.id]: Number(event.target.value) }))}
                  />
                  {score.anchors ? <small>{formatAnchors(score.anchors)}</small> : null}
                  {score.subScores?.map((subScore) => (
                    <label key={`${score.id}:${subScore}`} className="harness-subscore-row">
                      <span>{subScore}</span>
                      <input
                        type="number"
                        min="0"
                        max={score.scale}
                        step="1"
                        value={reviewSubScores[score.id]?.[subScore] ?? Math.min(4, score.scale)}
                        onChange={(event) => setReviewSubScores((current) => ({
                          ...current,
                          [score.id]: { ...(current[score.id] ?? {}), [subScore]: Number(event.target.value) },
                        }))}
                      />
                    </label>
                  ))}
                </label>
              ))}
            </div>
            <div className="harness-review-annotations">
              <strong>文件行备注</strong>
              <div className="harness-form-row compact">
                <input value={reviewAnnotationPath} onChange={(event) => setReviewAnnotationPath(event.target.value)} placeholder="文件路径" />
                <input value={reviewAnnotationLine} onChange={(event) => setReviewAnnotationLine(event.target.value)} placeholder="行号" />
                <select value={reviewAnnotationSeverity} onChange={(event) => setReviewAnnotationSeverity(event.target.value as typeof reviewAnnotationSeverity)}>
                  <option value="note">note</option>
                  <option value="issue">issue</option>
                  <option value="blocker">blocker</option>
                </select>
                <button type="button" onClick={addReviewAnnotation}>添加备注</button>
              </div>
              <input value={reviewAnnotationComment} onChange={(event) => setReviewAnnotationComment(event.target.value)} placeholder="备注内容" />
              {reviewAnnotations && reviewAnnotations.length > 0 ? (
                <ul className="harness-annotation-list">
                  {reviewAnnotations.map((annotation, index) => (
                    <li key={`${annotation.path}:${annotation.line ?? 'file'}:${index}`}>
                      <span>{annotation.severity}</span>
                      <strong>{annotation.line ? `${annotation.path}:${annotation.line}` : annotation.path}</strong>
                      <small>{annotation.assertionId ? `${annotation.assertionId} · ` : ''}{annotation.comment}</small>
                      <button type="button" onClick={() => removeReviewAnnotation(index)}>移除</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted">还没有行级备注</p>}
            </div>
            <input value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="notes" />
            <button type="button" onClick={() => void saveHumanReview()} disabled={state !== 'idle' || !selectedEvalRunId}>保存评分</button>
            <button type="button" onClick={() => void saveBatchHumanReviewForSelectedSpec()} disabled={state !== 'idle' || !selectedAgentSpecId || selectedSpecRuns.every((run) => run.humanReview)}>批量评分当前 Spec 未评分 EvalRun</button>
            {selectedEvalRun?.humanReview ? <p className="muted">当前评分：{selectedEvalRun.humanReview.decision} · {selectedEvalRun.humanReview.reviewer}</p> : null}
            <ReviewHistory runs={reviewedRuns} rubrics={rubrics} onSelect={setSelectedEvalRunId} />
          </div>
        ) : <p className="muted">还没有 HumanReviewRubric</p>}
      </section>

      <section className="harness-section harness-pipeline-node">
        <NodeHeader index="5" title="发布运行" description="发布动作只放在评测与人工审阅之后；未过 gate 时只能走强制发布并留下审计原因。" />
        <div className="harness-action-row">
          <button type="button" onClick={() => void loadReleaseGate()} disabled={state !== 'idle' || !selectedAgentSpecId} title="检查当前候选配置是否已有通过的 EvalRun 和人工评分。">检查发布 Gate</button>
          <button type="button" onClick={() => void activateSelectedSpec()} disabled={state !== 'idle' || !selectedAgentSpecId} title="只有通过评估 gate 的配置才会成为运行时默认配置。">发布为运行配置</button>
        </div>
        {releaseGate ? (
          <div className="harness-gate-result">
            <strong>{releaseGate.passed ? 'ready' : 'blocked'}</strong>
            <small>{releaseGate.reason}</small>
            {releaseGate.checks.map((check) => <small key={check.id}>{check.passed ? 'pass' : 'fail'} · {check.id}{check.message ? ` · ${check.message}` : ''}</small>)}
            {releaseGate.configChanges.map((change) => <small key={change.field}>{change.changed ? 'changed' : 'same'} · {change.field} · {change.message}</small>)}
          </div>
        ) : null}
        <details className="harness-advanced-editor">
          <summary>高级发布操作：强制发布 / 回滚</summary>
          <div className="harness-form-grid">
            <label><span>操作原因</span><select value={forceReason} onChange={(event) => setForceReason(event.target.value as typeof forceReason)}>
              <option value="manual_override">人工确认例外</option>
              <option value="emergency_fix">紧急修复</option>
              <option value="eval_gap">评估覆盖不足</option>
              <option value="bad_active_regression">当前版本退化</option>
              <option value="bad_release">错误发布</option>
              <option value="data_corruption">数据异常</option>
              <option value="policy_violation">策略违规</option>
              <option value="rollback">回滚</option>
              <option value="other">其他</option>
            </select></label>
            <label><span>审计分类</span><select value={auditCategory} onChange={(event) => setAuditCategory(event.target.value as AgentSpecReleaseAuditCategory)}>
              <option value="gate_bypass">绕过发布检查</option>
              <option value="quality_regression">质量退化</option>
              <option value="operational_incident">运行事故</option>
              <option value="data_integrity">数据完整性</option>
              <option value="policy_exception">策略例外</option>
              <option value="planned_rollback">计划回滚</option>
              <option value="other">其他</option>
            </select></label>
            <label><span>回滚来源</span><select value={rollbackSourceReleaseId} onChange={(event) => setRollbackSourceReleaseId(event.target.value)}>
              <option value="">使用当前选中配置</option>
              {releaseRecords.filter((record) => record.previousActiveSpecId).slice(-12).reverse().map((record) => (
                <option key={record.id} value={record.id}>release {record.id.slice(0, 12)} 的前一版本</option>
              ))}
            </select></label>
            <label><span>审计备注</span><input value={forceNotes} onChange={(event) => setForceNotes(event.target.value)} placeholder="说明为什么需要绕过 gate 或回滚" /></label>
          </div>
          <div className="harness-action-row">
            <button type="button" onClick={() => void forceActivateSelectedSpec()} disabled={state !== 'idle' || !selectedAgentSpecId}>强制发布为运行配置</button>
            <button type="button" onClick={() => void rollbackSelectedSpec()} disabled={state !== 'idle' || !selectedAgentSpecId}>执行回滚</button>
          </div>
        </details>
      </section>

      <section className="harness-section">
        <h3>最近 EvalRun</h3>
        <ul className="harness-list">
          {evalRuns.slice(-8).reverse().map((run) => (
            <li key={run.id} onClick={() => setSelectedEvalRunId(run.id)}><span>{run.status}</span><strong>{run.executionMode ?? run.runMode}</strong><small>{run.assertionResults.length} checks · {run.errorMessage ?? run.id}</small></li>
          ))}
          {evalRuns.length === 0 ? <li><span>empty</span><small>还没有评估运行</small></li> : null}
        </ul>
      </section>

      <section className="harness-section">
        <h3>AgentSpec 对比</h3>
        <SpecComparison specs={agentSpecs} runs={evalRuns} onSelect={setSelectedAgentSpecId} />
      </section>

      <section className="harness-section">
        <h3>Fixture 横向对比</h3>
        <FixtureRunComparison fixtureId={selectedFixtureId} specs={agentSpecs} runs={evalRuns} onSelectRun={setSelectedEvalRunId} onSelectSpec={setSelectedAgentSpecId} />
      </section>

      <section className="harness-section">
        <h3>发布记录</h3>
        <div className="harness-form-row compact">
          <select value={releaseActionFilter} onChange={(event) => setReleaseActionFilter(event.target.value as typeof releaseActionFilter)}>
            <option value="all">all actions</option>
            <option value="activate">activate</option>
            <option value="rollback">rollback</option>
          </select>
          <select value={releaseAuditFilter} onChange={(event) => setReleaseAuditFilter(event.target.value as typeof releaseAuditFilter)}>
            <option value="all">all audits</option>
            <option value="gate_bypass">gate bypass</option>
            <option value="quality_regression">quality regression</option>
            <option value="operational_incident">operational incident</option>
            <option value="data_integrity">data integrity</option>
            <option value="policy_exception">policy exception</option>
            <option value="planned_rollback">planned rollback</option>
            <option value="other">other</option>
          </select>
          <select value={releaseForceFilter} onChange={(event) => setReleaseForceFilter(event.target.value as typeof releaseForceFilter)}>
            <option value="all">all force states</option>
            <option value="forced">forced only</option>
            <option value="normal">normal only</option>
          </select>
          <button type="button" onClick={() => void loadFilteredReleaseRecords()} disabled={state !== 'idle'}>筛选</button>
        </div>
        <ReleaseRecordDetails records={visibleReleaseRecords} />
      </section>
    </div>
  );
}

function ConfigList({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div className="harness-config-list">
      <strong>{title}</strong>
      {items.length > 0 ? items.slice(-3).reverse().map((item) => <small key={item}>{item}</small>) : <small>empty</small>}
    </div>
  );
}

function WorkflowStep({ index, title, detail, active = false }: { index: string; title: string; detail: string; active?: boolean }): JSX.Element {
  return (
    <div className={`harness-workflow-step${active ? ' active' : ''}`}>
      <span>{index}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }): JSX.Element {
  return (
    <div className="harness-section-header">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function NodeHeader({ index, title, description }: { index: string; title: string; description: string }): JSX.Element {
  return (
    <div className="harness-node-header">
      <span>{index}</span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

function VersionDiffView({ diff }: { diff: HarnessVersionDiff }): JSX.Element {
  return (
    <div className="harness-version-diff">
      <div className="harness-detail-grid">
        <small>{diff.recordType} {diff.id}</small>
        <small>v{diff.previousVersion} {'->'} v{diff.nextVersion}</small>
        <small>{diff.changed ? 'content changed' : 'content unchanged'}</small>
        <small>{diff.previousHash.slice(0, 18)} {'->'} {diff.nextHash.slice(0, 18)}</small>
      </div>
      <pre>
        {diff.lines.map((line, index) => {
          const prefix = line.change === 'added' ? '+' : line.change === 'removed' ? '-' : ' ';
          const number = line.change === 'removed' ? line.previousLineNumber : line.nextLineNumber ?? line.lineNumber;
          return `${prefix} ${String(number ?? '').padStart(4, ' ')} ${line.text}`;
        }).join('\n')}
      </pre>
    </div>
  );
}

function ReleaseRecordDetails({ records }: { records: HarnessSummary['releaseRecords'] }): JSX.Element {
  const recent = records.slice(-6).reverse();
  if (recent.length === 0) {
    return <ul className="harness-list"><li><span>empty</span><small>还没有发布或回滚记录</small></li></ul>;
  }
  return (
    <div className="harness-release-records">
      {recent.map((record) => (
        <details key={record.id} className="harness-release-record">
          <summary>
            <span>{record.force ? `${record.action} force` : record.action}</span>
            <strong>{record.agentId}</strong>
            <small>{record.targetSpecId.slice(0, 18)} · {record.evalRunIds.length} evals · {record.auditCategory ?? 'normal'}</small>
          </summary>
          <div className="harness-detail-grid">
            <small>record: {record.id}</small>
            <small>target: {record.targetSpecId}</small>
            <small>previous active: {record.previousActiveSpecId ?? 'none'}</small>
            <small>source release: {record.sourceReleaseRecordId ?? 'none'}</small>
            <small>force reason: {record.forceReason ?? 'normal'}</small>
            <small>audit category: {record.auditCategory ?? 'normal'}</small>
            <small>reviewer: {record.reviewer ?? 'n/a'}</small>
            <small>created: {record.createdAt}</small>
          </div>
          {record.notes ? <p className="muted">{record.notes}</p> : null}
          {record.gate ? <ReleaseGateSnapshot gate={record.gate} /> : null}
        </details>
      ))}
    </div>
  );
}

function ReleaseGateSnapshot({ gate }: { gate: AgentSpecReleaseGate }): JSX.Element {
  return (
    <div className="harness-gate-result">
      <strong>{gate.passed ? 'gate passed' : 'gate blocked'} · {gate.reason}</strong>
      {gate.checks.map((check) => <small key={check.id}>{check.passed ? 'pass' : 'fail'} · {check.id}{check.message ? ` · ${check.message}` : ''}</small>)}
      {gate.configChanges.map((change) => <small key={change.field}>{change.changed ? 'changed' : 'same'} · {change.field} · {change.message}</small>)}
    </div>
  );
}

type AgentSpecPreviewModel = {
  spec: AgentSpec;
  layerConfig?: AgentLayerConfig;
  promptBlocks: Array<{ ref: string; title: string; status: string; content: string; source: string }>;
  skills: Array<{ ref: string; skillId: string; content?: string; contentHash?: string; source: string }>;
  memoryPolicy?: MemoryPolicy;
  retrievalPolicy?: RetrievalPolicy;
  workspaceManifest?: WorkspaceManifest;
};

type PromptBlockPreviewModel = {
  title: string;
  content: string;
  status: string;
  ref: string;
};

function AgentSpecPreview({ title, preview, emptyText, mode = 'full' }: { title: string; preview: AgentSpecPreviewModel | PromptBlockPreviewModel | null; emptyText: string; mode?: 'summary' | 'full' }): JSX.Element {
  if (!preview) {
    return <div className="harness-agent-preview"><strong>{title}</strong><small>{emptyText}</small></div>;
  }
  if ('spec' in preview) {
    const currentSkill = preview.skills.find((skill) => skill.skillId === preview.spec.agentId) ?? preview.skills[0];
    const sourceLabel = preview.spec.id.startsWith('seed_') ? '产品内置 v1' : preview.spec.status === 'active' ? '已发布版本' : '候选版本';
    return (
      <div className="harness-agent-preview">
        <strong>{title}</strong>
        <div className="harness-agent-summary-grid">
          <span><small>运行版本</small><strong>{sourceLabel}</strong></span>
          <span><small>当前 Agent</small><strong>{preview.spec.productId}/{preview.spec.agentId}</strong></span>
          <span><small>提示词来源</small><strong>{currentSkill?.source ?? '未解析'}</strong></span>
          <span><small>绑定规则</small><strong>{preview.promptBlocks.length}</strong></span>
        </div>
        {currentSkill ? (
          <details className="harness-prompt-preview" open={mode === 'summary'}>
            <summary><span>当前 agent 提示词</span><strong>{currentSkill.skillId}</strong><small>{currentSkill.ref}</small></summary>
            <pre>{currentSkill.content ?? '(skill content unavailable)'}</pre>
          </details>
        ) : null}
        <div className="harness-prompt-preview-stack">
          {preview.promptBlocks.length > 0 ? preview.promptBlocks.map((block) => (
            <details key={`${block.ref}:${block.source}`} className="harness-prompt-preview" open={false}>
              <summary><span>{block.source}</span><strong>{block.title}</strong><small>{block.ref} · {block.status}</small></summary>
              <pre>{block.content}</pre>
            </details>
          )) : <small>没有绑定 Agent 行为规则</small>}
        </div>
        {mode === 'full' ? (
          <details className="harness-audit-preview">
            <summary>高级审计信息</summary>
            <div className="harness-detail-grid">
              <small>spec: {preview.spec.id.slice(0, 28)} · v{preview.spec.version} · {preview.spec.status}</small>
              <small>layer: {preview.layerConfig ? `${preview.layerConfig.id.slice(0, 28)} · v${preview.layerConfig.version}` : preview.spec.layerConfigRef ?? 'none'}</small>
              <small>memory: {preview.memoryPolicy ? `${preview.memoryPolicy.id}@${preview.memoryPolicy.version}` : preview.spec.memoryPolicyRef ?? preview.layerConfig?.memoryPolicyRef ?? 'none'}</small>
              <small>retrieval: {preview.retrievalPolicy ? `${preview.retrievalPolicy.id}@${preview.retrievalPolicy.version}` : preview.spec.retrievalPolicyRef ?? preview.layerConfig?.retrievalPolicyRef ?? 'none'}</small>
              <small>manifest: {preview.workspaceManifest ? `${preview.workspaceManifest.productId} template ${preview.workspaceManifest.templateVersion}` : 'none'}</small>
            </div>
            {preview.layerConfig ? <LayerConfigPreview config={preview.layerConfig} currentAgentId={preview.spec.agentId} /> : null}
            <div className="harness-prompt-preview-stack">
              {preview.skills.filter((skill) => skill.skillId !== currentSkill?.skillId).map((skill) => (
                <details key={`${skill.ref}:${skill.source}`} className="harness-prompt-preview" open={false}>
                  <summary><span>{skill.source}</span><strong>{skill.skillId}</strong><small>{skill.ref} · {skill.contentHash ?? 'no hash'}</small></summary>
                  <pre>{skill.content ?? '(skill content unavailable)'}</pre>
                </details>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    );
  }
  return (
    <div className="harness-agent-preview">
      <strong>{title}</strong>
      <div className="harness-detail-grid">
        <small>rule: {preview.ref}</small>
        <small>title: {preview.title}</small>
        <small>status: {preview.status}</small>
      </div>
      <pre className="harness-prompt-preview__content">{preview.content}</pre>
    </div>
  );
}

function buildPromptBlockPreview(ref: string, promptBlocks: PromptBlock[]): PromptBlockPreviewModel | null {
  const { id, version } = parseVersionRef(ref);
  const record = promptBlocks.find((block) => block.id === id && (version === undefined || block.version === version));
  if (!record) return null;
  return {
    title: record.title,
    content: record.content,
    status: record.status,
    ref,
  };
}

function LayerConfigPreview({ config, currentAgentId }: { config: AgentLayerConfig; currentAgentId?: string }): JSX.Element {
  const visibleSpecialists = currentAgentId
    ? config.specialists.filter((agent) => agent.agentId === currentAgentId)
    : config.specialists;
  const hiddenCount = currentAgentId ? config.specialists.length - visibleSpecialists.length : 0;
  return (
    <div className="harness-layer-preview">
      <strong>Agent 分层</strong>
      <small>system: {config.systemAgent.agentId} · tools {(config.systemAgent.allowedTools ?? []).join(', ') || 'default'} · prompts {(config.systemAgent.promptBlockRefs ?? []).join(', ') || 'none'}</small>
      {visibleSpecialists.map((agent) => (
        <small key={agent.agentId}>{agent.defaultEnabled ? 'enabled' : 'disabled'} · {agent.agentId} · skill {agent.skillRef ?? 'none'} · tools {(agent.allowedTools ?? []).join(', ') || 'default'} · prompts {(agent.promptBlockRefs ?? []).join(', ') || 'none'}</small>
      ))}
      {hiddenCount > 0 ? <small>另有 {hiddenCount} 个 specialist 已收起</small> : null}
    </div>
  );
}

function buildAgentSpecPreview(
  spec: AgentSpec,
  models: {
    layerConfigs: AgentLayerConfig[];
    promptBlocks: PromptBlock[];
    memoryPolicies: MemoryPolicy[];
    retrievalPolicies: RetrievalPolicy[];
    workspaceManifests: WorkspaceManifest[];
  },
): AgentSpecPreviewModel {
  const layerConfig = models.layerConfigs.find((config) => config.id === spec.layerConfigRef);
  const promptBlocks = resolvePromptBlockPreviews(spec, layerConfig, models.promptBlocks);
  return {
    spec,
    layerConfig,
    promptBlocks,
    skills: resolveSkillPreviews(spec, layerConfig),
    memoryPolicy: resolveMemoryPolicyPreview(spec, layerConfig, models.memoryPolicies),
    retrievalPolicy: resolveRetrievalPolicyPreview(spec, layerConfig, models.retrievalPolicies),
    workspaceManifest: models.workspaceManifests.find((manifest) => manifest.productId === spec.productId && manifest.status === 'active'),
  };
}

function parseVersionRef(ref: string): { id: string; version?: number } {
  const [id, versionText] = ref.split('@');
  const version = Number(versionText);
  return { id, version: Number.isFinite(version) ? version : undefined };
}

function resolvePromptBlockPreviews(spec: AgentSpec, layerConfig: AgentLayerConfig | undefined, promptBlocks: PromptBlock[]): AgentSpecPreviewModel['promptBlocks'] {
  const refs = [...new Set([
    ...(layerConfig?.systemAgent.promptBlockRefs ?? []),
    ...(layerConfig?.specialists.find((agent) => agent.agentId === spec.agentId)?.promptBlockRefs ?? []),
    ...(spec.promptBlockRefs ?? []),
  ])];
  return refs.map((ref) => {
    const { id, version } = parseVersionRef(ref);
    const record = promptBlocks.find((block) => block.id === id && (version === undefined || block.version === version));
    return {
      ref,
      title: record?.title ?? id,
      status: record?.status ?? 'missing',
      content: record?.content ?? '(missing prompt block)',
      source: spec.promptBlockRefs?.includes(ref) ? 'prompt_block' : layerConfig?.systemAgent.promptBlockRefs.includes(ref) ? 'layer_config' : 'agent_spec',
    };
  });
}

function resolveSkillPreviews(spec: AgentSpec, layerConfig: AgentLayerConfig | undefined): AgentSpecPreviewModel['skills'] {
  const refs = [
    ...spec.skillRefs.map((skill) => ({ ref: `${skill.skillId}${skill.version ? `@${skill.version}` : ''}`, skillId: skill.skillId, contentHash: skill.contentHash, source: 'agent_spec' })),
    ...(layerConfig?.specialists ?? [])
      .filter((specialist) => specialist.defaultEnabled && specialist.skillRef)
      .map((specialist) => ({
        ref: specialist.skillRef as string,
        skillId: (specialist.skillRef as string).split('@')[0],
        content: specialist.instructionOverride,
        contentHash: specialist.instructionOverride ? simpleContentHash(specialist.instructionOverride) : undefined,
        source: 'layer_config',
      })),
  ];
  const byRef = new Map<string, AgentSpecPreviewModel['skills'][number]>();
  for (const ref of refs) byRef.set(ref.ref, ref);
  return [...byRef.values()];
}

function simpleContentHash(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (Math.imul(31, hash) + content.charCodeAt(index)) | 0;
  }
  return `preview:${Math.abs(hash).toString(16)}`;
}

function resolveMemoryPolicyPreview(spec: AgentSpec, layerConfig: AgentLayerConfig | undefined, policies: MemoryPolicy[]): MemoryPolicy | undefined {
  const ref = spec.memoryPolicyRef ?? layerConfig?.memoryPolicyRef;
  return ref ? latestVersionedRecord(policies, ref) : undefined;
}

function resolveRetrievalPolicyPreview(spec: AgentSpec, layerConfig: AgentLayerConfig | undefined, policies: RetrievalPolicy[]): RetrievalPolicy | undefined {
  const ref = spec.retrievalPolicyRef ?? layerConfig?.retrievalPolicyRef;
  return ref ? latestVersionedRecord(policies, ref) : undefined;
}

function latestVersionedRecord<T extends { id: string; version: number }>(records: T[], ref: string): T | undefined {
  const { id, version } = parseVersionRef(ref);
  const matches = records.filter((record) => record.id === id);
  if (version !== undefined) {
    return matches.find((record) => record.version === version) ?? matches.sort((left, right) => right.version - left.version)[0];
  }
  return matches.sort((left, right) => right.version - left.version)[0];
}

function ArtifactDetails({ artifact }: { artifact: HarnessSummary['runArtifacts'][number] | undefined }): JSX.Element | null {
  if (!artifact) return null;
  return (
    <div className="harness-artifact-detail">
      <div className="harness-detail-grid">
        <small>trace: {artifact.traceId ?? 'none'}</small>
        <small>model: {artifact.model ?? 'default'}</small>
        <small>model params: {artifact.modelParams?.model ?? artifact.modelParams?.modelPolicyRef ?? 'runtime default'} · steps {artifact.modelParams?.maxSteps ?? 'n/a'}</small>
        <small>memory writes: {artifact.memoryWrites?.length ?? 0}</small>
        <small>memory tombstones: {artifact.memoryTombstones?.length ?? 0}</small>
        <small>knowledge retrievals: {artifact.knowledgeRetrievals?.length ?? 0}</small>
        <small>resolved config: {artifact.resolvedAgentConfig?.agentSpec?.id?.slice(0, 18) ?? artifact.resolvedAgentConfig?.layerConfig?.id?.slice(0, 18) ?? 'none'}</small>
      </div>
      <ToolIoPolicyTable artifact={artifact} />
    </div>
  );
}

function ToolIoPolicyTable({ artifact }: { artifact: HarnessSummary['runArtifacts'][number] }): JSX.Element {
  const rows = artifact.toolIoSummaries ?? [];
  return (
    <div className="harness-tool-policy-table">
      <strong>工具输入输出裁剪建议</strong>
      <div className="harness-tool-policy-header"><span>tool</span><span>input</span><span>output</span><span>fixture policy</span></div>
      {rows.length > 0 ? rows.map((row) => {
        const sensitivity = inferToolSensitivity(row.toolName);
        const policy = recommendToolRetention(row, sensitivity);
        return (
          <div className="harness-tool-policy-row" key={row.toolCallId}>
            <span>{row.toolName ?? row.toolCallId.slice(0, 10)}</span>
            <span>{row.inputChars} chars{row.inputTruncated ? ' truncated' : ''}</span>
            <span>{row.outputChars} chars{row.outputTruncated ? ' truncated' : ''}</span>
            <span>{policy}</span>
          </div>
        );
      }) : <small>还没有 tool IO 摘要</small>}
    </div>
  );
}

function FixtureDetails({
  fixture,
  tagsText,
  onTagsTextChange,
  onSaveTags,
  onPatch,
  disabled,
}: {
  fixture: HarnessSummary['evalFixtures'][number];
  tagsText: string;
  onTagsTextChange: (value: string) => void;
  onSaveTags: () => void;
  onPatch: (input: Parameters<ApiClient['updateEvalFixture']>[1]) => void;
  disabled: boolean;
}): JSX.Element {
  const assertionKeys = Object.keys(fixture.assertions ?? {});
  const inputMessages = fixture.inputMessages ?? [];
  const memoryFixture = fixture.memoryFixture ?? [];
  const knowledgeFixture = fixture.knowledgeFixture ?? [];
  const memoryIds = new Set(memoryFixture.map((record) => record.id));
  const knowledgeIds = new Set(knowledgeFixture.map((entry) => entry.id));
  return (
    <div className="harness-fixture-editor">
      <div className="harness-detail-grid">
        <small>messages: {inputMessages.length}</small>
        <small>expected files: {fixture.expectedChangedFiles?.length ?? 0}</small>
        <small>expected tools: {fixture.expectedToolEvents?.length ?? 0}</small>
        <small>tool retention: {fixture.toolRetentionPolicy?.length ?? 0}</small>
        <small>tool artifacts: {fixture.toolRetentionArtifacts?.length ?? 0}</small>
        <small>memory: {memoryFixture.length}</small>
        <small>knowledge: {knowledgeFixture.length}</small>
        <small>assertions: {assertionKeys.length > 0 ? assertionKeys.join(', ') : 'none'}</small>
      </div>
      <div className="harness-form-row compact">
        <input value={tagsText} onChange={(event) => onTagsTextChange(event.target.value)} placeholder="tags, comma separated" />
        <button type="button" onClick={onSaveTags} disabled={disabled}>保存 Tags</button>
        <button type="button" onClick={() => onPatch({ inputMessages: inputMessages.slice(0, 1) })} disabled={disabled || inputMessages.length <= 1}>只保留首条消息</button>
        <button type="button" onClick={() => onPatch({ expectedToolEvents: [] })} disabled={disabled || (fixture.expectedToolEvents?.length ?? 0) === 0}>清空工具期望</button>
      </div>
      <ToolRetentionChecklist fixture={fixture} onPatch={onPatch} disabled={disabled} />
      <SensitiveFieldRulesEditor fixture={fixture} onPatch={onPatch} disabled={disabled} />
      <ToolRetentionArtifacts fixture={fixture} />
      <div className="harness-columns two">
        <FixtureChecklist
          title="Messages"
          items={inputMessages.map((message, index) => ({ id: String(index), label: `${message.role} · ${message.content.slice(0, 44)}` }))}
          selectedIds={new Set(inputMessages.map((_, index) => String(index)))}
          onToggle={(id) => onPatch({ inputMessages: inputMessages.filter((_, index) => String(index) !== id) })}
          disabled={disabled}
        />
        <FixtureChecklist
          title="Expected changed files"
          items={(fixture.expectedChangedFiles ?? []).map((file, index) => ({ id: String(index), label: `${file.change} · ${file.path}` }))}
          selectedIds={new Set((fixture.expectedChangedFiles ?? []).map((_, index) => String(index)))}
          onToggle={(id) => onPatch({ expectedChangedFiles: (fixture.expectedChangedFiles ?? []).filter((_, index) => String(index) !== id) })}
          disabled={disabled}
        />
      </div>
      <FixtureChecklist
        title="Expected tool events"
        items={(fixture.expectedToolEvents ?? []).map((event, index) => ({ id: String(index), label: `${event.type} · ${formatFixtureToolEvent(event)}` }))}
        selectedIds={new Set((fixture.expectedToolEvents ?? []).map((_, index) => String(index)))}
        onToggle={(id) => onPatch({ expectedToolEvents: (fixture.expectedToolEvents ?? []).filter((_, index) => String(index) !== id) })}
        disabled={disabled}
      />
      <FixtureChecklist
        title="Assertion groups"
        items={Object.keys(fixture.assertions ?? {}).map((key) => ({ id: key, label: `${key} · ${summarizeAssertionGroup((fixture.assertions ?? {})[key])}` }))}
        selectedIds={new Set(Object.keys(fixture.assertions ?? {}))}
        onToggle={(id) => onPatch({ assertions: omitAssertionGroup(fixture.assertions ?? {}, id) })}
        disabled={disabled}
      />
      <div className="harness-columns two">
        <FixtureChecklist
          title="Memory fixture"
          items={memoryFixture.map((record) => ({ id: record.id, label: `${record.memoryType} · ${record.content.slice(0, 36)}` }))}
          selectedIds={memoryIds}
          onToggle={(id) => onPatch({ memoryFixture: memoryFixture.filter((record) => record.id !== id) })}
          disabled={disabled}
        />
        <FixtureChecklist
          title="Knowledge fixture"
          items={knowledgeFixture.map((entry) => ({ id: entry.id, label: `${entry.type} · ${entry.title}` }))}
          selectedIds={knowledgeIds}
          onToggle={(id) => onPatch({ knowledgeFixture: knowledgeFixture.filter((entry) => entry.id !== id) })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function summarizeAssertionGroup(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} items`;
  if (isPlainRecord(value)) return Object.keys(value).join(', ') || 'empty';
  return typeof value;
}

function omitAssertionGroup(assertions: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...assertions };
  delete next[key];
  return next;
}

function formatFixtureToolEvent(event: NonNullable<HarnessSummary['evalFixtures'][number]['expectedToolEvents']>[number]): string {
  if ('toolName' in event && typeof event.toolName === 'string') return event.toolName;
  if ('agentId' in event && typeof event.agentId === 'string') return event.agentId;
  if ('status' in event && typeof event.status === 'string') return event.status;
  return event.runId.slice(0, 12);
}

function ToolRetentionArtifacts({ fixture }: { fixture: HarnessSummary['evalFixtures'][number] }): JSX.Element | null {
  const artifacts = fixture.toolRetentionArtifacts ?? [];
  if (artifacts.length === 0) return null;
  return (
    <div className="harness-tool-artifacts">
      <strong>Fixture tool artifacts</strong>
      {artifacts.map((artifact) => (
        <details key={artifact.toolCallId} className="harness-tool-artifact">
          <summary>
            <span>{artifact.toolName ?? artifact.toolCallId.slice(0, 10)}</span>
            <small>{artifact.retention} · in {artifact.inputChars} / out {artifact.outputChars}</small>
          </summary>
          <div className="harness-tool-artifact-body">
            <ToolRetentionText label="input" excerpt={artifact.inputExcerpt} summary={artifact.inputSummary} hash={artifact.inputHash} dropped={artifact.dropped} />
            <ToolRetentionText label="output" excerpt={artifact.outputExcerpt} summary={artifact.outputSummary} hash={artifact.outputHash} dropped={artifact.dropped} />
          </div>
        </details>
      ))}
    </div>
  );
}

function ToolRetentionText({ label, excerpt, summary, hash, dropped }: { label: string; excerpt?: string; summary?: string; hash?: string; dropped?: boolean }): JSX.Element {
  const text = excerpt ?? summary ?? (dropped ? '[dropped]' : '');
  return (
    <div className="harness-tool-artifact-text">
      <span>{label}{hash ? ` · ${hash.slice(0, 18)}` : ''}</span>
      <pre>{text || '[empty]'}</pre>
    </div>
  );
}

function ToolRetentionChecklist({ fixture, onPatch, disabled }: { fixture: HarnessSummary['evalFixtures'][number]; onPatch: (input: Parameters<ApiClient['updateEvalFixture']>[1]) => void; disabled: boolean }): JSX.Element | null {
  const policies = fixture.toolRetentionPolicy ?? [];
  if (policies.length === 0) return null;
  return (
    <div className="harness-tool-policy-table">
      <strong>Fixture tool retention</strong>
      <div className="harness-tool-policy-header"><span>tool</span><span>sensitivity</span><span>policy</span><span>action</span></div>
      {policies.map((policy) => (
        <div className="harness-tool-policy-row" key={policy.toolCallId}>
          <span title={policy.reason}>{policy.toolName ?? policy.toolCallId.slice(0, 10)}</span>
          <span>{policy.sensitivity}</span>
          <select
            value={policy.retention}
            onChange={(event) => onPatch({
              toolRetentionPolicy: policies.map((item) => item.toolCallId === policy.toolCallId ? { ...item, retention: event.target.value as typeof item.retention } : item),
            })}
            disabled={disabled}
          >
            <option value="full">full</option>
            <option value="excerpt_hash">excerpt + hash</option>
            <option value="summary_hash">summary + hash</option>
            <option value="drop">drop</option>
          </select>
          <button type="button" onClick={() => onPatch({ toolRetentionPolicy: policies.filter((item) => item.toolCallId !== policy.toolCallId) })} disabled={disabled}>移除</button>
        </div>
      ))}
    </div>
  );
}

function SensitiveFieldRulesEditor({ fixture, onPatch, disabled }: { fixture: HarnessSummary['evalFixtures'][number]; onPatch: (input: Parameters<ApiClient['updateEvalFixture']>[1]) => void; disabled: boolean }): JSX.Element | null {
  const rules = fixture.sensitiveFieldRules ?? [];
  if (rules.length === 0) return null;
  return (
    <div className="harness-tool-policy-table">
      <strong>Sensitive field rules</strong>
      <div className="harness-tool-policy-header"><span>rule</span><span>enabled</span><span>pattern</span><span>action</span></div>
      {rules.map((rule) => (
        <div className="harness-tool-policy-row" key={rule.id}>
          <span>{rule.id}</span>
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(event) => onPatch({ sensitiveFieldRules: rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item) })}
            disabled={disabled}
          />
          <span title={rule.pattern}>{rule.pattern}</span>
          <button type="button" onClick={() => onPatch({ sensitiveFieldRules: rules.filter((item) => item.id !== rule.id) })} disabled={disabled}>移除</button>
        </div>
      ))}
    </div>
  );
}

function FixtureChecklist({ title, items, selectedIds, onToggle, disabled }: { title: string; items: Array<{ id: string; label: string }>; selectedIds: Set<string>; onToggle: (id: string) => void; disabled: boolean }): JSX.Element {
  return (
    <div className="harness-fixture-checklist">
      <strong>{title}</strong>
      {items.length > 0 ? items.map((item) => (
        <label key={item.id}>
          <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => onToggle(item.id)} disabled={disabled} />
          <span>{item.label}</span>
        </label>
      )) : <small>empty</small>}
    </div>
  );
}

function ReviewHistory({ runs, rubrics, onSelect }: { runs: EvalRun[]; rubrics: HumanReviewRubric[]; onSelect: (id: string) => void }): JSX.Element {
  return (
    <div className="harness-review-history">
      <strong>评分历史</strong>
      <ul className="harness-list">
        {runs.slice(0, 6).map((run) => {
          const review = run.humanReview;
          const rubric = review ? rubrics.find((item) => item.id === review.rubricId && item.version === review.rubricVersion) : undefined;
          return (
            <li key={run.id} onClick={() => onSelect(run.id)}>
              <span>{review?.decision ?? 'unreviewed'}</span>
              <strong>{formatAverageScore(review?.scores)} avg</strong>
              <small>{rubric ? `${rubric.artifactType} v${rubric.version}` : review?.rubricId ?? 'unknown rubric'} · {review?.annotations?.length ?? 0} notes · {run.id.slice(0, 18)}</small>
            </li>
          );
        })}
        {runs.length === 0 ? <li><span>empty</span><small>还没有人工评分记录</small></li> : null}
      </ul>
    </div>
  );
}

function SpecComparison({ specs, runs, onSelect }: { specs: AgentSpec[]; runs: EvalRun[]; onSelect: (id: string) => void }): JSX.Element {
  const rows = specs.map((spec) => {
    const specRuns = runs.filter((run) => run.agentSpecId === spec.id);
    const reviewedRuns = specRuns.filter((run) => run.humanReview);
    const passed = specRuns.filter((run) => run.status === 'passed').length;
    const failed = specRuns.filter((run) => run.status === 'failed' || run.status === 'error').length;
    const reviewAverage = averageOfAverages(reviewedRuns.map((run) => averageScore(run.humanReview?.scores)));
    const decisions = reviewedRuns.reduce<Record<string, number>>((acc, run) => {
      const decision = run.humanReview?.decision;
      if (decision) acc[decision] = (acc[decision] ?? 0) + 1;
      return acc;
    }, {});
    return { spec, specRuns, reviewedRuns, passed, failed, reviewAverage, decisions };
  }).sort((left, right) => {
    if (left.spec.status === 'active' && right.spec.status !== 'active') return -1;
    if (right.spec.status === 'active' && left.spec.status !== 'active') return 1;
    return right.spec.version - left.spec.version;
  });
  return (
    <div className="harness-comparison-table">
      <div className="harness-comparison-header">
        <span>spec</span><span>status</span><span>evals</span><span>reviews</span><span>avg</span><span>decisions</span>
      </div>
      {rows.length > 0 ? rows.map((row) => (
        <button type="button" key={row.spec.id} onClick={() => onSelect(row.spec.id)} className="harness-comparison-row">
          <span>{row.spec.agentId} v{row.spec.version}</span>
          <span>{row.spec.status}</span>
          <span>{row.passed} pass / {row.failed} fail</span>
          <span>{row.reviewedRuns.length}</span>
          <span>{row.reviewAverage === null ? 'n/a' : row.reviewAverage.toFixed(1)}</span>
          <span>{Object.entries(row.decisions).map(([decision, count]) => `${decision} ${count}`).join(' · ') || 'n/a'}</span>
        </button>
      )) : <small className="muted">还没有可对比的 AgentSpec</small>}
    </div>
  );
}

function FixtureRunComparison({ fixtureId, specs, runs, onSelectRun, onSelectSpec }: { fixtureId: string; specs: AgentSpec[]; runs: EvalRun[]; onSelectRun: (id: string) => void; onSelectSpec: (id: string) => void }): JSX.Element {
  const fixtureRuns = runs
    .filter((run) => run.fixtureId === fixtureId)
    .slice()
    .sort((left, right) => (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt));
  const activeRuns = fixtureRuns.filter((run) => specs.find((spec) => spec.id === run.agentSpecId)?.status === 'active');
  const candidateRuns = fixtureRuns.filter((run) => specs.find((spec) => spec.id === run.agentSpecId)?.status === 'candidate');
  const baseline = activeRuns[0] ?? fixtureRuns[0];
  return (
    <div className="harness-fixture-comparison">
      <div className="harness-detail-grid">
        <small>active runs: {activeRuns.length}</small>
        <small>candidate runs: {candidateRuns.length}</small>
        <small>baseline: {baseline?.id.slice(0, 18) ?? 'none'}</small>
      </div>
      <div className="harness-comparison-table">
        <div className="harness-comparison-header fixture"><span>spec</span><span>status</span><span>diff</span><span>assertions</span><span>review</span><span>vs active</span></div>
        {fixtureRuns.length > 0 ? fixtureRuns.map((run) => {
          const spec = specs.find((item) => item.id === run.agentSpecId);
          const average = averageScore(run.humanReview?.scores);
          const delta = baseline && baseline.id !== run.id ? compareEvalRunToBaseline(run, baseline) : 'baseline';
          return (
            <button type="button" key={run.id} className="harness-comparison-row fixture" onClick={() => { onSelectRun(run.id); onSelectSpec(run.agentSpecId); }}>
              <span>{spec ? `${spec.agentId} v${spec.version}` : run.agentSpecId.slice(0, 10)}</span>
              <span>{spec?.status ?? 'unknown'} / {run.status}</span>
              <span>{summarizeFileDiff(run.fileDiff)}</span>
              <span>{run.assertionResults.filter((result) => result.passed).length}/{run.assertionResults.length}</span>
              <span>{run.humanReview?.decision ?? 'unreviewed'} · {average === null ? 'n/a' : average.toFixed(1)}</span>
              <span>{delta}</span>
            </button>
          );
        }) : <small className="muted">当前 Fixture 还没有 EvalRun</small>}
      </div>
      {baseline ? <FixtureChangedFilesComparison baseline={baseline} runs={fixtureRuns.filter((run) => run.id !== baseline.id).slice(0, 2)} /> : null}
    </div>
  );
}

function FixtureChangedFilesComparison({ baseline, runs }: { baseline: EvalRun; runs: EvalRun[] }): JSX.Element | null {
  if (runs.length === 0) return null;
  return (
    <div className="harness-file-diff-stack">
      {runs.map((run) => (
        <EvalRunSideBySideDiff key={run.id} baseline={baseline} run={run} />
      ))}
    </div>
  );
}

function EvalRunSideBySideDiff({ baseline, run }: { baseline: EvalRun; run: EvalRun }): JSX.Element {
  const baselineFiles = new Map((baseline.changedFiles ?? []).map((file) => [file.path, file]));
  const runFiles = new Map((run.changedFiles ?? []).map((file) => [file.path, file]));
  const paths = [...new Set([...baselineFiles.keys(), ...runFiles.keys()])].slice(0, 4);
  return (
    <div className="harness-file-diff-card">
      <div className="harness-file-diff-card-header">
        <strong>{run.id.slice(0, 18)}</strong>
        <small>{run.humanReview?.decision ?? 'unreviewed'}{run.humanReview?.notes ? ` · ${run.humanReview.notes}` : ''}</small>
      </div>
      {paths.length > 0 ? paths.map((filePath) => (
        <ChangedFileDiff key={filePath} path={filePath} baseline={baselineFiles.get(filePath)} candidate={runFiles.get(filePath)} />
      )) : <small>没有文件变更快照</small>}
    </div>
  );
}

function ChangedFileDiff({ path: filePath, baseline, candidate }: { path: string; baseline?: NonNullable<EvalRun['changedFiles']>[number]; candidate?: NonNullable<EvalRun['changedFiles']>[number] }): JSX.Element {
  const baselineText = baseline?.content ?? '';
  const candidateText = candidate?.content ?? '';
  const rows = diffLines(baselineText, candidateText).slice(0, 80);
  return (
    <div className="harness-file-diff">
      <div className="harness-file-diff-title">
        <span>{filePath}</span>
        <small>baseline {baseline?.change ?? 'none'} / candidate {candidate?.change ?? 'none'}</small>
      </div>
      <div className="harness-file-diff-grid">
        {rows.map((row, index) => (
          <div className={`harness-file-diff-row ${row.kind}`} key={`${index}-${row.left}-${row.right}`}>
            <pre>{row.left}</pre>
            <pre>{row.right}</pre>
          </div>
        ))}
      </div>
      {rows.length === 0 ? <small className="muted">两侧内容都为空或该文件被删除</small> : null}
    </div>
  );
}

function diffLines(leftText: string, rightText: string): Array<{ kind: 'same' | 'changed' | 'added' | 'removed'; left: string; right: string }> {
  const left = leftText.split('\n');
  const right = rightText.split('\n');
  const rows: Array<{ kind: 'same' | 'changed' | 'added' | 'removed'; left: string; right: string }> = [];
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const leftLine = left[index];
    const rightLine = right[index];
    if (leftLine === undefined) rows.push({ kind: 'added', left: '', right: rightLine ?? '' });
    else if (rightLine === undefined) rows.push({ kind: 'removed', left: leftLine, right: '' });
    else if (leftLine === rightLine) rows.push({ kind: 'same', left: leftLine, right: rightLine });
    else rows.push({ kind: 'changed', left: leftLine, right: rightLine });
  }
  return rows;
}

function summarizeFileDiff(diff: EvalRun['fileDiff']): string {
  const created = diff.filter((item) => item.change === 'created').length;
  const modified = diff.filter((item) => item.change === 'modified').length;
  const deleted = diff.filter((item) => item.change === 'deleted').length;
  return `+${created} ~${modified} -${deleted}`;
}

function compareEvalRunToBaseline(run: EvalRun, baseline: EvalRun): string {
  const assertionDelta = run.assertionResults.filter((result) => result.passed).length - baseline.assertionResults.filter((result) => result.passed).length;
  const reviewDelta = averageScore(run.humanReview?.scores);
  const baselineReview = averageScore(baseline.humanReview?.scores);
  const reviewText = reviewDelta !== null && baselineReview !== null ? `score ${formatSigned(reviewDelta - baselineReview)}` : 'score n/a';
  return `checks ${formatSigned(assertionDelta)} · ${reviewText}`;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

function inferToolSensitivity(toolName: string | undefined): 'low' | 'medium' | 'high' {
  if (!toolName) return 'medium';
  if (/write|memory|wechat|image|global/i.test(toolName)) return 'high';
  if (/read|retrieve|recall/i.test(toolName)) return 'medium';
  return 'low';
}

function recommendToolRetention(row: HarnessSummary['runArtifacts'][number]['toolIoSummaries'][number], sensitivity: 'low' | 'medium' | 'high'): string {
  const total = row.inputChars + row.outputChars;
  if (sensitivity === 'high' || row.inputTruncated || row.outputTruncated || total > 20_000) return 'summary + hash';
  if (total > 4_000) return 'excerpt + hash';
  return 'keep full text';
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return <div className="harness-metric"><strong>{value}</strong><span>{label}</span></div>;
}

function formatAgentSpec(spec: AgentSpec): string {
  return `${spec.productId}/${spec.agentId} v${spec.version} ${spec.status}`;
}

function formatSnapshot(snapshot: RunInputSnapshot): string {
  return `${snapshot.projectId.slice(0, 8)} · ${snapshot.fileManifest.length} files · ${snapshot.id.slice(0, 18)}`;
}

function formatLayerConfig(config: AgentLayerConfig): string {
  return `${config.productId} v${config.version} ${config.status} · ${config.specialists.length} specialists`;
}

function formatMemoryPolicy(policy: MemoryPolicy): string {
  return `${policy.productId} v${policy.version} ${policy.status} · ${policy.recallOrder.join('>')}`;
}

function formatRetrievalPolicy(policy: RetrievalPolicy): string {
  return `${policy.productId} v${policy.version} ${policy.status} · topK ${policy.defaultTopK}`;
}

function formatPromptBlock(block: PromptBlock): string {
  return `${block.productId}/${block.scope} v${block.version} ${block.status} · ${block.contentHash.slice(0, 18)}`;
}

function uniquePromptBlockIds(blocks: PromptBlock[]): string[] {
  return [...new Set(blocks.map((block) => block.id))];
}

function latestPromptBlock(blocks: PromptBlock[], id: string): PromptBlock | undefined {
  return blocks.filter((block) => block.id === id).sort((left, right) => right.version - left.version)[0];
}

function formatPromptBlockGroup(blocks: PromptBlock[], id: string): string {
  const versions = blocks.filter((block) => block.id === id).sort((left, right) => right.version - left.version);
  const latest = versions[0];
  return latest ? `${latest.title} · latest v${latest.version} ${latest.status} · ${versions.length} versions` : id;
}

function formatWorkspaceManifest(manifest: WorkspaceManifest): string {
  return `${manifest.productId} template ${manifest.templateVersion} ${manifest.status} · ${Object.keys(manifest.artifactTypes).length} artifacts`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatEvalRun(run: EvalRun): string {
  return `${run.status} · ${run.executionMode ?? run.runMode} · ${run.humanReview?.decision ?? 'unreviewed'} · ${run.id.slice(0, 18)}`;
}

function buildReviewScores(rubric: HumanReviewRubric, scores: Record<string, number>): Record<string, number> {
  return Object.fromEntries(rubric.humanScores.map((score) => [score.id, scores[score.id] ?? Math.min(4, score.scale)]));
}

function buildReviewSubScores(rubric: HumanReviewRubric, subScores: Record<string, Record<string, number>>): Record<string, Record<string, number>> | undefined {
  const entries = rubric.humanScores
    .filter((score) => score.subScores && score.subScores.length > 0)
    .map((score) => [
      score.id,
      Object.fromEntries((score.subScores ?? []).map((subScore) => [subScore, subScores[score.id]?.[subScore] ?? Math.min(4, score.scale)])),
    ] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function summarizeHumanReviews(runs: EvalRun[]): { reviewed: number; averageText: string; decisionsText: string } {
  const reviews = runs.map((run) => run.humanReview).filter((review): review is NonNullable<EvalRun['humanReview']> => Boolean(review));
  const averages = reviews.map((review) => averageScore(review.scores)).filter((score): score is number => score !== null);
  const decisions = reviews.reduce<Record<string, number>>((acc, review) => {
    acc[review.decision] = (acc[review.decision] ?? 0) + 1;
    return acc;
  }, {});
  return {
    reviewed: reviews.length,
    averageText: averages.length > 0 ? (averages.reduce((sum, score) => sum + score, 0) / averages.length).toFixed(1) : 'n/a',
    decisionsText: Object.entries(decisions).map(([decision, count]) => `${decision} ${count}`).join(' · ') || 'n/a',
  };
}

function averageScore(scores: Record<string, number> | undefined): number | null {
  if (!scores) return null;
  const values = Object.values(scores).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageOfAverages(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function formatAverageScore(scores: Record<string, number> | undefined): string {
  const average = averageScore(scores);
  return average === null ? 'n/a' : average.toFixed(1);
}

function formatAnchors(anchors: Record<string, string>): string {
  return Object.entries(anchors).map(([score, label]) => `${score}: ${label}`).join(' / ');
}

function parseAssertionsText(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = target[key];
  if (isPlainRecord(value)) return value;
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function appendUniqueString(value: unknown, nextValue: string): string[] {
  const current = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return [...new Set([...current, nextValue])];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function defaultMemoryPolicy(productId: string) {
  return {
    productId,
    status: 'draft' as const,
    namespaces: {
      session: ['viwork', productId, 'sessions', '{sessionId}', 'memories'],
      workspace: ['viwork', productId, 'workspaces', '{projectId}', 'memories'],
      global: ['viwork', productId, 'users', '{userId}', 'global', 'memories'],
    },
    recallOrder: ['session', 'workspace', 'global'] as Array<'session' | 'workspace' | 'global'>,
    writeRules: {
      user_explicit: 'allow' as const,
      file_derived: 'allow_with_evidence' as const,
      agent_inferred: 'confirm_for_long_term' as const,
      workflow_event: 'allow' as const,
    },
    conflictPolicy: 'formal_file_wins' as const,
    tombstoneRequired: true,
  };
}

function defaultRetrievalPolicy(productId: string) {
  return {
    productId,
    status: 'draft' as const,
    enabledTypes: ['mechanism', 'viewpoint', 'joke_pattern'] as Array<'mechanism' | 'viewpoint' | 'joke_pattern'>,
    defaultTopK: 5,
    rightsRiskMax: 'medium' as const,
    writeFlow: 'inbox_then_confirm' as const,
    forbiddenUse: ['copy_dialogue', 'copy_full_plot', 'copy_character_identity'],
    mockable: true,
  };
}

function defaultLayerConfig(productId: string, memoryPolicy: MemoryPolicy, retrievalPolicy: RetrievalPolicy) {
  return {
    productId,
    status: 'draft' as const,
    systemAgent: {
      agentId: 'system',
      promptBlockRefs: ['global-routing-policy@1'],
      allowedTools: ['read_workspace_file', 'write_workspace_file', 'delegate_to_specialist_agent'],
    },
    specialists: [
      { agentId: 'story-agent', skillRef: 'story-agent@1', promptBlockRefs: ['sitcom-story-quality@1'], defaultEnabled: true },
      { agentId: 'reviewer-agent', skillRef: 'reviewer-agent@1', promptBlockRefs: ['sitcom-review-rubric@1'], defaultEnabled: true },
      { agentId: 'screenwriter-agent', skillRef: 'screenwriter-agent@1', promptBlockRefs: ['sitcom-screenplay-quality@1'], defaultEnabled: true },
    ],
    memoryPolicyRef: `${memoryPolicy.id}@${memoryPolicy.version}`,
    retrievalPolicyRef: `${retrievalPolicy.id}@${retrievalPolicy.version}`,
    toolPolicyRef: 'workspace-safe-write@1',
    modelPolicyRef: 'default-chat-model@1',
  };
}

function defaultWorkspaceManifest(productId: string): Omit<WorkspaceManifest, 'id' | 'createdAt' | 'updatedAt'> {
  if (productId === 'sitcom') {
    return {
      productId,
      templateVersion: 1,
      status: 'active',
      requiredDirectories: ['01 基本设定', '02 故事', '03 剧本'],
      artifactTypes: {
        plan: { canonicalPath: '02 故事/01 第一集/单集大纲.md', requiredSections: ['主角目标', '主要阻力', '升级链条'] },
        script: { canonicalPath: '03 剧本/01 第一集/定稿剧本.md', requiredSections: ['冷开场', '正戏', '结尾'] },
      },
      validationRules: ['formal_file_wins_memory', 'reviewer_required_before_story_save'],
    };
  }
  return {
    productId,
    templateVersion: 1,
    status: 'active',
    requiredDirectories: ['01 原著资料', '02 改编方案', '03 剧本'],
    artifactTypes: {
      plan: { canonicalPath: '02 改编方案/01 第一集/单集改编方案.md', requiredSections: ['原著范围', '戏剧任务'] },
      script: { canonicalPath: '03 剧本/01 第一集/剧本.md', requiredSections: ['冷开场', '正戏', '结尾'] },
    },
    validationRules: ['formal_file_wins_memory', 'reviewer_required_before_script_save'],
  };
}
