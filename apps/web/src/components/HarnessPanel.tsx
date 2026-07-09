import { useEffect, useRef, useState } from 'react';

import { PRODUCT_PROFILES } from '@viforge/shared';
import type { AgentLayerConfig, AgentSpec, AgentSpecReleaseAuditCategory, AgentSpecReleaseForceReason, AgentSpecReleaseGate, ChatMessage, ChatSession, EvalRun, HarnessSummary, HarnessVersionDiff, HumanReviewRubric, MemoryPolicy, Project, PromptBlock, RetrievalPolicy, RunInputSnapshot, WorkspaceManifest } from '@viforge/shared';

import type { ApiClient } from '../api';

type HarnessPanelProps = {
  apiClient: ApiClient;
  standalone?: boolean;
};

type FixtureAssertionKind = 'changed-file' | 'heading' | 'forbidden-write' | 'max-changed' | 'allowed-section';
type PromptBlockGroupKey = 'system' | 'agent' | 'quality' | 'tool' | 'other';
type HarnessTab = 'config' | 'fixtures' | 'eval' | 'review' | 'release';

const HARNESS_VIEW_STATE_KEY = 'viforge:harness:view-state:v1';

type HarnessViewState = Partial<{
  activeHarnessTab: HarnessTab;
  productId: string;
  agentId: string;
  selectedAgentSpecId: string;
  selectedFixtureId: string;
  selectedEvalRunId: string;
  selectedSnapshotId: string;
  selectedRunArtifactId: string;
  evalRunMode: EvalRun['runMode'];
}>;

const PROMPT_BLOCK_SCOPE_LABELS: Record<PromptBlock['scope'], string> = {
  system: '系统流程规则',
  specialist: '角色职责边界',
  reviewer: '审稿规则',
  quality: '质量门槛',
  tool: '工具与落盘',
  other: '其他规则',
};

export function HarnessPanel({ apiClient, standalone = false }: HarnessPanelProps): JSX.Element {
  const initialViewState = readHarnessViewState();
  const [summary, setSummary] = useState<HarnessSummary | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState(initialViewState.selectedSnapshotId ?? '');
  const [selectedFixtureId, setSelectedFixtureId] = useState(initialViewState.selectedFixtureId ?? '');
  const [selectedAgentSpecId, setSelectedAgentSpecId] = useState(initialViewState.selectedAgentSpecId ?? '');
  const [agentSpecName, setAgentSpecName] = useState('');
  const [selectedEvalRunId, setSelectedEvalRunId] = useState(initialViewState.selectedEvalRunId ?? '');
  const [selectedRunArtifactId, setSelectedRunArtifactId] = useState(initialViewState.selectedRunArtifactId ?? '');
  const [agentId, setAgentId] = useState(initialViewState.agentId ?? 'story-agent');
  const [productId, setProductId] = useState(initialViewState.productId ?? Object.keys(PRODUCT_PROFILES)[0] ?? 'novel-adaptation');
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
  const [selectedAssertionIds, setSelectedAssertionIds] = useState<string[]>([]);
  const [fixtureName, setFixtureName] = useState('');
  const [fixtureSourceProjectId, setFixtureSourceProjectId] = useState('');
  const [fixtureSourceSessionId, setFixtureSourceSessionId] = useState('');
  const [fixtureMessageId, setFixtureMessageId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [fixtureSessions, setFixtureSessions] = useState<ChatSession[]>([]);
  const [fixtureCreateFeedback, setFixtureCreateFeedback] = useState('');
  const [evalRunFeedback, setEvalRunFeedback] = useState('');
  const [selectedRubricId, setSelectedRubricId] = useState('');
  const [evalRunMode, setEvalRunMode] = useState<EvalRun['runMode']>(initialViewState.evalRunMode ?? 'repro');
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
  const [promptBlockScope, setPromptBlockScope] = useState<PromptBlock['scope']>('quality');
  const [newPromptBlockTitle, setNewPromptBlockTitle] = useState('');
  const [newPromptBlockContent, setNewPromptBlockContent] = useState('');
  const [newPromptBlockScope, setNewPromptBlockScope] = useState<PromptBlock['scope']>('quality');
  const [selectedPromptBlockRef, setSelectedPromptBlockRef] = useState('');
  const [selectedPromptBlockId, setSelectedPromptBlockId] = useState('');
  const [promptBlockVersion, setPromptBlockVersion] = useState('latest');
  const [agentInstructionContent, setAgentInstructionContent] = useState('');
  const [activeHarnessTab, setActiveHarnessTab] = useState<HarnessTab>(initialViewState.activeHarnessTab ?? 'config');
  const [versionDiff, setVersionDiff] = useState<HarnessVersionDiff | null>(null);
  const loadedPromptBlockEditorRef = useRef('');
  const loadedFixtureAssertionsRef = useRef('');
  const fixtureAssertionsDirtyRef = useRef(false);
  const actionLockRef = useRef(false);

  async function loadSummary(options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) {
      setState('loading');
      setError(null);
    }
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
      if (!options.silent) setState('idle');
    }
  }

  useEffect(() => {
    void loadSummary();
    void loadProjectsForFixtures();
  }, []);

  useEffect(() => {
    writeHarnessViewState({
      activeHarnessTab,
      productId,
      agentId,
      selectedAgentSpecId,
      selectedFixtureId,
      selectedEvalRunId,
      selectedSnapshotId,
      selectedRunArtifactId,
      evalRunMode,
    });
  }, [activeHarnessTab, productId, agentId, selectedAgentSpecId, selectedFixtureId, selectedEvalRunId, selectedSnapshotId, selectedRunArtifactId, evalRunMode]);

  useEffect(() => {
    if (!summary?.evalRuns.some((run) => run.status === 'running' || run.status === 'pending')) return;
    const interval = window.setInterval(() => {
      void loadSummary({ silent: true });
    }, 2_500);
    return () => window.clearInterval(interval);
  }, [summary?.evalRuns]);

  async function loadProjectsForFixtures(): Promise<void> {
    try {
      const nextProjects = await apiClient.listProjects();
      setProjects(nextProjects);
      setFixtureSourceProjectId((current) => current || nextProjects[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取项目列表失败');
    }
  }

  useEffect(() => {
    if (!fixtureSourceProjectId) return;
    void loadFixtureSessions(fixtureSourceProjectId);
  }, [fixtureSourceProjectId]);

  async function loadFixtureSessions(projectId: string): Promise<void> {
    try {
      const sessions = await apiClient.listChatSessions(projectId, { includeArchived: true, kind: 'assistant' });
      setFixtureSessions(sessions);
      setFixtureSourceSessionId((current) => sessions.some((session) => session.id === current) ? current : sessions[0]?.id ?? '');
      setFixtureMessageId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取历史会话失败');
    }
  }

  useEffect(() => {
    if (!summary) return;
    const specsForAgent = summary.agentSpecs
      .filter((spec) => spec.productId === productId && spec.agentId === agentId)
      .sort((left, right) => {
        if (left.status === 'active' && right.status !== 'active') return -1;
        if (right.status === 'active' && left.status !== 'active') return 1;
        return right.version - left.version;
      });
    if (!specsForAgent.some((spec) => spec.id === selectedAgentSpecId)) {
      setSelectedAgentSpecId(specsForAgent[0]?.id ?? '');
    }
  }, [agentId, productId, selectedAgentSpecId, summary]);

  useEffect(() => {
    const fixture = summary?.evalFixtures.find((item) => item.id === selectedFixtureId);
    const nextText = fixture ? JSON.stringify(fixture.assertions, null, 2) : '';
    if (loadedFixtureAssertionsRef.current !== selectedFixtureId) {
      loadedFixtureAssertionsRef.current = selectedFixtureId;
      fixtureAssertionsDirtyRef.current = false;
      setFixtureAssertionsText(nextText);
      setSelectedAssertionIds([]);
      return;
    }
    if (!fixtureAssertionsDirtyRef.current && nextText !== fixtureAssertionsText) {
      setFixtureAssertionsText(nextText);
    }
  }, [selectedFixtureId, summary]);

  useEffect(() => {
    const run = summary?.evalRuns.find((item) => item.id === selectedEvalRunId);
    setReviewAnnotations(run?.humanReview?.annotations ?? []);
  }, [selectedEvalRunId, summary]);

  useEffect(() => {
    const blocks = summary?.promptBlocks ?? [];
    const block = promptBlockVersion === 'latest'
      ? latestPromptBlock(blocks, selectedPromptBlockId)
      : blocks.find((item) => item.id === selectedPromptBlockId && item.version === Number(promptBlockVersion));
    if (!block) return;
    const editorKey = `${block.id}@${block.version}`;
    if (loadedPromptBlockEditorRef.current === editorKey) return;
    loadedPromptBlockEditorRef.current = editorKey;
    setPromptBlockTitle(block.title);
    setPromptBlockContent(block.content);
    setPromptBlockScope(block.scope);
    setSelectedPromptBlockRef(`${block.id}@${block.version}`);
  }, [promptBlockVersion, selectedPromptBlockId, summary]);

  useEffect(() => {
    setPromptBlockVersion('latest');
  }, [selectedPromptBlockId]);

  useEffect(() => {
    const currentActiveSpec = summary?.agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
    const layerConfig = currentActiveSpec?.layerConfigRef
      ? summary?.agentLayerConfigs.find((config) => config.id === currentActiveSpec.layerConfigRef || `${config.id}@${config.version}` === currentActiveSpec.layerConfigRef)
      : summary?.agentLayerConfigs.find((config) => config.productId === productId && config.status === 'active');
    if (!layerConfig) {
      setAgentInstructionContent('');
      return;
    }
    const instruction = agentId === 'system'
      ? layerConfig.systemAgent.instructionOverride
      : layerConfig.specialists.find((specialist) => specialist.agentId === agentId)?.instructionOverride;
    setAgentInstructionContent(instruction ?? '');
  }, [agentId, productId, summary]);

  async function createAgentSpec(): Promise<void> {
    if (actionLockRef.current) return;
    if (!canCreateAgentSpec) {
      setError('没有检测到配置变化：请先选择一条不同的行为规则');
      return;
    }
    actionLockRef.current = true;
    setState('saving');
    setError(null);
    try {
      const baseSpec = activeAgentSpec ?? agentSpecs
        .filter((spec) => spec.productId === productId && spec.agentId === agentId)
        .sort((left, right) => right.version - left.version)[0];
      const nextPromptBlockRefs = selectedPromptBlockRef
        ? replaceVersionedRef(baseSpec?.promptBlockRefs ?? [], selectedPromptBlockRef)
        : (baseSpec?.promptBlockRefs ?? []);
      const created = await apiClient.createAgentSpec({
        productId,
        name: agentSpecName.trim() || undefined,
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
      setAgentSpecName('');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 AgentSpec 失败');
    } finally {
      actionLockRef.current = false;
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
        name: agentSpecName.trim() || undefined,
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
    if (actionLockRef.current) return;
    if (!newPromptBlockTitle.trim() || !newPromptBlockContent.trim()) {
      setError('行为规则标题和内容都需要填写');
      return;
    }
    actionLockRef.current = true;
    setState('saving');
    setError(null);
    try {
      const promptBlock = await apiClient.createPromptBlock({
        productId,
        status: 'draft',
        title: newPromptBlockTitle.trim(),
        scope: newPromptBlockScope,
        content: newPromptBlockContent.trim(),
      });
      setSelectedPromptBlockId(promptBlock.id);
      setSelectedPromptBlockRef(`${promptBlock.id}@${promptBlock.version}`);
      const baseSpec = activeAgentSpec ?? agentSpecs
        .filter((spec) => spec.productId === productId && spec.agentId === agentId)
        .sort((left, right) => right.version - left.version)[0];
      const spec = await apiClient.createAgentSpec({
        productId,
        name: agentSpecName.trim() || undefined,
        agentId,
        status: 'draft',
        layerConfigRef: baseSpec?.layerConfigRef,
        promptBlockRefs: replaceVersionedRef(baseSpec?.promptBlockRefs ?? [], `${promptBlock.id}@${promptBlock.version}`),
        skillRefs: baseSpec?.skillRefs ?? [],
        memoryPolicyRef: baseSpec?.memoryPolicyRef,
        retrievalPolicyRef: baseSpec?.retrievalPolicyRef,
        toolPolicyRef: baseSpec?.toolPolicyRef,
        modelPolicyRef: baseSpec?.modelPolicyRef,
        changelog: baseSpec ? `Created from ${baseSpec.id} with new behavior rule ${promptBlock.id}@${promptBlock.version}.` : 'Created with explicit behavior rule model.',
      });
      setSelectedAgentSpecId(spec.id);
      setAgentSpecName('');
      setNewPromptBlockTitle('');
      setNewPromptBlockContent('');
      setNewPromptBlockScope(promptBlockScopeOptions(agentId, 'quality').includes('quality') ? 'quality' : promptBlockScopeOptions(agentId, 'specialist')[0] ?? 'other');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 Agent 行为规则失败');
    } finally {
      actionLockRef.current = false;
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

  async function savePromptBlockVersion(): Promise<void> {
    const block = selectedPromptBlock;
    if (!block) {
      setError('请先选择一条要修改的行为规则');
      return;
    }
    if (!promptBlockTitle.trim() || !promptBlockContent.trim()) {
      setError('行为规则标题和内容都需要填写');
      return;
    }
    if (!editedPromptBlockChanged) {
      setError('行为规则没有变化，不需要保存新版本');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.createPromptBlockVersion(block.id, {
        title: promptBlockTitle,
        scope: promptBlockScope,
        content: promptBlockContent,
        status: 'candidate',
      });
      setSelectedPromptBlockId(created.id);
      setPromptBlockVersion(String(created.version));
      setSelectedPromptBlockRef(`${created.id}@${created.version}`);
      const baseSpec = activeAgentSpec ?? agentSpecs
        .filter((spec) => spec.productId === productId && spec.agentId === agentId)
        .sort((left, right) => right.version - left.version)[0];
      if (baseSpec) {
        const createdSpec = await apiClient.createAgentSpec({
          productId,
          name: agentSpecName.trim() || undefined,
          agentId,
          status: 'draft',
          layerConfigRef: baseSpec.layerConfigRef,
          promptBlockRefs: replaceVersionedRef(baseSpec.promptBlockRefs ?? [], `${created.id}@${created.version}`),
          skillRefs: baseSpec.skillRefs ?? [],
          memoryPolicyRef: baseSpec.memoryPolicyRef,
          retrievalPolicyRef: baseSpec.retrievalPolicyRef,
          toolPolicyRef: baseSpec.toolPolicyRef,
          modelPolicyRef: baseSpec.modelPolicyRef,
          changelog: `Created from ${baseSpec.id} with edited behavior rule ${created.id}@${created.version}.`,
        });
        setSelectedAgentSpecId(createdSpec.id);
      }
      await loadSummary();
      setVersionDiff(await apiClient.getPromptBlockDiff(created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存行为规则新版本失败');
    } finally {
      setState('idle');
    }
  }

  async function saveAgentInstructionOverride(): Promise<void> {
    const currentActiveSpec = summary?.agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
    if (!currentActiveSpec?.layerConfigRef) {
      setError('当前 agent 缺少可复制的 active layer config');
      return;
    }
    const baseLayer = (summary?.agentLayerConfigs ?? []).find((config) => config.id === currentActiveSpec.layerConfigRef || `${config.id}@${config.version}` === currentActiveSpec.layerConfigRef);
    if (!baseLayer) {
      setError('找不到当前 active layer config');
      return;
    }
    if (!agentInstructionContent.trim()) {
      setError('Agent 主体提示词不能为空');
      return;
    }
    if (!agentInstructionChanged) {
      setError('主体提示词没有变化，不需要保存候选版本');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const nextLayer = await apiClient.createAgentLayerConfig({
        ...baseLayer,
        status: 'candidate',
        systemAgent: agentId === 'system'
          ? { ...baseLayer.systemAgent, instructionOverride: agentInstructionContent }
          : baseLayer.systemAgent,
        specialists: baseLayer.specialists.map((specialist) => specialist.agentId === agentId
          ? { ...specialist, instructionOverride: agentInstructionContent }
          : specialist),
      });
      const nextSpec = await apiClient.createAgentSpec({
        productId,
        name: agentSpecName.trim() || undefined,
        agentId,
        status: 'draft',
        layerConfigRef: nextLayer.id,
        promptBlockRefs: currentActiveSpec.promptBlockRefs,
        skillRefs: currentActiveSpec.skillRefs,
        memoryPolicyRef: currentActiveSpec.memoryPolicyRef,
        retrievalPolicyRef: currentActiveSpec.retrievalPolicyRef,
        toolPolicyRef: currentActiveSpec.toolPolicyRef,
        modelPolicyRef: currentActiveSpec.modelPolicyRef,
        changelog: `Created from ${currentActiveSpec.id} with edited ${agentId} instruction override.`,
      });
      setSelectedAgentSpecId(nextSpec.id);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 Agent 主体提示词失败');
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
        name: fixtureName.trim() || undefined,
        target: `${agentId}-workflow`,
        tags: ['manual'],
      });
      setSelectedFixtureId(created.id);
      setFixtureCreateFeedback(`已创建 Fixture：${formatFixture(created)}`);
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
        name: fixtureName.trim() || undefined,
        target: `${agentId}-workflow`,
        tags: ['from-run-artifact'],
      });
      setSelectedFixtureId(created.id);
      setFixtureCreateFeedback(`已创建 Fixture：${formatFixture(created)}`);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '从 RunArtifact 创建 EvalFixture 失败');
    } finally {
      setState('idle');
    }
  }

  async function createFixtureFromChatMessage(): Promise<void> {
    const session = fixtureSessions.find((item) => item.id === fixtureSourceSessionId);
    if (!session) {
      setError('请先选择一个历史会话');
      return;
    }
    const message = session.messages.find((item) => item.id === fixtureMessageId);
    if (!message) {
      setError('请先选择一条用户消息');
      return;
    }
    const anchorRunId = findRunIdForMessage(session, message.id);
    const artifact = anchorRunId ? runArtifacts.find((item) => item.runId === anchorRunId) : undefined;
    const snapshotId = artifact?.inputSnapshotId ?? findSnapshotForRunOrSession(snapshots, anchorRunId, session.id)?.id;
    if (!snapshotId) {
      setError('所选消息没有可用 snapshot。请换一条已经触发过 agent run 的用户消息。');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const inputMessages = buildFixtureInputMessages(session.messages, message.id);
      const target = `${agentId}-workflow`;
      const name = fixtureName.trim() || `${session.title} · ${message.content.slice(0, 24)}`;
      const created = artifact
        ? await apiClient.createEvalFixtureFromRunArtifact(artifact.runId, {
            snapshotId,
            name,
            target,
            inputMessages,
            tags: ['from-chat', session.title],
          })
        : await apiClient.createEvalFixture({
            snapshotId,
            name,
            target,
            inputMessages,
            tags: ['from-chat', session.title],
          });
      setSelectedFixtureId(created.id);
      setFixtureCreateFeedback(`已从历史消息创建 Fixture：${formatFixture(created)}`);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '从历史对话创建 Fixture 失败');
    } finally {
      setState('idle');
    }
  }

  async function createEvalRun(): Promise<void> {
    if (!selectedFixtureId || !selectedAgentSpecId) {
      setError(!selectedAgentSpecId ? '请先选择候选 AgentSpec，再创建 EvalRun' : '请先选择评测案例，再创建 EvalRun');
      return;
    }
    setState('saving');
    setError(null);
    setEvalRunFeedback('正在创建 EvalRun...');
    try {
      const created = await apiClient.createEvalRun({ fixtureId: selectedFixtureId, agentSpecId: selectedAgentSpecId, runMode: evalRunMode });
      setSelectedEvalRunId(created.id);
      setEvalRunFeedback(`EvalRun 已启动：${created.id.slice(0, 18)}。运行中会自动刷新详情。`);
      await loadSummary();
    } catch (err) {
      setEvalRunFeedback('');
      setError(err instanceof Error ? err.message : '创建 EvalRun 失败');
    } finally {
      setState('idle');
    }
  }

  async function saveFixtureAssertions(): Promise<void> {
    if (!selectedFixtureId) return;
    setState('saving');
    setError(null);
    setEvalRunFeedback('正在保存断言...');
    try {
      const assertions = JSON.parse(fixtureAssertionsText || '{}') as Record<string, unknown>;
      await apiClient.updateEvalFixture(selectedFixtureId, { assertions });
      fixtureAssertionsDirtyRef.current = false;
      setEvalRunFeedback('断言已保存，可以创建 EvalRun');
      await loadSummary();
    } catch (err) {
      setEvalRunFeedback('');
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
    fixtureAssertionsDirtyRef.current = false;
    await patchSelectedFixture({ assertions: next });
  }

  async function removeSelectedFixtureAssertions(): Promise<void> {
    if (!selectedFixtureId || selectedAssertionIds.length === 0) return;
    const current = parseAssertionsText(fixtureAssertionsText);
    const next = selectedAssertionIds.reduce((assertions, assertionId) => removeAssertionById(assertions, assertionId), current);
    setFixtureAssertionsText(JSON.stringify(next, null, 2));
    setSelectedAssertionIds([]);
    fixtureAssertionsDirtyRef.current = false;
    await patchSelectedFixture({ assertions: next });
  }

  function toggleFixtureAssertion(assertionId: string): void {
    setSelectedAssertionIds((current) => current.includes(assertionId)
      ? current.filter((id) => id !== assertionId)
      : [...current, assertionId]);
  }

  function toggleAllFixtureAssertions(assertions: AssertionRow[]): void {
    setSelectedAssertionIds((current) => current.length === assertions.length ? [] : assertions.map((assertion) => assertion.id));
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
  const relevantPromptBlocks = promptBlocks.filter((block) => block.productId === productId && isPromptBlockRelevantToAgent(block, agentId, selectedPromptBlockRef));
  const promptBlockOptions = relevantPromptBlocks.sort((left, right) => right.version - left.version);
  const promptBlockGroups = buildPromptBlockGroups(relevantPromptBlocks);
  const selectedPromptBlockVersions = promptBlocks
    .filter((block) => block.id === selectedPromptBlockId)
    .sort((left, right) => right.version - left.version);
  const selectedPromptBlock = latestPromptBlock(promptBlocks, selectedPromptBlockId);
  const selectedPromptBlockForEdit = promptBlockVersion === 'latest'
    ? selectedPromptBlock
    : promptBlocks.find((block) => block.id === selectedPromptBlockId && block.version === Number(promptBlockVersion));
  const selectedAgentSpec = agentSpecs.find((spec) => spec.id === selectedAgentSpecId);
  const selectedAgentSpecPreview = selectedAgentSpec ? buildAgentSpecPreview(selectedAgentSpec, { layerConfigs, promptBlocks, memoryPolicies, retrievalPolicies, workspaceManifests }) : null;
  const activeAgentSpec = agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
  const activeAgentLayerConfig = activeAgentSpec?.layerConfigRef
    ? layerConfigs.find((config) => config.id === activeAgentSpec.layerConfigRef || `${config.id}@${config.version}` === activeAgentSpec.layerConfigRef)
    : layerConfigs.find((config) => config.productId === productId && config.status === 'active');
  const activeAgentInstruction = agentId === 'system'
    ? activeAgentLayerConfig?.systemAgent.instructionOverride ?? ''
    : activeAgentLayerConfig?.specialists.find((specialist) => specialist.agentId === agentId)?.instructionOverride ?? '';
  const activeAgentSpecPreview = activeAgentSpec ? buildAgentSpecPreview(activeAgentSpec, { layerConfigs, promptBlocks, memoryPolicies, retrievalPolicies, workspaceManifests }) : null;
  const defaultPromptBlock = promptBlocks.find((block) => block.productId === productId && block.status === 'active' && block.scope !== 'tool');
  const defaultPromptBlockRef = defaultPromptBlock ? `${defaultPromptBlock.id}@${defaultPromptBlock.version}` : '';
  const selectedPromptBlockPreview = buildPromptBlockPreview(selectedPromptBlockRef || defaultPromptBlockRef, promptBlocks);
  const hasHarnessBasics = layerConfigs.some((config) => config.productId === productId)
    && memoryPolicies.some((policy) => policy.productId === productId)
    && retrievalPolicies.some((policy) => policy.productId === productId)
    && workspaceManifests.some((manifest) => manifest.productId === productId);
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId);
  const selectedFixtureAssertionRows = selectedFixture ? buildAssertionRows(parseAssertionsText(fixtureAssertionsText)) : [];
  const selectedFixtureSession = fixtureSessions.find((session) => session.id === fixtureSourceSessionId);
  const selectableFixtureMessages = selectedFixtureSession?.messages.filter((message) => message.role === 'user') ?? [];
  const selectedFixtureMessage = selectableFixtureMessages.find((message) => message.id === fixtureMessageId);
  const selectedFixtureRunId = selectedFixtureSession && selectedFixtureMessage ? findRunIdForMessage(selectedFixtureSession, selectedFixtureMessage.id) : undefined;
  const selectedFixtureArtifact = selectedFixtureRunId ? runArtifacts.find((artifact) => artifact.runId === selectedFixtureRunId) : undefined;
  const selectedFixtureSnapshot = findSnapshotForRunOrSession(snapshots, selectedFixtureRunId, fixtureSourceSessionId);
  const selectedEvalRun = evalRuns.find((run) => run.id === selectedEvalRunId);
  const selectedRubric = rubrics.find((rubric) => rubric.id === selectedRubricId) ?? rubrics.find((rubric) => rubric.productId === productId) ?? rubrics[0];
  const reviewedRuns = evalRuns.filter((run) => run.humanReview).slice().sort((left, right) => (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt));
  const selectedSpecRuns = selectedAgentSpecId ? evalRuns.filter((run) => run.agentSpecId === selectedAgentSpecId) : [];
  const selectedSpecReviewStats = summarizeHumanReviews(selectedSpecRuns);
  const createEvalRunBlockedReason = !selectedAgentSpecId
    ? '需要先选择候选 AgentSpec'
    : !selectedFixtureId
      ? '需要先选择评测案例'
      : '';
  const editedPromptBlockChanged = Boolean(selectedPromptBlockForEdit)
    && (promptBlockTitle.trim() !== (selectedPromptBlockForEdit?.title ?? '')
      || promptBlockContent.trim() !== (selectedPromptBlockForEdit?.content ?? '')
      || promptBlockScope !== selectedPromptBlockForEdit?.scope);
  const agentInstructionChanged = agentInstructionContent.trim() !== activeAgentInstruction.trim();
  const selectedPromptBlockChangedFromActive = Boolean(selectedPromptBlockRef)
    && !(activeAgentSpec?.promptBlockRefs ?? []).includes(selectedPromptBlockRef);
  const canCreateAgentSpec = Boolean(!activeAgentSpec || selectedPromptBlockChangedFromActive);

  return (
    <div className={`harness-panel${standalone ? ' harness-panel--standalone' : ''}`}>
      <div className="harness-toolbar">
        <label className="harness-global-product"><span>产品</span><select value={productId} onChange={(event) => setProductId(event.target.value)}>{productOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <button type="button" onClick={() => void loadSummary()} disabled={state !== 'idle'}>刷新</button>
      </div>
      {error ? <p className="git-result error">{error}</p> : null}
      {state === 'loading' ? <p className="muted">正在读取 Harness 状态...</p> : null}

      <div className="harness-workflow harness-workflow--pipeline" role="tablist" aria-label="Agent Harness 流程">
        <WorkflowStep index="1" title="配置候选" detail="选择产品、agent、行为规则并生成 draft spec。" active={activeHarnessTab === 'config'} onClick={() => setActiveHarnessTab('config')} />
        <WorkflowStep index="2" title="沉淀案例" detail="从 snapshot 或失败 artifact 固定复现输入。" active={activeHarnessTab === 'fixtures'} onClick={() => setActiveHarnessTab('fixtures')} />
        <WorkflowStep index="3" title="执行评测" detail="用 Repro/Live 跑 fixture 并比较 active/candidate。" active={activeHarnessTab === 'eval'} onClick={() => setActiveHarnessTab('eval')} />
        <WorkflowStep index="4" title="人工审阅" detail="评分、行备注和退化判断。" active={activeHarnessTab === 'review'} onClick={() => setActiveHarnessTab('review')} />
        <WorkflowStep index="5" title="发布运行" detail="评测通过后激活或审计回滚。" active={activeHarnessTab === 'release'} onClick={() => setActiveHarnessTab('release')} />
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

      {activeHarnessTab === 'config' ? <section className="harness-section harness-pipeline-node harness-config-node">
        <NodeHeader index="1" title="配置候选" description="一个 Agent 行为规则可以被多个 AgentSpec 引用，也就能被多个 agent 复用；是否复用由评测结果证明，而不是默认共享。" />
        <div className="harness-config-workspace">
          <div className="harness-config-main">
            <div className={`harness-readiness ${hasHarnessBasics ? 'ready' : 'blocked'}`}>
              <strong>{hasHarnessBasics ? '评测基础已就绪' : '当前产品缺少评测基础'}</strong>
              <small>{hasHarnessBasics ? '日常调试只需要创建候选 AgentSpec。' : '首次使用该产品时，先初始化默认分层、记忆、检索和 manifest。'}</small>
            </div>
            <div className="harness-config-group">
              <div className="harness-config-group__heading"><span>01</span><strong>选择目标 Agent</strong><small>当前产品：{productId}。先确定本次要观察和修改哪一个 agent。</small></div>
              <div className="harness-form-grid">
                <label><span>Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agentOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
              </div>
              <details className="harness-advanced-editor">
                <summary>高级：编辑 Agent 主体提示词</summary>
                <label className="harness-field harness-field--wide"><span>主体提示词</span><textarea value={agentInstructionContent} onChange={(event) => setAgentInstructionContent(event.target.value)} rows={10} placeholder="角色定位、职责、主体流程等…" /></label>
                <div className="harness-action-row">
                  <button type="button" onClick={() => void saveAgentInstructionOverride()} disabled={state !== 'idle' || !activeAgentSpec || !agentInstructionContent.trim() || !agentInstructionChanged}>保存主体为候选配置</button>
                </div>
              </details>
            </div>
            <div className="harness-config-group">
              <div className="harness-config-group__heading"><span>02</span><strong>调整行为规则</strong><small>只显示当前 agent 相关规则；不选择时沿用现有绑定。</small></div>
              <div className="harness-form-grid">
                <label><span>Agent 行为规则</span><select value={selectedPromptBlockRef} onChange={(event) => {
                  const nextRef = event.target.value;
                  setSelectedPromptBlockRef(nextRef);
                  setSelectedPromptBlockId(nextRef ? parseVersionRef(nextRef).id : '');
                  setPromptBlockVersion(nextRef ? String(parseVersionRef(nextRef).version ?? 'latest') : 'latest');
                }}><option value="">沿用当前规则，不新增绑定</option>{promptBlockGroups.map((group) => <optgroup key={group.group} label={formatPromptBlockGroupName(group.group)}>{group.blocks.map((block) => <option key={`${block.id}@${block.version}`} value={`${block.id}@${block.version}`}>{block.title} · v{block.version} · {block.status}</option>)}</optgroup>)}</select></label>
              </div>
              <p className="muted">行为规则下拉框为空时，会从当前 active/candidate 复制已有规则，不会清空旧规则。选择某条规则时，会把同 id 的旧版本替换为所选版本。</p>
              <details className="harness-advanced-editor">
                <summary>查看/修改当前 Agent 行为规则</summary>
                <label className="harness-field"><span>规则版本</span><select value={promptBlockVersion} onChange={(event) => setPromptBlockVersion(event.target.value)} disabled={!selectedPromptBlockId}>
                  <option value="latest">最新版本</option>
                  {selectedPromptBlockVersions.map((block) => <option key={`${block.id}@${block.version}`} value={String(block.version)}>v{block.version} · {block.status}</option>)}
                </select></label>
                <label className="harness-field"><span>规则标题</span><input value={promptBlockTitle} onChange={(event) => setPromptBlockTitle(event.target.value)} placeholder="行为规则标题…" /></label>
                <label className="harness-field"><span>规则类型</span><select value={promptBlockScope} onChange={(event) => setPromptBlockScope(event.target.value as PromptBlock['scope'])}>
                  {promptBlockScopeOptions(agentId, promptBlockScope).map((scope) => <option key={scope} value={scope}>{PROMPT_BLOCK_SCOPE_LABELS[scope]}</option>)}
                </select></label>
                <label className="harness-field harness-field--wide"><span>规则内容</span><textarea value={promptBlockContent} onChange={(event) => setPromptBlockContent(event.target.value)} rows={10} placeholder="编辑后会保存为新版本…" /></label>
                <div className="harness-action-row">
                  <button type="button" onClick={() => void savePromptBlockVersion()} disabled={state !== 'idle' || !selectedPromptBlockId || !promptBlockTitle.trim() || !promptBlockContent.trim() || !editedPromptBlockChanged}>保存为新版本并生成候选配置</button>
                  <button type="button" onClick={() => void loadPromptBlockDiff()} disabled={state !== 'idle' || !selectedPromptBlockId}>查看规则 diff</button>
                </div>
                {versionDiff ? <VersionDiffView diff={versionDiff} /> : <p className="muted">选择一条行为规则后，可查看最近两个版本的 diff。</p>}
              </details>
              <details className="harness-advanced-editor">
                <summary>高级：新建 Agent 行为规则</summary>
                <label className="harness-field"><span>规则标题</span><input value={newPromptBlockTitle} onChange={(event) => setNewPromptBlockTitle(event.target.value)} placeholder="行为规则标题…" /></label>
                <label className="harness-field"><span>规则类型</span><select value={newPromptBlockScope} onChange={(event) => setNewPromptBlockScope(event.target.value as PromptBlock['scope'])}>
                  {promptBlockScopeOptions(agentId, newPromptBlockScope).map((scope) => <option key={scope} value={scope}>{PROMPT_BLOCK_SCOPE_LABELS[scope]}</option>)}
                </select>
                </label>
                <label className="harness-field harness-field--wide"><span>规则内容</span><textarea value={newPromptBlockContent} onChange={(event) => setNewPromptBlockContent(event.target.value)} rows={4} placeholder="只写 agent 应该如何工作…" /></label>
                <div className="harness-action-row">
                  <button type="button" onClick={() => void createPromptBlockModel()} disabled={state !== 'idle' || !newPromptBlockTitle.trim() || !newPromptBlockContent.trim()}>创建规则并生成候选配置</button>
                </div>
              </details>
            </div>
            <div className="harness-config-group">
              <div className="harness-config-group__heading"><span>03</span><strong>生成候选配置</strong><small>给候选命名，方便后续评测、对比和发布时识别。</small></div>
              <div className="harness-candidate-create">
                <label className="harness-field"><span>候选名称</span><input value={agentSpecName} onChange={(event) => setAgentSpecName(event.target.value)} placeholder="例如 story-agent 目标更明确…" /></label>
                <button type="button" onClick={() => void createAgentSpec()} disabled={state !== 'idle' || !canCreateAgentSpec} title="创建一个未发布的候选配置，用于后续评估。">创建候选 AgentSpec</button>
              </div>
              <div className="harness-candidate-select">
                <label className="harness-field"><span>候选配置</span><select value={selectedAgentSpecId} onChange={(event) => setSelectedAgentSpecId(event.target.value)}>
                  <option value="">选择 AgentSpec</option>
                  {agentSpecs.filter((spec) => spec.productId === productId && spec.agentId === agentId).map((spec) => <option key={spec.id} value={spec.id}>{formatAgentSpec(spec)}</option>)}
                </select></label>
                <div className="harness-action-row harness-candidate-actions">
                  <button type="button" onClick={() => void archiveSelectedAgentSpec()} disabled={state !== 'idle' || !selectedAgentSpecId || selectedAgentSpec?.status === 'active'} title="删除未被任何评测或发布引用的草稿候选。">删除候选</button>
                  {!hasHarnessBasics ? <button type="button" onClick={() => void createDefaults()} disabled={state !== 'idle'} title="首次接入产品时创建默认 layer、memory、retrieval、manifest 和一条示例知识卡。">初始化评测基础</button> : null}
                </div>
              </div>
            </div>
          </div>
          <aside className="harness-context-preview" aria-label="当前 agent 上下文全貌">
            <div className="harness-context-preview__header">
              <span>Agent 上下文全貌</span>
              <strong>{productId}/{agentId}</strong>
            </div>
            <AgentSpecPreview title="当前 active" preview={activeAgentSpecPreview} emptyText="当前产品/agent 还没有 active AgentSpec" mode="context" />
            <AgentSpecDiff active={activeAgentSpecPreview} candidate={selectedAgentSpecPreview} />
            <AgentSpecPreview title="选中候选" preview={selectedAgentSpecPreview} emptyText="请选择或创建候选 AgentSpec" mode="full" />
          </aside>
        </div>
      </section> : null}

      {activeHarnessTab === 'config' ? <details className="harness-section harness-secondary-section">
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
      </details> : null}

      {activeHarnessTab === 'fixtures' ? <section className="harness-section harness-pipeline-node">
        <NodeHeader index="2" title="沉淀案例" description="选择一条历史用户消息，恢复这次请求前的 workspace snapshot，再用同一输入评测候选 AgentSpec。" />
        <div className="harness-config-group">
          <div className="harness-config-group__heading"><span>01</span><strong>从历史消息构造案例</strong><small>一个 Fixture 只对应一次用户请求。</small></div>
          <div className="harness-form-grid">
            <label><span>案例名称</span><input value={fixtureName} onChange={(event) => setFixtureName(event.target.value)} placeholder="例如 业主群误会退化案例…" /></label>
            <label><span>项目</span><select value={fixtureSourceProjectId} onChange={(event) => setFixtureSourceProjectId(event.target.value)}>
              <option value="">选择项目</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.productId ?? 'default'}</option>)}
            </select></label>
            <label className="harness-field--wide"><span>历史会话</span><select value={fixtureSourceSessionId} onChange={(event) => { setFixtureSourceSessionId(event.target.value); setFixtureMessageId(''); }}>
              <option value="">选择会话</option>
              {fixtureSessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.messages.length} messages · {formatDateTime(session.updatedAt)}</option>)}
            </select></label>
          </div>
          <div className="harness-message-picker">
            <strong>选择一条用户消息</strong>
            <p className="muted">只能选择一条消息。Fixture 会使用这条消息对应 run 的输入快照；agent 输出只作为预期结果来源，不会被拼回输入。</p>
            {selectableFixtureMessages.length > 0 ? selectableFixtureMessages.map((message) => (
              <label key={message.id}>
                <input
                  type="radio"
                  name="harness-fixture-message"
                  checked={fixtureMessageId === message.id}
                  onChange={() => setFixtureMessageId(message.id)}
                />
                <span>用户 · {formatDateTime(message.createdAt)}</span>
                <small>{message.content || summarizeMessageEvents(message)}</small>
              </label>
            )) : <small className="muted">当前会话没有可作为回归输入的用户消息</small>}
          </div>
          <div className="harness-fixture-build-summary">
            <strong>将创建 1 个 Fixture</strong>
            <small>会话：{selectedFixtureSession?.title ?? '未选择'}</small>
            <small>输入：{selectedFixtureMessage ? selectedFixtureMessage.content.slice(0, 80) : '未选择消息'}</small>
            <small>RunArtifact：{selectedFixtureArtifact ? `${selectedFixtureArtifact.status} · ${selectedFixtureArtifact.fileDiff.length} diffs` : '未匹配，将只使用 snapshot'}</small>
            <small>Snapshot：{selectedFixtureSnapshot ? `${selectedFixtureSnapshot.projectId.slice(0, 8)} · ${selectedFixtureSnapshot.fileManifest.length} files` : '未匹配'}</small>
          </div>
          <div className="harness-action-row">
            <button type="button" onClick={() => void createFixtureFromChatMessage()} disabled={state !== 'idle' || !fixtureSourceSessionId || !fixtureMessageId}>从这条消息创建 Fixture</button>
          </div>
          {fixtureCreateFeedback ? <p className="git-result success">{fixtureCreateFeedback}</p> : null}
        </div>
      </section> : null}

      {activeHarnessTab === 'fixtures' ? <section className="harness-section">
        <details className="harness-secondary-section">
        <summary>底层来源（调试用）</summary>
        <p className="muted">Snapshot 是运行前工作区快照；RunArtifact 是一次历史运行的输出、文件 diff 和工具事件。日常创建回归案例优先使用上面的历史对话入口。</p>
        <div className="harness-form-grid">
          <label><span>Snapshot</span><select value={selectedSnapshotId} onChange={(event) => setSelectedSnapshotId(event.target.value)}>
            <option value="">选择 Snapshot</option>
            {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{formatSnapshot(snapshot)}</option>)}
          </select></label>
          <label><span>RunArtifact</span><select value={selectedRunArtifactId} onChange={(event) => setSelectedRunArtifactId(event.target.value)}>
            <option value="">选择 RunArtifact</option>
            {runArtifacts.map((artifact) => <option key={artifact.runId} value={artifact.runId}>{artifact.status} · {artifact.fileDiff.length} diffs · {artifact.runId.slice(0, 18)}</option>)}
          </select></label>
        </div>
        <div className="harness-action-row">
          <button type="button" onClick={() => void createFixture()} disabled={state !== 'idle' || !selectedSnapshotId}>从 Snapshot 创建 Fixture</button>
          <button type="button" onClick={() => void createFixtureFromArtifact()} disabled={state !== 'idle' || !selectedRunArtifactId}>从 Artifact 创建 Fixture</button>
        </div>
        {selectedRunArtifactId ? <ArtifactDetails artifact={runArtifacts.find((artifact) => artifact.runId === selectedRunArtifactId)} /> : null}
        </details>
      </section> : null}

      {activeHarnessTab === 'eval' ? <section className="harness-section harness-pipeline-node">
        <NodeHeader index="3" title="执行评测" description="选择一个回归案例，确认断言，然后用当前候选 AgentSpec 运行一次评测。" />
        <div className="harness-eval-layout">
          <div className="harness-config-group">
            <div className="harness-config-group__heading"><span>01</span><strong>选择候选与案例</strong><small>候选 AgentSpec 是本次要评测的 agent 配置版本；Fixture 决定输入、快照和预期结果。</small></div>
            <div className="harness-form-grid">
              <label><span>候选 AgentSpec</span><select value={selectedAgentSpecId} onChange={(event) => setSelectedAgentSpecId(event.target.value)}>
                <option value="">选择候选 AgentSpec</option>
                {agentSpecs.filter((spec) => spec.productId === productId && spec.agentId === agentId).map((spec) => <option key={spec.id} value={spec.id}>{formatAgentSpec(spec)}</option>)}
              </select></label>
              <label><span>评测案例</span><select value={selectedFixtureId} onChange={(event) => setSelectedFixtureId(event.target.value)}>
                <option value="">选择 Fixture</option>
                {fixtures.map((fixture) => <option key={fixture.id} value={fixture.id}>{formatFixture(fixture)}</option>)}
              </select></label>
              <label><span>运行模式</span><select value={evalRunMode} onChange={(event) => setEvalRunMode(event.target.value as EvalRun['runMode'])}>
                <option value="repro">固定快照复现</option>
                <option value="live">当前环境验证</option>
              </select></label>
            </div>
            {selectedFixture ? <FixtureDetails fixture={selectedFixture} /> : <p className="muted">先选择一个 Fixture。</p>}
          </div>

          <div className="harness-config-group">
            <div className="harness-config-group__heading"><span>02</span><strong>确认断言</strong><small>断言是这次评测的自动通过条件。</small></div>
            <div className="harness-assertion-builder">
              <strong>添加断言</strong>
              <div className="harness-assertion-builder-grid">
                <label>
                  <span>断言类型</span>
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
                    <input value={assertionPath} onChange={(event) => setAssertionPath(event.target.value)} placeholder="例如 02 故事/**…" />
                  </label>
                ) : null}
                {assertionKind === 'heading' ? (
                  <label>
                    <span>Markdown 标题</span>
                    <input value={assertionHeading} onChange={(event) => setAssertionHeading(event.target.value)} placeholder="例如 主角目标…" />
                  </label>
                ) : null}
                {assertionKind === 'allowed-section' ? (
                  <label>
                    <span>允许修改的 section</span>
                    <input value={assertionSection} onChange={(event) => setAssertionSection(event.target.value)} placeholder="例如 升级链条…" />
                  </label>
                ) : null}
                {assertionKind === 'max-changed' ? (
                  <label>
                    <span>最大变更文件数</span>
                    <input value={assertionMaxChanged} onChange={(event) => setAssertionMaxChanged(event.target.value)} placeholder="例如 1…" />
                  </label>
                ) : null}
                <button type="button" onClick={() => void addFixtureAssertion()} disabled={state !== 'idle' || !selectedFixtureId}>添加断言</button>
              </div>
            </div>
            <div className="harness-assertion-list">
              <div className="harness-assertion-list__header">
                <strong>当前断言</strong>
                <div className="harness-action-row">
                  <button type="button" onClick={() => toggleAllFixtureAssertions(selectedFixtureAssertionRows)} disabled={selectedFixtureAssertionRows.length === 0}>{selectedAssertionIds.length === selectedFixtureAssertionRows.length && selectedFixtureAssertionRows.length > 0 ? '清空选择' : '全选'}</button>
                  <button type="button" onClick={() => void removeSelectedFixtureAssertions()} disabled={state !== 'idle' || selectedAssertionIds.length === 0}>删除选中断言</button>
                </div>
              </div>
              {selectedFixtureAssertionRows.length > 0 ? selectedFixtureAssertionRows.map((assertion) => (
                <label className="harness-assertion-row" key={assertion.id}>
                  <input type="checkbox" checked={selectedAssertionIds.includes(assertion.id)} onChange={() => toggleFixtureAssertion(assertion.id)} />
                  <span>{assertion.kind}</span>
                  <small>{assertion.detail}</small>
                </label>
              )) : <small className="muted">当前 Fixture 还没有断言。自动生成或手动添加后会显示在这里。</small>}
            </div>
            <label className="harness-field harness-field--wide"><span>断言 JSON</span><textarea
              value={fixtureAssertionsText}
              onChange={(event) => {
                fixtureAssertionsDirtyRef.current = true;
                setFixtureAssertionsText(event.target.value);
              }}
              rows={8}
              spellCheck={false}
              placeholder="例如 { &quot;files&quot;: { &quot;mustCreateOrModify&quot;: [&quot;02 故事/**&quot;] } }…"
            /></label>
            <div className="harness-action-row">
              <button type="button" onClick={() => void saveFixtureAssertions()} disabled={state !== 'idle' || !selectedFixtureId}>保存断言</button>
            </div>
          </div>

          <div className="harness-config-group">
            <div className="harness-config-group__heading"><span>03</span><strong>运行候选评测</strong><small>创建 EvalRun 后，在本页下方查看结果和对比。</small></div>
            <div className="harness-eval-ready">
              <small>候选配置：{selectedAgentSpec ? formatAgentSpec(selectedAgentSpec) : '未选择'}</small>
              <small>评测案例：{selectedFixture ? formatFixture(selectedFixture) : '未选择'}</small>
              <small>断言组：{selectedFixture ? Object.keys(selectedFixture.assertions ?? {}).length : 0}</small>
              {createEvalRunBlockedReason ? <small className="warning">{createEvalRunBlockedReason}</small> : null}
            </div>
            <div className="harness-action-row">
              <button type="button" onClick={() => void createEvalRun()} disabled={state !== 'idle' || Boolean(createEvalRunBlockedReason)}>创建 EvalRun</button>
            </div>
            {evalRunFeedback ? <p className="git-result success" aria-live="polite">{evalRunFeedback}</p> : null}
          </div>
        </div>
      </section> : null}

      {activeHarnessTab === 'eval' && selectedEvalRun ? <section className="harness-section">
        <EvalRunDetails run={selectedEvalRun} fixture={fixtures.find((fixture) => fixture.id === selectedEvalRun.fixtureId)} spec={agentSpecs.find((spec) => spec.id === selectedEvalRun.agentSpecId)} />
      </section> : null}

      {activeHarnessTab === 'review' ? <section className="harness-section harness-pipeline-node">
        <NodeHeader index="4" title="人工审阅" description="程序检查只证明没有破坏约束，发布前仍要确认创作质量没有退化。" />
        <h3>HumanReview</h3>
        {selectedRubric ? (
          <div className="harness-review-form">
            <label className="harness-field"><span>评分 Rubric</span><select value={selectedRubric.id} onChange={(event) => setSelectedRubricId(event.target.value)}>
              {rubrics.map((rubric) => <option key={rubric.id} value={rubric.id}>{rubric.productId}/{rubric.artifactType} v{rubric.version} {rubric.status}</option>)}
            </select></label>
            <label className="harness-field"><span>EvalRun</span><select value={selectedEvalRunId} onChange={(event) => setSelectedEvalRunId(event.target.value)}>
              <option value="">选择 EvalRun</option>
          {evalRuns.map((run) => <option key={run.id} value={run.id}>{formatEvalRun(run)}</option>)}
            </select></label>
            <div className="harness-review-summary">
              <small>当前 AgentSpec：{selectedSpecRuns.length} evals · {selectedSpecReviewStats.reviewed} reviewed · avg {selectedSpecReviewStats.averageText}</small>
              <small>决策：{selectedSpecReviewStats.decisionsText}</small>
            </div>
            <label className="harness-field"><span>评分结论</span><select value={reviewDecision} onChange={(event) => setReviewDecision(event.target.value as typeof reviewDecision)}>
              <option value="pass">pass</option>
              <option value="improved">improved</option>
              <option value="fail">fail</option>
              <option value="regressed">regressed</option>
              <option value="needs_regression_case">needs regression case</option>
            </select></label>
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
            <label className="harness-field"><span>评分备注</span><input value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="notes" /></label>
            <button type="button" onClick={() => void saveHumanReview()} disabled={state !== 'idle' || !selectedEvalRunId}>保存评分</button>
            <button type="button" onClick={() => void saveBatchHumanReviewForSelectedSpec()} disabled={state !== 'idle' || !selectedAgentSpecId || selectedSpecRuns.every((run) => run.humanReview)}>批量评分当前 Spec 未评分 EvalRun</button>
            {selectedEvalRun?.humanReview ? <p className="muted">当前评分：{selectedEvalRun.humanReview.decision} · {selectedEvalRun.humanReview.reviewer}</p> : null}
            <ReviewHistory runs={reviewedRuns} rubrics={rubrics} onSelect={setSelectedEvalRunId} />
          </div>
        ) : <p className="muted">还没有 HumanReviewRubric</p>}
      </section> : null}

      {activeHarnessTab === 'release' ? <section className="harness-section harness-pipeline-node">
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
      </section> : null}

      {activeHarnessTab === 'eval' ? <section className="harness-section">
        <h3>最近 EvalRun</h3>
        <ul className="harness-list">
          {evalRuns.slice(-8).reverse().map((run) => (
            <li key={run.id}><button type="button" className="harness-list-row" onClick={() => setSelectedEvalRunId(run.id)}><span>{run.status}</span><strong>{run.executionMode ?? run.runMode}</strong><small>{run.assertionResults.length} checks · {run.errorMessage ?? run.id}</small></button></li>
          ))}
          {evalRuns.length === 0 ? <li><span>empty</span><small>还没有评估运行</small></li> : null}
        </ul>
      </section> : null}

      {activeHarnessTab === 'eval' ? <section className="harness-section">
        <h3>AgentSpec 对比</h3>
        <SpecComparison specs={agentSpecs} runs={evalRuns} onSelect={setSelectedAgentSpecId} />
      </section> : null}

      {activeHarnessTab === 'eval' ? <section className="harness-section">
        <h3>Fixture 横向对比</h3>
        <FixtureRunComparison fixtureId={selectedFixtureId} specs={agentSpecs} runs={evalRuns} onSelectRun={setSelectedEvalRunId} onSelectSpec={setSelectedAgentSpecId} />
      </section> : null}

      {activeHarnessTab === 'release' ? <section className="harness-section">
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
      </section> : null}
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

function WorkflowStep({ index, title, detail, active = false, onClick }: { index: string; title: string; detail: string; active?: boolean; onClick?: () => void }): JSX.Element {
  return (
    <button type="button" className={`harness-workflow-step${active ? ' active' : ''}`} onClick={onClick} role="tab" aria-selected={active}>
      <span>{index}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </button>
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

function AgentSpecPreview({ title, preview, emptyText, mode = 'full' }: { title: string; preview: AgentSpecPreviewModel | PromptBlockPreviewModel | null; emptyText: string; mode?: 'summary' | 'context' | 'full' }): JSX.Element {
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
        {preview.spec.agentId === 'system' && preview.layerConfig?.systemAgent.instructionOverride ? (
          <details className="harness-prompt-preview" open={mode === 'summary' || mode === 'context'}>
            <summary><span>system agent 主体提示词</span><strong>system-agent</strong><small>layer instructionOverride</small></summary>
            <pre>{preview.layerConfig.systemAgent.instructionOverride}</pre>
          </details>
        ) : currentSkill ? (
          <details className="harness-prompt-preview" open={mode === 'summary' || mode === 'context'}>
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
        {mode === 'full' || mode === 'context' ? (
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
            {mode === 'full' ? (
              <div className="harness-prompt-preview-stack">
                {preview.skills.filter((skill) => skill.skillId !== currentSkill?.skillId).map((skill) => (
                  <details key={`${skill.ref}:${skill.source}`} className="harness-prompt-preview" open={false}>
                    <summary><span>{skill.source}</span><strong>{skill.skillId}</strong><small>{skill.ref} · {skill.contentHash ?? 'no hash'}</small></summary>
                    <pre>{skill.content ?? '(skill content unavailable)'}</pre>
                  </details>
                ))}
              </div>
            ) : null}
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

function AgentSpecDiff({ active, candidate }: { active: AgentSpecPreviewModel | null; candidate: AgentSpecPreviewModel | null }): JSX.Element | null {
  if (!active || !candidate) return null;
  const rows = [
    diffRow('Spec', active.spec.id, candidate.spec.id),
    diffRow('名称', active.spec.name ?? '', candidate.spec.name ?? ''),
    diffRow('行为规则', active.promptBlocks.map((block) => block.ref).join(', '), candidate.promptBlocks.map((block) => block.ref).join(', ')),
    diffRow('Layer', active.layerConfig?.id ?? active.spec.layerConfigRef ?? '', candidate.layerConfig?.id ?? candidate.spec.layerConfigRef ?? ''),
    diffRow('Memory', active.memoryPolicy ? `${active.memoryPolicy.id}@${active.memoryPolicy.version}` : active.spec.memoryPolicyRef ?? '', candidate.memoryPolicy ? `${candidate.memoryPolicy.id}@${candidate.memoryPolicy.version}` : candidate.spec.memoryPolicyRef ?? ''),
    diffRow('Retrieval', active.retrievalPolicy ? `${active.retrievalPolicy.id}@${active.retrievalPolicy.version}` : active.spec.retrievalPolicyRef ?? '', candidate.retrievalPolicy ? `${candidate.retrievalPolicy.id}@${candidate.retrievalPolicy.version}` : candidate.spec.retrievalPolicyRef ?? ''),
    diffRow('Tool', active.spec.toolPolicyRef ?? active.layerConfig?.toolPolicyRef ?? '', candidate.spec.toolPolicyRef ?? candidate.layerConfig?.toolPolicyRef ?? ''),
    diffRow('Model', active.spec.modelPolicyRef ?? active.layerConfig?.modelPolicyRef ?? '', candidate.spec.modelPolicyRef ?? candidate.layerConfig?.modelPolicyRef ?? ''),
  ];
  return (
    <div className="harness-agent-diff">
      <strong>Active / Candidate 对比</strong>
      {rows.map((row) => (
        <small key={row.field} className={row.changed ? 'changed' : ''}>{row.changed ? 'changed' : 'same'} · {row.field}</small>
      ))}
    </div>
  );
}

function diffRow(field: string, active: string, candidate: string): { field: string; changed: boolean } {
  return { field, changed: active !== candidate };
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

function replaceVersionedRef(refs: string[], nextRef: string): string[] {
  const next = parseVersionRef(nextRef);
  return uniqueStrings([...refs.filter((ref) => parseVersionRef(ref).id !== next.id), nextRef]);
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

function FixtureDetails({ fixture }: { fixture: HarnessSummary['evalFixtures'][number] }): JSX.Element {
  const assertionKeys = Object.keys(fixture.assertions ?? {});
  const inputMessages = fixture.inputMessages ?? [];
  const memoryFixture = fixture.memoryFixture ?? [];
  const knowledgeFixture = fixture.knowledgeFixture ?? [];
  return (
    <div className="harness-fixture-editor">
      <div className="harness-detail-grid">
        <small>输入消息：{inputMessages.length}</small>
        <small>预期文件：{fixture.expectedChangedFiles?.length ?? 0}</small>
        <small>断言组：{assertionKeys.length > 0 ? assertionKeys.join(', ') : 'none'}</small>
        <small>记忆夹具：{memoryFixture.length}</small>
        <small>知识夹具：{knowledgeFixture.length}</small>
        <small>来源：{fixture.sourceRunId ? `run ${fixture.sourceRunId.slice(0, 12)}` : fixture.sourceSnapshotId ? `snapshot ${fixture.sourceSnapshotId.slice(0, 12)}` : 'manual'}</small>
      </div>
      <div className="harness-fixture-preview">
        <strong>输入</strong>
        {inputMessages.length > 0 ? inputMessages.map((message, index) => <small key={`${message.role}-${index}`}>{message.role} · {message.content.slice(0, 160)}</small>) : <small>没有输入消息</small>}
      </div>
      <div className="harness-fixture-preview">
        <strong>预期文件</strong>
        {(fixture.expectedChangedFiles ?? []).length > 0 ? (fixture.expectedChangedFiles ?? []).slice(0, 5).map((file) => <small key={`${file.change}:${file.path}`}>{file.change} · {file.path}</small>) : <small>没有预期文件变更</small>}
      </div>
    </div>
  );
}

function EvalRunDetails({ run, fixture, spec }: { run: EvalRun; fixture?: HarnessSummary['evalFixtures'][number]; spec?: AgentSpec }): JSX.Element {
  const failedAssertions = run.assertionResults.filter((result) => !result.passed);
  const passedAssertions = run.assertionResults.length - failedAssertions.length;
  const recentEvents = (run.toolEvents ?? []).slice(-8).reverse();
  return (
    <div className="harness-eval-run-detail">
      <div className="harness-eval-run-detail__header">
        <div>
          <h3>EvalRun 详情</h3>
          <small>{run.id}</small>
        </div>
        <span className={`harness-run-status harness-run-status--${run.status}`}>{formatEvalRunStatus(run.status)}</span>
      </div>
      <div className="harness-detail-grid">
        <small>候选：{spec ? formatAgentSpec(spec) : run.agentSpecId}</small>
        <small>案例：{fixture ? formatFixture(fixture) : run.fixtureId}</small>
        <small>模式：{run.executionMode ?? run.runMode}</small>
        <small>模型：{run.modelParams?.model ?? run.model ?? 'runtime default'}</small>
        <small>断言：{passedAssertions}/{run.assertionResults.length}</small>
        <small>文件变更：{run.fileDiff.length}</small>
        <small>事件：{run.toolEvents.length}</small>
        <small>开始：{formatDateTime(run.startedAt)}</small>
        <small>结束：{run.endedAt ? formatDateTime(run.endedAt) : '运行中'}</small>
      </div>
      {run.outputMessage ? <div className="harness-eval-run-message"><strong>运行输出</strong><pre>{run.outputMessage}</pre></div> : null}
      {run.errorMessage ? <div className="harness-eval-run-message error"><strong>执行错误</strong><pre>{run.errorMessage}</pre></div> : null}
      <div className="harness-eval-run-columns">
        <div className="harness-eval-run-card">
          <strong>失败断言</strong>
          {failedAssertions.length > 0 ? failedAssertions.map((result) => <small key={result.id}>{result.id}{result.message ? ` · ${result.message}` : ''}</small>) : <small>没有失败断言</small>}
        </div>
        <div className="harness-eval-run-card">
          <strong>文件变更</strong>
          {run.fileDiff.length > 0 ? run.fileDiff.map((file) => <small key={`${file.change}:${file.path}`}>{file.change} · {file.path}</small>) : <small>没有文件变更</small>}
        </div>
        <div className="harness-eval-run-card">
          <strong>最近事件</strong>
          {recentEvents.length > 0 ? recentEvents.map((event, index) => <small key={`${event.type}:${index}`}>{formatStreamEvent(event)}</small>) : <small>还没有运行事件</small>}
        </div>
      </div>
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
            <li key={run.id}>
              <button type="button" className="harness-list-row" onClick={() => onSelect(run.id)}>
                <span>{review?.decision ?? 'unreviewed'}</span>
                <strong>{formatAverageScore(review?.scores)} avg</strong>
                <small>{rubric ? `${rubric.artifactType} v${rubric.version}` : review?.rubricId ?? 'unknown rubric'} · {review?.annotations?.length ?? 0} notes · {run.id.slice(0, 18)}</small>
              </button>
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
  return `${spec.name ? `${spec.name} · ` : ''}${spec.productId}/${spec.agentId} v${spec.version} ${spec.status}`;
}

function formatSnapshot(snapshot: RunInputSnapshot): string {
  return `${snapshot.projectId.slice(0, 8)} · ${snapshot.fileManifest.length} files · ${snapshot.id.slice(0, 18)}`;
}

function formatFixture(fixture: HarnessSummary['evalFixtures'][number]): string {
  return `${fixture.name ? `${fixture.name} · ` : ''}${fixture.target} · ${fixture.id.slice(0, 18)}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function summarizeMessageEvents(message: ChatMessage): string {
  const runEnd = [...(message.streamEvents ?? [])].reverse().find((event) => event.type === 'run.end');
  if (runEnd?.type === 'run.end') return `运行 ${runEnd.status}`;
  return `${message.streamEvents?.length ?? 0} events`;
}

function findRunIdForMessage(session: ChatSession, messageId: string): string | undefined {
  const messageIndex = session.messages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) return undefined;
  const message = session.messages[messageIndex];
  const directRunId = runIdFromMessage(message);
  if (directRunId) return directRunId;
  for (const laterMessage of session.messages.slice(messageIndex + 1)) {
    const runId = runIdFromMessage(laterMessage);
    if (runId) return runId;
    if (laterMessage.role === 'user') return undefined;
  }
  return undefined;
}

function buildFixtureInputMessages(messages: ChatMessage[], targetMessageId: string, maxMessages = 12): Array<{ role: 'user' | 'assistant'; content: string; createdAt?: string }> {
  const targetIndex = messages.findIndex((message) => message.id === targetMessageId);
  if (targetIndex < 0) return [];
  return messages
    .slice(Math.max(0, targetIndex - maxMessages + 1), targetIndex + 1)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.content || summarizeMessageEvents(message),
      createdAt: message.createdAt,
    }))
    .filter((message) => message.content.trim());
}

function runIdFromMessage(message: ChatMessage): string | undefined {
  const streamEvent = [...(message.streamEvents ?? [])].reverse().find((item) => 'runId' in item && typeof item.runId === 'string');
  if (streamEvent && 'runId' in streamEvent) return streamEvent.runId;
  const legacyEvent = [...(message.events ?? [])].reverse().find((item) => 'runId' in item && typeof item.runId === 'string');
  if (legacyEvent && 'runId' in legacyEvent) return legacyEvent.runId;
  return undefined;
}

function findSnapshotForRunOrSession(snapshots: RunInputSnapshot[], runId: string | undefined, sessionId: string): RunInputSnapshot | undefined {
  const byRun = runId ? snapshots.find((snapshot) => snapshot.runId === runId) : undefined;
  if (byRun) return byRun;
  return snapshots
    .filter((snapshot) => snapshot.sessionId === sessionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
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

function inferPromptBlockGroup(block?: PromptBlock): PromptBlockGroupKey | 'all' {
  if (!block) return 'all';
  if (block.scope === 'system') return 'system';
  if (block.scope === 'tool') return 'tool';
  if (block.scope === 'quality' || block.scope === 'reviewer') return 'quality';
  if (block.scope === 'specialist') return 'agent';
  return 'other';
}

function promptBlockScopeOptions(agentId: string, current: PromptBlock['scope']): PromptBlock['scope'][] {
  const base: PromptBlock['scope'][] = agentId === 'system'
    ? ['system', 'tool', 'other']
    : agentId === 'reviewer-agent'
      ? ['reviewer', 'quality', 'tool', 'other']
      : ['specialist', 'quality', 'tool', 'other'];
  return base.includes(current) ? base : [current, ...base];
}

function isPromptBlockRelevantToAgent(block: PromptBlock, agentId: string, selectedRef = ''): boolean {
  if (selectedRef && parseVersionRef(selectedRef).id === block.id) return true;
  if (block.scope === 'system' || block.scope === 'tool') return true;
  const id = block.id.toLowerCase();
  if (id.includes('_system_') || id.includes('system')) return agentId === 'system';
  if (id.includes(agentId.toLowerCase())) return true;
  if (!id.includes('-agent')) return true;
  return false;
}

function buildPromptBlockGroups(blocks: PromptBlock[]): Array<{ group: PromptBlockGroupKey; blocks: PromptBlock[] }> {
  const latestBlocks = uniquePromptBlockIds(blocks)
    .map((id) => latestPromptBlock(blocks, id))
    .filter((block): block is PromptBlock => Boolean(block))
    .sort((left, right) => left.title.localeCompare(right.title));
  const groups: Array<{ group: PromptBlockGroupKey; blocks: PromptBlock[] }> = ['system', 'agent', 'quality', 'tool', 'other'].map((group) => ({
    group: group as PromptBlockGroupKey,
    blocks: latestBlocks.filter((block) => inferPromptBlockGroup(block) === group),
  }));
  return groups.filter((group) => group.blocks.length > 0);
}

function formatPromptBlockGroupName(group: string): string {
  if (group === 'system') return 'System 工作流';
  if (group === 'agent') return 'Specialist 职责边界';
  if (group === 'quality') return '质量门槛与审稿';
  if (group === 'tool') return '工具与落盘策略';
  return '其他规则';
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

function formatEvalRunStatus(status: EvalRun['status']): string {
  if (status === 'passed') return '通过';
  if (status === 'failed') return '断言失败';
  if (status === 'error') return '执行错误';
  if (status === 'running') return '运行中';
  return '等待中';
}

function formatStreamEvent(event: EvalRun['toolEvents'][number]): string {
  if (event.type === 'tool_use.start') return `工具开始 · ${event.toolName ?? event.toolCallId}`;
  if (event.type === 'tool_use.end') return `工具结束 · ${event.toolCallId} · ${event.status}`;
  if (event.type === 'text.delta') return `文本 · ${event.delta.slice(0, 96)}`;
  if (event.type === 'agent.step.start') return `Agent 开始 · ${event.agentId} · ${event.phase}`;
  if (event.type === 'agent.step.end') return `Agent 结束 · ${event.agentId} · ${event.status}`;
  if (event.type === 'run.end') return `运行结束 · ${event.status}${event.errorMessage ? ` · ${event.errorMessage}` : ''}`;
  return event.type;
}

function readHarnessViewState(): HarnessViewState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(HARNESS_VIEW_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HarnessViewState;
    return isHarnessTab(parsed.activeHarnessTab) || parsed.productId || parsed.agentId ? parsed : {};
  } catch {
    return {};
  }
}

function writeHarnessViewState(state: HarnessViewState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HARNESS_VIEW_STATE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can be disabled in private or restricted browser contexts.
  }
}

function isHarnessTab(value: unknown): value is HarnessTab {
  return value === 'config' || value === 'fixtures' || value === 'eval' || value === 'review' || value === 'release';
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

type AssertionRow = { id: string; kind: string; detail: string };

function buildAssertionRows(assertions: Record<string, unknown>): AssertionRow[] {
  const rows: AssertionRow[] = [];
  const files = isPlainRecord(assertions.files) ? assertions.files : {};
  for (const path of stringArray(files.mustCreateOrModify)) rows.push({ id: assertionId('files', 'mustCreateOrModify', path), kind: '要求创建/修改文件', detail: path });
  for (const path of stringArray(files.mustModify)) rows.push({ id: assertionId('files', 'mustModify', path), kind: '要求修改文件', detail: path });
  for (const path of stringArray(files.mustCreate)) rows.push({ id: assertionId('files', 'mustCreate', path), kind: '要求创建文件', detail: path });
  for (const path of stringArray(files.mustNotWrite)) rows.push({ id: assertionId('files', 'mustNotWrite', path), kind: '禁止写入路径', detail: path });

  const markdown = Array.isArray(assertions.markdown) ? assertions.markdown.filter(isPlainRecord) : [];
  for (const item of markdown) {
    const path = typeof item.path === 'string' ? item.path : '';
    for (const heading of stringArray(item.requiredHeadings)) rows.push({ id: assertionId('markdown', 'requiredHeadings', path, heading), kind: '要求 Markdown 标题', detail: `${path} · ${heading}` });
  }

  const toolEvents = isPlainRecord(assertions.toolEvents) ? assertions.toolEvents : {};
  for (const tool of stringArray(toolEvents.mustCall)) rows.push({ id: assertionId('toolEvents', 'mustCall', tool), kind: '要求工具调用', detail: tool });
  const mustCallInOrder = stringArray(toolEvents.mustCallInOrder);
  if (mustCallInOrder.length > 0) rows.push({ id: assertionId('toolEvents', 'mustCallInOrder'), kind: '要求工具顺序', detail: mustCallInOrder.join(' -> ') });

  const diff = isPlainRecord(assertions.diff) ? assertions.diff : {};
  const allowedPaths = stringArray(diff.allowedPaths);
  if (allowedPaths.length > 0) rows.push({ id: assertionId('diff', 'allowedPaths'), kind: '限制允许变更路径', detail: allowedPaths.join(' / ') });
  if (diff.allowDeletes === false) rows.push({ id: assertionId('diff', 'allowDeletes'), kind: '禁止删除文件', detail: '不允许出现 deleted diff' });
  const allowedChanges = isPlainRecord(diff.allowedChanges) ? diff.allowedChanges : {};
  for (const [changeType, paths] of Object.entries(allowedChanges)) {
    const allowedForType = stringArray(paths);
    if (allowedForType.length > 0) rows.push({ id: assertionId('diff', 'allowedChanges', changeType), kind: `限制 ${changeType} 路径`, detail: allowedForType.join(' / ') });
  }
  if (typeof diff.maxChangedFiles === 'number') rows.push({ id: assertionId('diff', 'maxChangedFiles'), kind: '限制变更文件数', detail: String(diff.maxChangedFiles) });
  if (typeof diff.maxCreatedFiles === 'number') rows.push({ id: assertionId('diff', 'maxCreatedFiles'), kind: '限制创建文件数', detail: String(diff.maxCreatedFiles) });
  if (typeof diff.maxModifiedFiles === 'number') rows.push({ id: assertionId('diff', 'maxModifiedFiles'), kind: '限制修改文件数', detail: String(diff.maxModifiedFiles) });
  if (typeof diff.maxDeletedFiles === 'number') rows.push({ id: assertionId('diff', 'maxDeletedFiles'), kind: '限制删除文件数', detail: String(diff.maxDeletedFiles) });
  const allowedSections = Array.isArray(diff.allowedMarkdownSections) ? diff.allowedMarkdownSections.filter(isPlainRecord) : [];
  for (const item of allowedSections) {
    const path = typeof item.path === 'string' ? item.path : '';
    for (const section of stringArray(item.sections)) rows.push({ id: assertionId('diff', 'allowedMarkdownSections', path, section), kind: '限制可修改 section', detail: `${path} · ${section}` });
  }

  const manifest = Array.isArray(assertions.manifest) ? assertions.manifest.filter(isPlainRecord) : [];
  for (const item of manifest) {
    const artifactType = typeof item.artifactType === 'string' ? item.artifactType : 'manifest';
    const path = typeof item.path === 'string' ? item.path : '';
    rows.push({ id: assertionId('manifest', artifactType, path), kind: '要求符合 Manifest', detail: `${artifactType} · ${path}` });
  }
  return rows;
}

function removeAssertionById(assertions: Record<string, unknown>, assertionId: string): Record<string, unknown> {
  const next = structuredClone(assertions);
  const [group, key, value, extra] = parseAssertionId(assertionId);
  if (group === 'files') removeFromFilesAssertion(next, key, value);
  if (group === 'markdown') removeFromMarkdownAssertions(next, value, extra);
  if (group === 'toolEvents') removeFromToolEventAssertions(next, key, value);
  if (group === 'diff') removeFromDiffAssertions(next, key, value, extra);
  if (group === 'manifest') removeFromManifestAssertions(next, key, value);
  return pruneEmptyAssertions(next);
}

function assertionId(...parts: string[]): string {
  return JSON.stringify(parts);
}

function parseAssertionId(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((part): part is string => typeof part === 'string') : [];
  } catch {
    return [];
  }
}

function removeFromFilesAssertion(assertions: Record<string, unknown>, key: string | undefined, value: string | undefined): void {
  const files = isPlainRecord(assertions.files) ? assertions.files : undefined;
  if (!files || !key || !value) return;
  files[key] = stringArray(files[key]).filter((item) => item !== value);
}

function removeFromMarkdownAssertions(assertions: Record<string, unknown>, path: string | undefined, heading: string | undefined): void {
  if (!path || !heading || !Array.isArray(assertions.markdown)) return;
  assertions.markdown = assertions.markdown.filter(isPlainRecord).map((item) => {
    if (item.path !== path) return item;
    return { ...item, requiredHeadings: stringArray(item.requiredHeadings).filter((value) => value !== heading) };
  }).filter((item) => stringArray(item.requiredHeadings).length > 0);
}

function removeFromToolEventAssertions(assertions: Record<string, unknown>, key: string | undefined, value: string | undefined): void {
  const toolEvents = isPlainRecord(assertions.toolEvents) ? assertions.toolEvents : undefined;
  if (!toolEvents || !key) return;
  if (key === 'mustCallInOrder') {
    delete toolEvents.mustCallInOrder;
    return;
  }
  if (value) toolEvents[key] = stringArray(toolEvents[key]).filter((item) => item !== value);
}

function removeFromDiffAssertions(assertions: Record<string, unknown>, key: string | undefined, path: string | undefined, section: string | undefined): void {
  const diff = isPlainRecord(assertions.diff) ? assertions.diff : undefined;
  if (!diff || !key) return;
  if (key === 'allowedPaths' || key === 'allowDeletes' || key === 'maxChangedFiles' || key === 'maxCreatedFiles' || key === 'maxModifiedFiles' || key === 'maxDeletedFiles') {
    delete diff[key];
    return;
  }
  if (key === 'allowedChanges' && path && isPlainRecord(diff.allowedChanges)) {
    delete diff.allowedChanges[path];
    return;
  }
  if (key === 'allowedMarkdownSections' && path && section && Array.isArray(diff.allowedMarkdownSections)) {
    diff.allowedMarkdownSections = diff.allowedMarkdownSections.filter(isPlainRecord).map((item) => {
      if (item.path !== path) return item;
      return { ...item, sections: stringArray(item.sections).filter((value) => value !== section) };
    }).filter((item) => stringArray(item.sections).length > 0);
  }
}

function removeFromManifestAssertions(assertions: Record<string, unknown>, artifactType: string | undefined, path: string | undefined): void {
  if (!artifactType || !path || !Array.isArray(assertions.manifest)) return;
  assertions.manifest = assertions.manifest.filter((item) => !isPlainRecord(item) || item.artifactType !== artifactType || item.path !== path);
}

function pruneEmptyAssertions(assertions: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(assertions).flatMap(([key, value]) => {
    if (Array.isArray(value)) return value.length > 0 ? [[key, value]] : [];
    if (isPlainRecord(value)) {
      const cleaned = pruneEmptyAssertions(value);
      return Object.keys(cleaned).length > 0 ? [[key, cleaned]] : [];
    }
    return value === undefined ? [] : [[key, value]];
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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
      session: ['viforge', productId, 'sessions', '{sessionId}', 'memories'],
      workspace: ['viforge', productId, 'workspaces', '{projectId}', 'memories'],
      global: ['viforge', productId, 'users', '{userId}', 'global', 'memories'],
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
