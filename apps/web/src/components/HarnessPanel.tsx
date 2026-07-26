import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { DEFAULT_TOOL_DESCRIPTION_SPECS, PRODUCT_PROFILES } from '@viforge/shared';
import type { AgentLayerConfig, AgentSpec, AgentSpecReleaseGate, AssertionConfig, BehaviorRuleConfig, ChatMessage, ChatSession, EvalRun, EvalRunConfig, HarnessSummary, HarnessVersionDiff, HumanReviewRubric, MemoryPolicy, Project, PromptBlock, RetrievalPolicy, RunInputSnapshot, RuntimeConfigFlow, ToolDescriptionConfig, WorkspaceManifest } from '@viforge/shared';

import type { ApiClient } from '../api';
import type { CreateEvalRunConfigInput } from '../api';

type HarnessPanelProps = {
  apiClient: ApiClient;
  standalone?: boolean;
};

type FixtureAssertionKind = 'changed-file' | 'heading' | 'forbidden-write' | 'max-changed' | 'allowed-section';
type PromptBlockGroupKey = 'system' | 'agent' | 'quality' | 'tool' | 'other';
type HarnessTab = 'config' | 'fixtures' | 'eval' | 'review';
type ReviewScoreItemDraft = { id: string; label: string; weight: number; description?: string; notePrompt?: string; required?: boolean };

type FlowStatusFilter = HarnessSummary['runtimeConfigFlows'][number]['status'] | 'all';
type FlowReleaseFilter = HarnessSummary['runtimeConfigFlows'][number]['releaseState'] | 'all';
type FlowSort = 'updatedAt' | 'createdAt' | 'gateStatus' | 'evalCompletion';

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

const DEFAULT_TOOL_DESCRIPTION_TARGETS = Object.keys(DEFAULT_TOOL_DESCRIPTION_SPECS);

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
  const [reviewScoreStates, setReviewScoreStates] = useState<Record<string, 'scored' | 'not_applicable'>>({});
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewSubScores, setReviewSubScores] = useState<Record<string, Record<string, number>>>({});
  const [reviewAnnotationPath, setReviewAnnotationPath] = useState('');
  const [reviewAnnotationLine, setReviewAnnotationLine] = useState('');
  const [reviewAnnotationSeverity, setReviewAnnotationSeverity] = useState<'note' | 'issue' | 'blocker'>('issue');
  const [reviewAnnotationComment, setReviewAnnotationComment] = useState('');
  const [reviewAnnotations, setReviewAnnotations] = useState<NonNullable<EvalRun['humanReview']>['annotations']>([]);
  const [reviewScoreSkipped, setReviewScoreSkipped] = useState(false);
  const [releaseGate, setReleaseGate] = useState<AgentSpecReleaseGate | null>(null);
  const [fixtureAssertionsText, setFixtureAssertionsText] = useState('');
  const [selectedAssertionIds, setSelectedAssertionIds] = useState<string[]>([]);
  const [fixtureName, setFixtureName] = useState('');
  const [fixtureTemplateId, setFixtureTemplateId] = useState('');
  const [fixtureSourceProjectId, setFixtureSourceProjectId] = useState('');
  const [fixtureSourceSessionId, setFixtureSourceSessionId] = useState('');
  const [fixtureMessageId, setFixtureMessageId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [fixtureSessions, setFixtureSessions] = useState<ChatSession[]>([]);
  const [fixtureCreateFeedback, setFixtureCreateFeedback] = useState('');
  const [createdFixtureMessageKeys, setCreatedFixtureMessageKeys] = useState<string[]>([]);
  const [evalRunFeedback, setEvalRunFeedback] = useState('');
  const [selectedRubricId, setSelectedRubricId] = useState('');
  const [reviewTemplateName, setReviewTemplateName] = useState('');
  const [reviewTemplateScoreItems, setReviewTemplateScoreItems] = useState<ReviewScoreItemDraft[]>([{ id: 'quality', label: '整体质量', weight: 1, required: true }]);
  const [selectedAssertionConfigId, setSelectedAssertionConfigId] = useState('');
  const [assertionConfigTemplateId, setAssertionConfigTemplateId] = useState('');
  const [assertionConfigName, setAssertionConfigName] = useState('');
  const [selectedEvalRunConfigId, setSelectedEvalRunConfigId] = useState('');
  const [evalRunConfigTemplateId, setEvalRunConfigTemplateId] = useState('');
  const [evalRunConfigName, setEvalRunConfigName] = useState('');
  const [evalRunMode, setEvalRunMode] = useState<EvalRun['runMode']>(initialViewState.evalRunMode ?? 'repro');
  const [evalMemoryMode, setEvalMemoryMode] = useState<EvalRunConfig['memoryMode']>('fixture');
  const [evalKnowledgeMode, setEvalKnowledgeMode] = useState<EvalRunConfig['knowledgeMode']>('fixture');
  const [assertionResultViewed, setAssertionResultViewed] = useState(false);
  const [flowQuery, setFlowQuery] = useState('');
  const [flowStatusFilter, setFlowStatusFilter] = useState<FlowStatusFilter>('all');
  const [flowReleaseFilter, setFlowReleaseFilter] = useState<FlowReleaseFilter>('all');
  const [flowTagFilter, setFlowTagFilter] = useState('all');
  const [flowSort, setFlowSort] = useState<FlowSort>('updatedAt');
  const [selectedFlowId, setSelectedFlowId] = useState('');
  const [newFlowName, setNewFlowName] = useState('');
  const [flowRenameText, setFlowRenameText] = useState('');
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
  const [agentConfigTemplateId, setAgentConfigTemplateId] = useState('');
  const [toolDescriptionToolId, setToolDescriptionToolId] = useState('write_workspace_file');
  const [toolDescriptionScope, setToolDescriptionScope] = useState<NonNullable<ToolDescriptionConfig['scope']>>('product');
  const [toolDescriptionContent, setToolDescriptionContent] = useState('');
  const [toolParameterDescriptions, setToolParameterDescriptions] = useState<Record<string, string>>({});
  const [toolOutputDescription, setToolOutputDescription] = useState('');
  const [behaviorRuleScope, setBehaviorRuleScope] = useState<'system' | 'product' | 'agent'>('product');
  const [agentConfigEditType, setAgentConfigEditType] = useState<'agent_prompt' | 'behavior_rule' | 'tool_description'>('agent_prompt');
  const [selectedMemoryPolicyRef, setSelectedMemoryPolicyRef] = useState('');
  const [selectedRetrievalPolicyRef, setSelectedRetrievalPolicyRef] = useState('');
  const [selectedToolPolicyRef, setSelectedToolPolicyRef] = useState('');
  const [selectedModelPolicyRef, setSelectedModelPolicyRef] = useState('');
  const [activeHarnessTab, setActiveHarnessTab] = useState<HarnessTab>(initialViewState.activeHarnessTab ?? 'fixtures');
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
      setSelectedAssertionConfigId((current) => current || next.assertionConfigs.find((config) => config.productId === productId)?.id || '');
      setSelectedEvalRunConfigId((current) => current || next.evalRunConfigs.find((config) => config.productId === productId)?.id || '');
      setSelectedFlowId((current) => current || next.runtimeConfigFlows.find(isUserRuntimeConfigFlow)?.id || '');
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

  useEffect(() => {
    if (evalRunMode === 'repro') {
      setEvalMemoryMode((current) => current === 'live' ? 'fixture' : current);
      setEvalKnowledgeMode((current) => current === 'live' ? 'fixture' : current);
      return;
    }
    setEvalMemoryMode('live');
    setEvalKnowledgeMode('live');
  }, [evalRunMode]);

  useEffect(() => {
    const config = summary?.evalRunConfigs.find((item) => item.id === selectedEvalRunConfigId);
    if (!config) return;
    setEvalRunMode(config.runMode);
    setEvalMemoryMode(config.memoryMode);
    setEvalKnowledgeMode(config.knowledgeMode);
  }, [selectedEvalRunConfigId, summary]);

  useEffect(() => {
    const flow = summary?.runtimeConfigFlows.find((item) => item.id === selectedFlowId);
    if (!flow) return;
    setFlowRenameText(flow.name);
  }, [selectedFlowId, summary]);

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
    if (agentConfigTemplateId) return;
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
  }, [agentConfigTemplateId, agentId, productId, selectedAgentSpecId, summary]);

  useEffect(() => {
    if (fixtureTemplateId || assertionConfigTemplateId) return;
    const assertionConfig = selectedAssertionConfigId ? latestVersionedRecord(summary?.assertionConfigs ?? [], selectedAssertionConfigId) : undefined;
    const fixture = summary?.evalFixtures.find((item) => item.id === selectedFixtureId);
    const nextText = assertionConfig
      ? JSON.stringify(assertionConfig.compiledAssertions, null, 2)
      : fixture && Object.keys(fixture.assertions ?? {}).length > 0
        ? JSON.stringify(fixture.assertions, null, 2)
        : '';
    const editorKey = assertionConfig ? `assertion:${assertionConfig.id}@${assertionConfig.version}` : `fixture:${selectedFixtureId}`;
    if (loadedFixtureAssertionsRef.current !== editorKey) {
      loadedFixtureAssertionsRef.current = editorKey;
      fixtureAssertionsDirtyRef.current = false;
      setFixtureAssertionsText(nextText);
      setSelectedAssertionIds([]);
      return;
    }
    if (!fixtureAssertionsDirtyRef.current && nextText !== fixtureAssertionsText) {
      setFixtureAssertionsText(nextText);
    }
  }, [assertionConfigTemplateId, fixtureTemplateId, selectedAssertionConfigId, selectedFixtureId, summary]);

  useEffect(() => {
    const run = summary?.evalRuns.find((item) => item.id === selectedEvalRunId);
    setReviewAnnotations(run?.humanReview?.annotations ?? []);
    setReviewScores(run?.humanReview?.scores ?? {});
    setReviewScoreStates(run?.humanReview?.scoreStates ?? {});
    setReviewSubScores(run?.humanReview?.subScores ?? {});
    setReviewNotes(run?.humanReview?.notes ?? '');
    if (run?.humanReview?.rubricId) setSelectedRubricId(run.humanReview.rubricId);
    setAssertionResultViewed(false);
  }, [selectedEvalRunId, summary]);

  useEffect(() => {
    const rubric = summary?.humanReviewRubrics.find((item) => item.id === selectedRubricId);
    if (!rubric) return;
    setReviewTemplateScoreItems(reviewTemplateScoreItemsFromRubric(rubric));
  }, [selectedRubricId, summary]);

  useEffect(() => {
    setReviewScoreSkipped(false);
  }, [selectedEvalRunId]);

  useEffect(() => {
    const blocks = [
      ...(summary?.promptBlocks ?? []),
      ...(summary?.behaviorRuleConfigs ?? []).map(promptBlockFromBehaviorRule),
    ];
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
    const currentSpec = summary?.agentSpecs.find((spec) => spec.id === (selectedAgentSpecId || agentConfigTemplateId))
      ?? summary?.agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
    const layerConfig = currentSpec?.layerConfigRef
      ? summary?.agentLayerConfigs.find((config) => config.id === currentSpec.layerConfigRef || `${config.id}@${config.version}` === currentSpec.layerConfigRef)
      : summary?.agentLayerConfigs.find((config) => config.productId === productId && config.status === 'active');
    if (!layerConfig) {
      setAgentInstructionContent('');
      return;
    }
    const instruction = agentId === 'system'
      ? layerConfig.systemAgent.instructionOverride
      : layerConfig.specialists.find((specialist) => specialist.agentId === agentId)?.instructionOverride;
    setAgentInstructionContent(instruction ?? '');
  }, [agentConfigTemplateId, agentId, productId, selectedAgentSpecId, summary]);

  useEffect(() => {
    const currentSpec = summary?.agentSpecs.find((spec) => spec.id === (selectedAgentSpecId || agentConfigTemplateId))
      ?? summary?.agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
    const layerConfig = currentSpec?.layerConfigRef
      ? summary?.agentLayerConfigs.find((config) => config.id === currentSpec.layerConfigRef || `${config.id}@${config.version}` === currentSpec.layerConfigRef)
      : summary?.agentLayerConfigs.find((config) => config.productId === productId && config.status === 'active');
    const overrides = getLayerToolDescriptionOverrides(layerConfig);
    const baseline = resolveToolDescriptionBaseline(toolDescriptionToolId, overrides);
    setToolDescriptionContent(baseline.description);
    setToolParameterDescriptions(baseline.parameterDescriptions ?? {});
    setToolOutputDescription(baseline.outputDescription ?? '');
  }, [agentConfigTemplateId, agentId, productId, selectedAgentSpecId, summary, toolDescriptionToolId]);

  function resolveDraftBaseAgentSpec(): AgentSpec | undefined {
    return (agentConfigTemplateId ? summary?.agentSpecs.find((spec) => spec.id === agentConfigTemplateId) : undefined)
      ?? summary?.agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active')
      ?? summary?.agentSpecs
        .filter((spec) => spec.productId === productId && spec.agentId === agentId)
        .sort((left, right) => right.version - left.version)[0];
  }

  function resolveLayerConfigForSpec(spec: AgentSpec | undefined): AgentLayerConfig | undefined {
    if (spec?.layerConfigRef) {
      return summary?.agentLayerConfigs.find((config) => config.id === spec.layerConfigRef || `${config.id}@${config.version}` === spec.layerConfigRef);
    }
    return summary?.agentLayerConfigs.find((config) => config.productId === productId && config.status === 'active');
  }

  async function createAgentSpec(): Promise<void> {
    if (actionLockRef.current) return;
    if (!agentSpecName.trim()) {
      setError('Agent 配置名称是必填项。');
      return;
    }
    if (!canCreateAgentSpec) {
      setError('没有检测到配置变化：请先选择一条不同的行为规则');
      return;
    }
    actionLockRef.current = true;
    setState('saving');
    setError(null);
    try {
      const baseSpec = resolveDraftBaseAgentSpec();
      const baseLayer = resolveLayerConfigForSpec(baseSpec);
      const nextPromptBlockRefs = selectedPromptBlockRef
        ? replaceVersionedRef(baseLayer?.promptBlockRefs ?? [], selectedPromptBlockRef)
        : (baseSpec?.promptBlockRefs ?? []);
      const memoryPolicyRef = selectedMemoryPolicyRef.trim() || baseSpec?.memoryPolicyRef;
      const retrievalPolicyRef = selectedRetrievalPolicyRef.trim() || baseSpec?.retrievalPolicyRef;
      const toolPolicyRef = selectedToolPolicyRef.trim() || baseSpec?.toolPolicyRef;
      const modelPolicyRef = selectedModelPolicyRef.trim() || baseSpec?.modelPolicyRef;
      const nextLayerConfig = selectedPromptBlockRef && baseLayer
        ? await apiClient.createAgentLayerConfig({
          ...stripLayerIdentity(baseLayer),
          status: 'candidate',
          promptBlockRefs: nextPromptBlockRefs,
          memoryPolicyRef,
          retrievalPolicyRef,
          toolPolicyRef,
          modelPolicyRef,
        })
        : undefined;
      const created = await apiClient.createAgentSpec({
        productId,
        name: agentSpecName.trim() || undefined,
        agentId,
        status: 'candidate',
        layerConfigRef: nextLayerConfig?.id ?? baseSpec?.layerConfigRef,
        promptBlockRefs: selectedPromptBlockRef ? (baseSpec?.promptBlockRefs ?? []) : nextPromptBlockRefs,
        skillRefs: baseSpec?.skillRefs ?? [],
        memoryPolicyRef,
        retrievalPolicyRef,
        toolPolicyRef,
        modelPolicyRef,
        changelog: baseSpec ? `Created from ${baseSpec.id} with selected behavior rule changes.` : 'Created from Agent Harness workflow.',
      });
      setSelectedAgentSpecId(created.id);
      await patchSelectedRuntimeConfigFlow({
        status: 'candidate',
        candidateSpecId: created.id,
        nodeRefs: { agentConfig: { source: 'derived', id: created.id, version: created.version, name: created.name ?? created.agentId } },
        changes: [
          ...(selectedPromptBlockRef ? [{ scope: 'product' as const, area: 'behavior_rule' as const, agentId, targetId: parseVersionRef(selectedPromptBlockRef).id, summary: `绑定行为规则 ${selectedPromptBlockRef}` }] : []),
          ...(policyChanged ? [{ scope: 'product' as const, area: 'policy' as const, agentId, summary: '调整运行策略引用' }] : []),
        ],
      });
      setAgentSpecName('');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建候选运行配置失败');
    } finally {
      actionLockRef.current = false;
      setState('idle');
    }
  }

  async function createRuntimeConfigFlowDraft(): Promise<void> {
    if (actionLockRef.current) return;
    const trimmedName = newFlowName.trim();
    if (!trimmedName) {
      setError('请先填写配置流程名称。');
      return;
    }
    actionLockRef.current = true;
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.createRuntimeConfigFlow({
        productId,
        agentId,
        name: trimmedName,
        status: 'draft',
        tags: [productId, agentId, 'flow'].filter(Boolean),
        nodeRefs: {
          agentConfig: activeAgentSpec ? { source: 'reused', id: activeAgentSpec.id, version: activeAgentSpec.version, name: activeAgentSpec.name ?? activeAgentSpec.agentId } : undefined,
        },
        changes: [],
      });
      setSelectedFlowId(created.id);
      setFlowRenameText(created.name);
      setNewFlowName('');
      setActiveHarnessTab('fixtures');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建运行配置流程失败');
    } finally {
      actionLockRef.current = false;
      setState('idle');
    }
  }

  async function cloneRuntimeConfigFlow(flow: RuntimeConfigFlow): Promise<void> {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.cloneRuntimeConfigFlow(flow.id);
      setSelectedFlowId(created.id);
      setProductId(created.productId);
      if (created.agentId) setAgentId(created.agentId);
      setSelectedFixtureId(created.nodeRefs.evalFixture?.id ?? '');
      setSelectedAgentSpecId(created.candidateSpecId ?? created.nodeRefs.agentConfig?.id ?? '');
      setSelectedEvalRunConfigId(created.nodeRefs.evalRunConfig?.id ?? '');
      setSelectedAssertionConfigId(created.nodeRefs.assertionConfig?.id ?? '');
      setSelectedRubricId(created.nodeRefs.reviewTemplate?.id ?? '');
      setFlowRenameText(created.name);
      setActiveHarnessTab('fixtures');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '克隆运行配置流程失败');
    } finally {
      actionLockRef.current = false;
      setState('idle');
    }
  }

  async function patchSelectedRuntimeConfigFlow(input: Parameters<ApiClient['updateRuntimeConfigFlow']>[1]): Promise<void> {
    if (!selectedFlowId.startsWith('runtime_config_flow_')) return;
    const currentFlow = summary?.runtimeConfigFlows.find((flow) => flow.id === selectedFlowId);
    const nextInput = input.changes && currentFlow
      ? { ...input, changes: mergeRuntimeConfigChanges(currentFlow.changes, input.changes) }
      : input;
    await apiClient.updateRuntimeConfigFlow(selectedFlowId, nextInput);
  }

  async function renameSelectedRuntimeConfigFlow(): Promise<void> {
    const flow = summary?.runtimeConfigFlows.find((item) => item.id === selectedFlowId);
    const trimmedName = flowRenameText.trim();
    if (!flow) return;
    if (!flow.id.startsWith('runtime_config_flow_')) {
      setError('请选择一个手动创建的配置流程后再重命名。');
      return;
    }
    if (!trimmedName) {
      setError('配置流程名称不能为空。');
      return;
    }
    if (trimmedName === flow.name) return;
    setState('saving');
    setError(null);
    try {
      const renamed = await apiClient.updateRuntimeConfigFlow(flow.id, { name: trimmedName });
      setFlowRenameText(renamed.name);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名配置流程失败');
    } finally {
      setState('idle');
    }
  }

  async function archiveRuntimeConfigFlow(flow: RuntimeConfigFlow): Promise<void> {
    if (!flow.id.startsWith('runtime_config_flow_')) {
      setError('请选择一个手动创建的配置流程后再归档。');
      return;
    }
    const confirmed = window.confirm('归档会保留评测、审阅和发布记录，但不再作为默认流程展示。确认归档？');
    if (!confirmed) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.updateRuntimeConfigFlow(flow.id, { status: 'archived' });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '归档运行配置流程失败');
    } finally {
      setState('idle');
    }
  }

  async function deleteRuntimeConfigFlowDraft(flow: RuntimeConfigFlow): Promise<void> {
    if (!flow.id.startsWith('runtime_config_flow_')) {
      setError('请选择一个手动创建的草稿流程后再删除。');
      return;
    }
    const confirmed = window.confirm('只有未绑定候选、评测和发布记录的草稿可以硬删除。确认删除？');
    if (!confirmed) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.deleteRuntimeConfigFlow(flow.id);
      if (selectedFlowId === flow.id) setSelectedFlowId('');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除运行配置流程失败');
    } finally {
      setState('idle');
    }
  }

  function loadRuntimeConfigChangeIntoEditor(change: RuntimeConfigFlow['changes'][number]): void {
    if (change.agentId) setAgentId(change.agentId);
    if (change.area === 'agent_prompt') {
      const spec = selectedFlow?.candidateSpecId ? summary?.agentSpecs.find((item) => item.id === selectedFlow.candidateSpecId) : undefined;
      if (spec?.id) setSelectedAgentSpecId(spec.id);
      return;
    }
    if (change.area === 'behavior_rule') {
      setBehaviorRuleScope(change.scope);
      const targetId = normalizeVersionedChangeTarget(change.targetId);
      if (targetId) {
        const block = latestPromptBlock([...(summary?.promptBlocks ?? []), ...(summary?.behaviorRuleConfigs ?? []).map(promptBlockFromBehaviorRule)], targetId);
        if (block) {
          setSelectedPromptBlockId(block.id);
          setSelectedPromptBlockRef(`${block.id}@${block.version}`);
          setPromptBlockVersion(String(block.version));
          setPromptBlockTitle(block.title);
          setPromptBlockContent(block.content);
          setPromptBlockScope(block.scope);
        }
      }
      return;
    }
    if (change.area === 'tool_description') {
      setToolDescriptionScope(change.scope);
      if (change.targetId) setToolDescriptionToolId(change.targetId);
    }
  }

  async function createDefaults(): Promise<void> {
    setState('saving');
    setError(null);
    try {
      const memoryPolicy = await apiClient.createMemoryPolicy(defaultMemoryPolicy(productId));
      const retrievalPolicy = await apiClient.createRetrievalPolicy(defaultRetrievalPolicy(productId));
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
        status: 'candidate',
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
    if (!agentSpecName.trim()) {
      setError('Agent 配置名称是必填项。');
      return;
    }
    if (!newPromptBlockTitle.trim() || !newPromptBlockContent.trim()) {
      setError('行为规则标题和内容都需要填写');
      return;
    }
    actionLockRef.current = true;
    setState('saving');
    setError(null);
    try {
      const ruleConfig = await apiClient.createBehaviorRuleConfig({
        productId,
        status: 'candidate',
        title: newPromptBlockTitle.trim(),
        scope: behaviorRuleScope,
        agentId: behaviorRuleScope === 'agent' ? agentId : undefined,
        content: newPromptBlockContent.trim(),
        tags: ['harness'],
      });
      setSelectedPromptBlockId(ruleConfig.id);
      setSelectedPromptBlockRef(`${ruleConfig.id}@${ruleConfig.version}`);
      const baseSpec = resolveDraftBaseAgentSpec();
      const baseLayer = resolveLayerConfigForSpec(baseSpec);
      const nextLayer = baseLayer
        ? await apiClient.createAgentLayerConfig({
          ...stripLayerIdentity(baseLayer),
          status: 'candidate',
          behaviorRuleRefs: replaceVersionedRef(baseLayer.behaviorRuleRefs ?? [], `${ruleConfig.id}@${ruleConfig.version}`),
        })
        : undefined;
      const spec = await apiClient.createAgentSpec({
        productId,
        name: agentSpecName.trim() || undefined,
        agentId,
        status: 'candidate',
        layerConfigRef: nextLayer?.id ?? baseSpec?.layerConfigRef,
        promptBlockRefs: baseSpec?.promptBlockRefs ?? [],
        skillRefs: baseSpec?.skillRefs ?? [],
        memoryPolicyRef: baseSpec?.memoryPolicyRef,
        retrievalPolicyRef: baseSpec?.retrievalPolicyRef,
        toolPolicyRef: baseSpec?.toolPolicyRef,
        modelPolicyRef: baseSpec?.modelPolicyRef,
        changelog: baseSpec ? `Created from ${baseSpec.id} with new behavior rule ${ruleConfig.id}@${ruleConfig.version}.` : 'Created with explicit behavior rule model.',
      });
      setSelectedAgentSpecId(spec.id);
      await patchSelectedRuntimeConfigFlow({
        status: 'candidate',
        candidateSpecId: spec.id,
        nodeRefs: { agentConfig: { source: 'derived', id: spec.id, version: spec.version, name: spec.name ?? spec.agentId } },
        changes: [{ scope: behaviorRuleScope, area: 'behavior_rule', agentId: behaviorRuleScope === 'agent' ? agentId : undefined, targetId: ruleConfig.id, summary: `新增行为规则 ${ruleConfig.title}` }],
      });
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
    if (!agentSpecName.trim()) {
      setError('Agent 配置名称是必填项。');
      return;
    }
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
      const isBehaviorRule = behaviorRuleConfigs.some((rule) => rule.id === block.id);
      const created = isBehaviorRule
        ? promptBlockFromBehaviorRule(await apiClient.createBehaviorRuleConfigVersion(block.id, {
            title: promptBlockTitle,
            content: promptBlockContent,
            status: 'candidate',
            scope: behaviorRuleScope,
            agentId: behaviorRuleScope === 'agent' ? agentId : undefined,
          }))
        : await apiClient.createPromptBlockVersion(block.id, {
            title: promptBlockTitle,
            scope: promptBlockScope,
            content: promptBlockContent,
            status: 'candidate',
          });
      setSelectedPromptBlockId(created.id);
      setPromptBlockVersion(String(created.version));
      setSelectedPromptBlockRef(`${created.id}@${created.version}`);
      const baseSpec = resolveDraftBaseAgentSpec();
      if (baseSpec) {
        const baseLayer = resolveLayerConfigForSpec(baseSpec);
        const nextLayer = baseLayer
          ? await apiClient.createAgentLayerConfig({
            ...stripLayerIdentity(baseLayer),
            status: 'candidate',
            promptBlockRefs: isBehaviorRule ? (baseLayer.promptBlockRefs ?? []) : replaceVersionedRef(baseLayer.promptBlockRefs ?? [], `${created.id}@${created.version}`),
            behaviorRuleRefs: isBehaviorRule ? replaceVersionedRef(baseLayer.behaviorRuleRefs ?? [], `${created.id}@${created.version}`) : (baseLayer.behaviorRuleRefs ?? []),
          })
          : undefined;
        const createdSpec = await apiClient.createAgentSpec({
          productId,
          name: agentSpecName.trim() || undefined,
          agentId,
          status: 'candidate',
          layerConfigRef: nextLayer?.id ?? baseSpec.layerConfigRef,
          promptBlockRefs: baseSpec.promptBlockRefs ?? [],
          skillRefs: baseSpec.skillRefs ?? [],
          memoryPolicyRef: baseSpec.memoryPolicyRef,
          retrievalPolicyRef: baseSpec.retrievalPolicyRef,
          toolPolicyRef: baseSpec.toolPolicyRef,
          modelPolicyRef: baseSpec.modelPolicyRef,
          changelog: `Created from ${baseSpec.id} with edited behavior rule ${created.id}@${created.version}.`,
        });
        setSelectedAgentSpecId(createdSpec.id);
        await patchSelectedRuntimeConfigFlow({
          status: 'candidate',
          candidateSpecId: createdSpec.id,
          nodeRefs: { agentConfig: { source: 'derived', id: createdSpec.id, version: createdSpec.version, name: createdSpec.name ?? createdSpec.agentId } },
          changes: [{ scope: behaviorRuleScope, area: 'behavior_rule', agentId: behaviorRuleScope === 'agent' ? agentId : undefined, targetId: created.id, summary: `修改行为规则 ${created.title}` }],
        });
      }
      await loadSummary();
      if (!isBehaviorRule) setVersionDiff(await apiClient.getPromptBlockDiff(created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存行为规则新版本失败');
    } finally {
      setState('idle');
    }
  }

  async function saveAgentInstructionOverride(): Promise<void> {
    if (!agentSpecName.trim()) {
      setError('Agent 配置名称是必填项。');
      return;
    }
    const currentActiveSpec = resolveDraftBaseAgentSpec();
    if (!currentActiveSpec?.layerConfigRef) {
      setError('当前 agent 缺少可复制的已发布运行配置');
      return;
    }
    const baseLayer = resolveLayerConfigForSpec(currentActiveSpec);
    if (!baseLayer) {
      setError('找不到当前已发布运行配置');
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
        status: 'candidate',
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
      await patchSelectedRuntimeConfigFlow({
        status: 'candidate',
        candidateSpecId: nextSpec.id,
        nodeRefs: { agentConfig: { source: 'derived', id: nextSpec.id, version: nextSpec.version, name: nextSpec.name ?? nextSpec.agentId } },
        changes: [{ scope: agentId === 'system' ? 'system' : 'agent', area: 'agent_prompt', agentId, targetId: agentId, summary: `修改 ${agentId} 主体提示词` }],
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 Agent 主体提示词失败');
    } finally {
      setState('idle');
    }
  }

  async function saveToolDescriptionOverride(): Promise<void> {
    if (!agentSpecName.trim()) {
      setError('Agent 配置名称是必填项。');
      return;
    }
    const currentActiveSpec = resolveDraftBaseAgentSpec();
    if (!currentActiveSpec?.layerConfigRef) {
      setError('当前 agent 缺少可复制的已发布运行配置');
      return;
    }
    const baseLayer = resolveLayerConfigForSpec(currentActiveSpec);
    if (!baseLayer) {
      setError('找不到当前已发布运行配置');
      return;
    }
    if (!toolDescriptionToolId.trim() || !toolDescriptionContent.trim()) {
      setError('工具 ID 和工具描述都需要填写');
      return;
    }
    const activeDescription = resolveToolDescriptionBaseline(toolDescriptionToolId, getLayerToolDescriptionOverrides(baseLayer));
    const nextOverride = normalizeToolDescriptionOverride({
      toolId: toolDescriptionToolId.trim(),
      description: toolDescriptionContent.trim(),
      parameterDescriptions: toolParameterDescriptions,
      outputDescription: toolOutputDescription.trim(),
    });
    if (isSameToolDescription(nextOverride, activeDescription)) {
      setError('工具描述、参数描述和输出描述都没有变化，不需要保存候选版本');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const toolDescriptionConfig = await apiClient.createToolDescriptionConfig({
        productId,
        status: 'candidate',
        scope: toolDescriptionScope,
        agentId: toolDescriptionScope === 'agent' ? agentId : undefined,
        title: `${toolDescriptionToolId.trim()} 工具说明`,
        toolId: toolDescriptionToolId.trim(),
        description: toolDescriptionContent.trim(),
        parameterDescriptions: toolParameterDescriptions,
        outputDescription: toolOutputDescription.trim() || undefined,
        tags: ['harness'],
      });
      const nextLayer = await apiClient.createAgentLayerConfig(updateLayerToolDescriptionRef(baseLayer, `${toolDescriptionConfig.id}@${toolDescriptionConfig.version}`));
      const nextSpec = await apiClient.createAgentSpec({
        productId,
        name: agentSpecName.trim() || undefined,
        agentId,
        status: 'candidate',
        layerConfigRef: nextLayer.id,
        promptBlockRefs: currentActiveSpec.promptBlockRefs,
        skillRefs: currentActiveSpec.skillRefs,
        memoryPolicyRef: currentActiveSpec.memoryPolicyRef,
        retrievalPolicyRef: currentActiveSpec.retrievalPolicyRef,
        toolPolicyRef: currentActiveSpec.toolPolicyRef,
        modelPolicyRef: currentActiveSpec.modelPolicyRef,
        changelog: `Created from ${currentActiveSpec.id} with edited ${toolDescriptionToolId} tool description.`,
      });
      setSelectedAgentSpecId(nextSpec.id);
      await patchSelectedRuntimeConfigFlow({
        status: 'candidate',
        candidateSpecId: nextSpec.id,
        nodeRefs: { agentConfig: { source: 'derived', id: nextSpec.id, version: nextSpec.version, name: nextSpec.name ?? nextSpec.agentId } },
        changes: [{ scope: toolDescriptionScope, area: 'tool_description', agentId: toolDescriptionScope === 'agent' ? agentId : undefined, targetId: toolDescriptionConfig.id, summary: `修改工具说明 ${toolDescriptionToolId}` }],
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存工具描述失败');
    } finally {
      setState('idle');
    }
  }

  async function archiveSelectedAgentSpec(): Promise<void> {
    if (!selectedAgentSpecId) return;
    const spec = summary?.agentSpecs.find((item) => item.id === selectedAgentSpecId);
    if (spec?.status === 'active') {
      setError('不能从清理入口归档已发布运行配置；请先发布其他版本或执行回滚');
      return;
    }
    const confirmed = window.confirm('归档只会隐藏这个草稿/候选运行配置，不会删除历史评测记录。确认归档？');
    if (!confirmed) return;
    setState('saving');
    setError(null);
    try {
      await apiClient.deleteAgentSpec(selectedAgentSpecId);
      setSelectedAgentSpecId('');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '归档候选运行配置失败');
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
      setFixtureCreateFeedback(`已创建评测案例：${formatFixture(created)}`);
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { evalFixture: { source: 'new', id: created.id, name: created.name ?? created.target } },
        changes: [{ scope: 'agent', area: 'eval_fixture', agentId, targetId: created.id, summary: `绑定评测案例 ${created.name ?? created.target}` }],
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建评测案例失败');
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
      setFixtureCreateFeedback(`已创建评测案例：${formatFixture(created)}`);
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { evalFixture: { source: 'new', id: created.id, name: created.name ?? created.target } },
        changes: [{ scope: 'agent', area: 'eval_fixture', agentId, targetId: created.id, summary: `从失败运行绑定评测案例 ${created.name ?? created.target}` }],
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '从历史运行创建评测案例失败');
    } finally {
      setState('idle');
    }
  }

  async function createFixtureFromChatMessage(): Promise<void> {
    if (actionLockRef.current) return;
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
    const creationKey = `${session.id}:${message.id}:${snapshotId}`;
    if (createdFixtureMessageKeys.includes(creationKey)) {
      setError('这条消息已经在当前页面创建过评测案例；请切换消息或刷新后再确认。');
      return;
    }
    actionLockRef.current = true;
    setState('saving');
    setError(null);
    try {
      const inputMessages = buildFixtureInputMessages(session.messages, message.id);
      const target = `${agentId}-workflow`;
      const name = fixtureName.trim() || `${session.title} · ${message.content.slice(0, 24)}`;
      const fixtureInput = {
        snapshotId,
        name,
        target,
        inputMessages,
        tags: ['from-chat', session.title],
      };
      const created = artifact
        ? await apiClient.createEvalFixtureFromRunArtifact(artifact.runId, {
            ...fixtureInput,
          })
        : await apiClient.createEvalFixture(fixtureInput);
      setSelectedFixtureId(created.id);
      setCreatedFixtureMessageKeys((current) => uniqueStrings([...current, creationKey]));
      setFixtureCreateFeedback(`已从历史消息创建评测案例：${formatFixture(created)}`);
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { evalFixture: { source: 'new', id: created.id, name: created.name ?? created.target } },
        changes: [{ scope: 'agent', area: 'eval_fixture', agentId, targetId: created.id, summary: `从历史消息绑定评测案例 ${created.name ?? created.target}` }],
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '从历史对话创建评测案例失败');
    } finally {
      actionLockRef.current = false;
      setState('idle');
    }
  }

  async function createEvalRun(): Promise<void> {
    if (!selectedFixtureId || !selectedAgentSpecId) {
      setError(!selectedAgentSpecId ? '请先选择候选运行配置，再创建评测运行' : '请先选择评测案例，再创建评测运行');
      return;
    }
    let evalRunConfigId = selectedEvalRunConfigId || undefined;
    let assertionConfigId = selectedAssertionConfigId || undefined;
    setState('saving');
    setError(null);
    setEvalRunFeedback('正在创建评测运行...');
    try {
      if (!evalRunConfigId) {
        const createdConfig = await apiClient.createEvalRunConfig(buildEvalRunConfigInput({
          productId,
          name: `${productId} / ${evalRunMode} / 临时评测运行配置 / ${formatDateTime(new Date().toISOString())}`,
          status: 'candidate',
          source: { type: 'new' },
          runMode: evalRunMode,
          memoryMode: evalMemoryMode,
          knowledgeMode: evalKnowledgeMode,
          highRiskToolMode: 'mock',
          tags: [evalRunMode],
        }));
        evalRunConfigId = createdConfig.id;
        setSelectedEvalRunConfigId(createdConfig.id);
      }
      if (!assertionConfigId && fixtureAssertionsText.trim()) {
        const parsedAssertions = parseAssertionsText(fixtureAssertionsText);
        const assertionDefinitions = assertionDefinitionsFromCompiled(parsedAssertions);
        if (assertionDefinitions.length === 0) {
          setEvalRunFeedback('');
          setError('当前断言表单没有有效断言。请清空表单，或先保存有效断言配置。');
          return;
        }
        const createdAssertionConfig = await apiClient.createAssertionConfig({
          productId: selectedFixture?.productId ?? productId,
          name: assertionConfigName.trim() || `${selectedFixture?.productId ?? productId} / 断言配置 / ${formatDateTime(new Date().toISOString())}`,
          status: 'candidate',
          source: selectedFixture ? { type: 'eval_fixture', id: selectedFixture.id } : { type: 'new' },
          assertions: assertionDefinitions,
          compiledAssertions: parsedAssertions,
          tags: selectedFixture?.tags ?? [productId],
        });
        assertionConfigId = createdAssertionConfig.id;
        setSelectedAssertionConfigId(createdAssertionConfig.id);
      }
      const created = await apiClient.createEvalRun({
        fixtureId: selectedFixtureId,
        agentSpecId: selectedAgentSpecId,
        evalRunConfigId,
        assertionConfigId,
        humanReviewRubricId: selectedRubricId || undefined,
        runMode: evalRunMode,
      });
      setSelectedEvalRunId(created.id);
      setActiveHarnessTab('review');
      setEvalRunFeedback(`评测运行已启动：${created.id.slice(0, 18)}。运行中会自动刷新详情。`);
      await patchSelectedRuntimeConfigFlow({
        evalRunIds: uniqueStrings([...(selectedFlow?.evalRunIds ?? []), created.id]),
        nodeRefs: {
          evalFixture: selectedFixture ? { source: 'reused', id: selectedFixture.id, name: selectedFixture.name ?? selectedFixture.target } : undefined,
          evalRunConfig: evalRunConfigId ? { source: selectedEvalRunConfig ? (selectedEvalRunConfig.source?.type === 'new' ? 'new' : 'reused') : 'new', id: evalRunConfigId, version: selectedEvalRunConfig?.version, name: selectedEvalRunConfig?.name ?? '临时评测运行配置' } : undefined,
          assertionConfig: assertionConfigId ? { source: selectedAssertionConfig ? (selectedAssertionConfig.source?.type === 'new' ? 'new' : 'reused') : 'new', id: assertionConfigId, version: selectedAssertionConfig?.version, name: selectedAssertionConfig?.name ?? (assertionConfigName.trim() || '断言配置') } : undefined,
          reviewTemplate: selectedRubric ? { source: selectedRubric.source?.type === 'new' ? 'new' : 'reused', id: selectedRubric.id, version: selectedRubric.version, name: selectedRubric.name ?? selectedRubric.artifactType } : undefined,
        },
      });
      await loadSummary();
    } catch (err) {
      setEvalRunFeedback('');
      setError(err instanceof Error ? err.message : '创建评测运行失败');
    } finally {
      setState('idle');
    }
  }

  async function createAssertionConfigFromFixture(): Promise<void> {
    if (!selectedFixture && !productId) return;
    const parsed = parseAssertionsText(fixtureAssertionsText);
    const assertions = assertionDefinitionsFromCompiled(parsed);
    if (assertions.length === 0) {
      setError('断言配置至少需要一条有效断言');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.createAssertionConfig({
        productId: selectedFixture?.productId ?? productId,
        name: assertionConfigName.trim() || `${selectedFixture?.productId ?? productId} / 断言配置 / ${formatDateTime(new Date().toISOString())}`,
        status: 'candidate',
        source: selectedFixture ? { type: 'eval_fixture', id: selectedFixture.id } : { type: 'new' },
        assertions,
        compiledAssertions: parsed,
        tags: selectedFixture?.tags ?? [productId],
      });
      setSelectedAssertionConfigId(created.id);
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { assertionConfig: { source: 'new', id: created.id, version: created.version, name: created.name } },
        changes: [{ scope: 'agent', area: 'assertion_config', agentId, targetId: created.id, summary: `绑定断言配置 ${created.name}` }],
      });
      fixtureAssertionsDirtyRef.current = false;
      setEvalRunFeedback('断言配置已保存，可以在下一步执行评测');
      setAssertionConfigName('');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存断言配置失败');
    } finally {
      setState('idle');
    }
  }

  async function saveAssertionConfigFromTemplate(): Promise<void> {
    if (!assertionConfigTemplateId) {
      await createAssertionConfigFromFixture();
      return;
    }
    const name = assertionConfigName.trim();
    if (!name) {
      setError('请先填写新断言配置名称。');
      return;
    }
    const parsed = parseAssertionsText(fixtureAssertionsText);
    const assertions = assertionDefinitionsFromCompiled(parsed);
    if (assertions.length === 0) {
      setError('断言配置至少需要一条有效断言');
      return;
    }
    const template = latestVersionedRecord(assertionConfigs, assertionConfigTemplateId);
    setState('saving');
    setError(null);
    setEvalRunFeedback('正在保存断言配置...');
    try {
      const created = await apiClient.createAssertionConfig({
        productId: template?.productId ?? selectedFixture?.productId ?? productId,
        name,
        status: 'candidate',
        source: template ? { type: 'assertion_config', id: template.id, version: template.version } : { type: 'new' },
        assertions,
        compiledAssertions: parsed,
        tags: template?.tags ?? selectedFixture?.tags ?? [productId],
      });
      setSelectedAssertionConfigId(created.id);
      setAssertionConfigTemplateId('');
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { assertionConfig: { source: 'derived', id: created.id, version: created.version, name: created.name } },
        changes: [{ scope: 'agent', area: 'assertion_config', agentId, targetId: created.id, summary: `基于已有断言配置保存 ${created.name}` }],
      });
      fixtureAssertionsDirtyRef.current = false;
      setEvalRunFeedback('断言配置已保存，可以在下一步执行评测');
      await loadSummary();
    } catch (err) {
      setEvalRunFeedback('');
      setError(err instanceof Error ? err.message : '保存断言配置失败');
    } finally {
      setState('idle');
    }
  }

  async function createEvalRunConfigFromForm(): Promise<void> {
    if (evalRunMode === 'repro' && (evalMemoryMode === 'live' || evalKnowledgeMode === 'live')) {
      setError('Repro 评测不能读取 live memory/knowledge；请选择 fixture 或 mocked。');
      return;
    }
    if (evalRunMode === 'live' && evalMemoryMode !== 'live' && evalKnowledgeMode !== 'live') {
      setError('Live 评测必须显式读取 live memory 或 live knowledge。');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const template = evalRunConfigTemplateId ? evalRunConfigs.find((config) => config.id === evalRunConfigTemplateId) : undefined;
      const created = await apiClient.createEvalRunConfig(buildEvalRunConfigInput({
        productId,
        name: evalRunConfigName.trim() || `${productId} / 评测运行配置 / ${formatDateTime(new Date().toISOString())}`,
        status: 'candidate',
        source: template ? { type: 'eval_run_config', id: template.id, version: template.version } : { type: 'new' },
        runMode: evalRunMode,
        memoryMode: evalMemoryMode,
        knowledgeMode: evalKnowledgeMode,
        highRiskToolMode: template?.highRiskToolMode ?? 'mock',
        toolMocks: template?.toolMocks,
        tags: template?.tags ?? [evalRunMode],
      }));
      setSelectedEvalRunConfigId(created.id);
      setEvalRunConfigTemplateId('');
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { evalRunConfig: { source: template ? 'derived' : 'new', id: created.id, version: created.version, name: created.name } },
        changes: [{ scope: 'agent', area: 'eval_run_config', agentId, targetId: created.id, summary: `${template ? '基于已有运行策略保存' : '绑定评测运行配置'} ${created.name}` }],
      });
      setEvalRunFeedback('评测运行配置已保存');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存评测运行配置失败');
    } finally {
      setState('idle');
    }
  }

  async function selectOrCloneEvalFixture(fixtureId: string): Promise<void> {
    if (!fixtureId) {
      setFixtureTemplateId('');
      setSelectedFixtureId('');
      return;
    }
    const fixture = fixtures.find((item) => item.id === fixtureId);
    if (!fixture) return;
    setFixtureTemplateId(fixture.id);
    setSelectedFixtureId('');
    setFixtureName(fixture.name ?? fixture.target);
    setFixtureAssertionsText(JSON.stringify(fixture.assertions ?? {}, null, 2));
    fixtureAssertionsDirtyRef.current = false;
  }

  async function selectOrCloneAgentSpec(agentSpecId: string): Promise<void> {
    if (!agentSpecId) {
      setAgentConfigTemplateId('');
      setSelectedAgentSpecId('');
      return;
    }
    const spec = agentSpecs.find((item) => item.id === agentSpecId);
    if (!spec) return;
    setAgentConfigTemplateId(spec.id);
    setSelectedAgentSpecId('');
    setProductId(spec.productId);
    setAgentId(spec.agentId);
    setAgentSpecName(spec.name ?? spec.agentId);
    const layerConfig = spec.layerConfigRef
      ? layerConfigs.find((config) => config.id === spec.layerConfigRef || `${config.id}@${config.version}` === spec.layerConfigRef)
      : undefined;
    const instruction = spec.agentId === 'system'
      ? layerConfig?.systemAgent.instructionOverride
      : layerConfig?.specialists.find((specialist) => specialist.agentId === spec.agentId)?.instructionOverride;
    setAgentInstructionContent(instruction ?? '');
  }

  async function selectOrCloneEvalRunConfig(configId: string): Promise<void> {
    if (!configId) {
      setEvalRunConfigTemplateId('');
      setSelectedEvalRunConfigId('');
      return;
    }
    const config = evalRunConfigs.find((item) => item.id === configId);
    if (!config) return;
    setEvalRunConfigTemplateId(config.id);
    setSelectedEvalRunConfigId('');
    setEvalRunConfigName(config.name);
    setEvalRunMode(config.runMode);
    setEvalMemoryMode(config.memoryMode);
    setEvalKnowledgeMode(config.knowledgeMode);
  }

  async function selectOrCloneAssertionConfig(configId: string): Promise<void> {
    if (!configId) {
      setAssertionConfigTemplateId('');
      setSelectedAssertionConfigId('');
      return;
    }
    const config = latestVersionedRecord(assertionConfigs, configId);
    if (!config) return;
    setAssertionConfigTemplateId(config.id);
    setSelectedAssertionConfigId('');
    setAssertionConfigName(config.name);
    setFixtureAssertionsText(JSON.stringify(config.compiledAssertions ?? {}, null, 2));
    fixtureAssertionsDirtyRef.current = false;
  }

  async function saveFixtureFromTemplate(): Promise<void> {
    if (!fixtureTemplateId) return;
    const name = fixtureName.trim();
    if (!name) {
      setError('请先填写新评测案例名称。');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const cloned = await apiClient.cloneEvalFixture(fixtureTemplateId, { name });
      const parsedAssertions = fixtureAssertionsText.trim() ? parseAssertionsText(fixtureAssertionsText) : {};
      const saved = fixtureAssertionsDirtyRef.current
        ? await apiClient.updateEvalFixture(cloned.id, { assertions: parsedAssertions })
        : cloned;
      setSelectedFixtureId(saved.id);
      setFixtureTemplateId('');
      setFixtureCreateFeedback(`已保存评测案例：${formatFixture(saved)}`);
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { evalFixture: { source: 'derived', id: saved.id, name: saved.name ?? saved.target } },
        changes: [{ scope: 'agent', area: 'eval_fixture', agentId, targetId: saved.id, summary: `基于已有案例保存 ${saved.name ?? saved.target}` }],
      });
      fixtureAssertionsDirtyRef.current = false;
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存评测案例失败');
    } finally {
      setState('idle');
    }
  }

  async function createReviewTemplateFromCurrent(): Promise<void> {
    if (reviewTemplateName.trim().length === 0) {
      setError('审阅模板需要填写名称');
      return;
    }
    const baseRubric = selectedRubric;
    const draftScores = normalizeReviewTemplateScores(reviewTemplateScoreItems);
    if (draftScores.length === 0) {
      setError('审阅模板至少需要一个打分项');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const created = await apiClient.createHumanReviewRubric({
        productId,
        name: reviewTemplateName.trim(),
        artifactType: baseRubric?.artifactType ?? 'story',
        status: 'candidate',
        source: baseRubric ? { type: 'human_review_rubric', id: baseRubric.id, version: baseRubric.version } : { type: 'new' },
        hardChecks: baseRubric?.hardChecks ?? [],
        humanScores: draftScores.map((score) => ({
          id: score.id,
          label: score.label,
          scale: 10 as const,
          weight: score.weight,
          required: score.required ?? true,
          description: score.description,
          notePrompt: score.notePrompt,
        })),
        decisionRules: { requiresHumanDecision: true },
      });
      setSelectedRubricId(created.id);
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { reviewTemplate: { source: 'derived', id: created.id, version: created.version, name: created.name ?? created.artifactType } },
        changes: [{ scope: 'agent', area: 'review_template', agentId, targetId: created.id, summary: `绑定人工审阅模板 ${created.name ?? created.artifactType}` }],
      });
      setReviewTemplateName('');
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存审阅模板失败');
    } finally {
      setState('idle');
    }
  }

  async function saveAssertionConfigVersionFromEditor(): Promise<void> {
    const parsed = parseAssertionsText(fixtureAssertionsText);
    const definitions = assertionDefinitionsFromCompiled(parsed);
    if (definitions.length === 0) {
      setError('断言配置至少需要一条有效断言');
      return;
    }
    if (!selectedAssertionConfigId) {
      await createAssertionConfigFromFixture();
      return;
    }
    setState('saving');
    setError(null);
    setEvalRunFeedback('正在保存断言配置版本...');
    try {
      const updated = await apiClient.createAssertionConfigVersion(selectedAssertionConfigId, {
        assertions: definitions,
        compiledAssertions: parsed,
        status: 'candidate',
      });
      setSelectedAssertionConfigId(updated.id);
      await patchSelectedRuntimeConfigFlow({
        nodeRefs: { assertionConfig: { source: 'derived', id: updated.id, version: updated.version, name: updated.name } },
        changes: [{ scope: 'agent', area: 'assertion_config', agentId, targetId: updated.id, summary: `修改断言配置 ${updated.name}` }],
      });
      fixtureAssertionsDirtyRef.current = false;
      setEvalRunFeedback('断言配置已保存，可以在下一步执行评测');
      await loadSummary();
    } catch (err) {
      setEvalRunFeedback('');
      setError(err instanceof Error ? err.message : '保存断言配置失败');
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
      setError(err instanceof Error ? err.message : '保存评测案例失败');
    } finally {
      setState('idle');
    }
  }

  async function addFixtureAssertion(): Promise<void> {
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
    fixtureAssertionsDirtyRef.current = true;
  }

  async function removeSelectedFixtureAssertions(): Promise<void> {
    if (selectedAssertionIds.length === 0) return;
    const current = parseAssertionsText(fixtureAssertionsText);
    const next = selectedAssertionIds.reduce((assertions, assertionId) => removeAssertionById(assertions, assertionId), current);
    setFixtureAssertionsText(JSON.stringify(next, null, 2));
    setSelectedAssertionIds([]);
    fixtureAssertionsDirtyRef.current = true;
  }

  function toggleFixtureAssertion(assertionId: string): void {
    setSelectedAssertionIds((current) => current.includes(assertionId)
      ? current.filter((id) => id !== assertionId)
      : [...current, assertionId]);
  }

  function toggleAllFixtureAssertions(assertions: AssertionRow[]): void {
    setSelectedAssertionIds((current) => current.length === assertions.length ? [] : assertions.map((assertion) => assertion.id));
  }

  function resetFixtureTemplateDraft(): void {
    setFixtureTemplateId('');
    setFixtureName('');
    setFixtureAssertionsText(selectedAssertionConfig
      ? JSON.stringify(selectedAssertionConfig.compiledAssertions ?? {}, null, 2)
      : selectedFixture && Object.keys(selectedFixture.assertions ?? {}).length > 0
        ? JSON.stringify(selectedFixture.assertions, null, 2)
        : '');
    fixtureAssertionsDirtyRef.current = false;
  }

  function resetAgentConfigTemplateDraft(): void {
    setAgentConfigTemplateId('');
    setAgentSpecName('');
    setSelectedAgentSpecId(activeAgentSpec?.id ?? selectedAgentSpecId);
  }

  function resetEvalRunConfigTemplateDraft(): void {
    setEvalRunConfigTemplateId('');
    setEvalRunConfigName('');
    setSelectedEvalRunConfigId(selectedEvalRunConfig?.id ?? '');
  }

  function resetAssertionConfigTemplateDraft(): void {
    setAssertionConfigTemplateId('');
    setAssertionConfigName('');
    setSelectedAssertionConfigId(selectedAssertionConfig?.id ?? '');
    setFixtureAssertionsText(selectedAssertionConfig
      ? JSON.stringify(selectedAssertionConfig.compiledAssertions ?? {}, null, 2)
      : selectedFixture && Object.keys(selectedFixture.assertions ?? {}).length > 0
        ? JSON.stringify(selectedFixture.assertions, null, 2)
        : '');
    fixtureAssertionsDirtyRef.current = false;
  }

  function addReviewTemplateScoreItem(): void {
    setReviewTemplateScoreItems((current) => {
      const nextIndex = current.length + 1;
      return [...current, { id: `score_${nextIndex}`, label: `打分项 ${nextIndex}`, weight: 1, required: true }];
    });
  }

  function updateReviewTemplateScoreItem(id: string, patch: Partial<ReviewScoreItemDraft>): void {
    setReviewTemplateScoreItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function removeReviewTemplateScoreItem(id: string): void {
    setReviewTemplateScoreItems((current) => current.filter((item) => item.id !== id));
  }

  async function saveHumanReview(): Promise<void> {
    if (!selectedEvalRunId) return;
    const rubric = selectedRubric;
    if (!rubric) {
      setError('没有可用人工审阅模板');
      return;
    }
    setState('saving');
    setError(null);
    try {
      await apiClient.addHumanReview(selectedEvalRunId, {
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        reviewer: 'default',
        decision: 'pass',
        scoreStates: buildReviewScoreStates(rubric, reviewScoreStates),
        scores: buildReviewScores(rubric, reviewScores, reviewScoreStates),
        subScores: buildReviewSubScores(rubric, reviewSubScores),
        annotations: reviewAnnotations,
        notes: reviewNotes || undefined,
      });
      await patchSelectedRuntimeConfigFlow({
        evalRunIds: uniqueStrings([...(selectedFlow?.evalRunIds ?? []), selectedEvalRunId]),
        nodeRefs: selectedRubric ? { reviewTemplate: { source: selectedRubric.source?.type === 'new' ? 'new' : 'reused', id: selectedRubric.id, version: selectedRubric.version, name: selectedRubric.name ?? selectedRubric.artifactType } } : undefined,
      });
      await loadSummary();
      await loadReleaseGate();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存人工评分失败');
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
      const gate = releaseGate?.agentSpecId === selectedAgentSpecId ? releaseGate : await apiClient.getAgentSpecReleaseGate(selectedAgentSpecId);
      setReleaseGate(gate);
      if (!gate.passed) {
        setError(`发布检查未通过：${gate.reason}`);
        return;
      }
      const confirmed = window.confirm('确认发布当前运行配置？发布后它会成为普通运行默认配置。');
      if (!confirmed) return;
      await apiClient.updateAgentSpecStatus(selectedAgentSpecId, 'active', { reviewer: 'default', notes: 'Published from harness panel.' });
      const releases = await apiClient.listReleaseRecords({ productId, agentId, limit: 1 });
      await patchSelectedRuntimeConfigFlow({
        status: 'active',
        activeSpecId: selectedAgentSpecId,
        releaseRecordIds: uniqueStrings([...(selectedFlow?.releaseRecordIds ?? []), ...releases.map((record) => record.id)]),
      });
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布运行配置失败');
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

  const runtimeConfigFlows = (summary?.runtimeConfigFlows ?? []).filter(isUserRuntimeConfigFlow);
  const snapshots = summary?.snapshots ?? [];
  const agentSpecs = summary?.agentSpecs ?? [];
  const fixtures = summary?.evalFixtures ?? [];
  const assertionConfigs = summary?.assertionConfigs ?? [];
  const evalRunConfigs = summary?.evalRunConfigs ?? [];
  const evalRuns = summary?.evalRuns ?? [];
  const runArtifacts = summary?.runArtifacts ?? [];
  const layerConfigs = summary?.agentLayerConfigs ?? [];
  const memoryPolicies = summary?.memoryPolicies ?? [];
  const retrievalPolicies = summary?.retrievalPolicies ?? [];
  const promptBlocks = summary?.promptBlocks ?? [];
  const behaviorRuleConfigs = summary?.behaviorRuleConfigs ?? [];
  const workspaceManifests = summary?.workspaceManifests ?? [];
  const knowledgeEntries = summary?.knowledgeBaseEntries ?? [];
  const rubrics = summary?.humanReviewRubrics ?? [];
  const flowTagOptions = uniqueStrings(runtimeConfigFlows.flatMap((flow) => flow.tags)).sort((left, right) => left.localeCompare(right));
  const filteredFlows = filterRuntimeConfigFlowsForPanel(runtimeConfigFlows, { status: flowStatusFilter, releaseState: flowReleaseFilter, tag: flowTagFilter, query: flowQuery, sort: flowSort });
  const selectedFlow = runtimeConfigFlows.find((flow) => flow.id === selectedFlowId) ?? filteredFlows[0];
  const agentOptions = uniqueStrings([
    ...((PRODUCT_PROFILES as Record<string, { defaultAgentSkillNames?: string[] }>)[productId]?.defaultAgentSkillNames ?? []),
    ...agentSpecs.filter((spec) => spec.productId === productId).map((spec) => spec.agentId),
    ...layerConfigs.filter((config) => config.productId === productId).flatMap((config) => [config.systemAgent.agentId, ...config.specialists.map((specialist) => specialist.agentId)]),
    agentId,
  ]);
  const relevantPromptBlocks = [
    ...promptBlocks.filter((block) => block.productId === productId && isPromptBlockRelevantToAgent(block, agentId, selectedPromptBlockRef)),
    ...behaviorRuleConfigs
      .filter((rule) => rule.productId === productId && isBehaviorRuleRelevantToAgent(rule, agentId, selectedPromptBlockRef))
      .map(promptBlockFromBehaviorRule),
  ];
  const promptBlockOptions = relevantPromptBlocks.sort((left, right) => right.version - left.version);
  const promptBlockGroups = buildPromptBlockGroups(relevantPromptBlocks);
  const behaviorRulePromptBlocks = behaviorRuleConfigs.map(promptBlockFromBehaviorRule);
  const allPromptBlockRecords = [...promptBlocks, ...behaviorRulePromptBlocks];
  const selectedPromptBlockVersions = allPromptBlockRecords
    .filter((block) => block.id === selectedPromptBlockId)
    .sort((left, right) => right.version - left.version);
  const selectedPromptBlock = latestPromptBlock(allPromptBlockRecords, selectedPromptBlockId);
  const selectedPromptBlockForEdit = promptBlockVersion === 'latest'
    ? selectedPromptBlock
    : allPromptBlockRecords.find((block) => block.id === selectedPromptBlockId && block.version === Number(promptBlockVersion));
  const selectedAgentSpec = agentSpecs.find((spec) => spec.id === selectedAgentSpecId);
  const selectedAgentSpecPreview = selectedAgentSpec ? buildAgentSpecPreview(selectedAgentSpec, { layerConfigs, promptBlocks, memoryPolicies, retrievalPolicies, workspaceManifests }) : null;
  const activeAgentSpec = agentSpecs.find((spec) => spec.productId === productId && spec.agentId === agentId && spec.status === 'active');
  const activeAgentLayerConfig = activeAgentSpec?.layerConfigRef
    ? layerConfigs.find((config) => config.id === activeAgentSpec.layerConfigRef || `${config.id}@${config.version}` === activeAgentSpec.layerConfigRef)
    : layerConfigs.find((config) => config.productId === productId && config.status === 'active');
  const draftBaseAgentSpec = agentConfigTemplateId ? agentSpecs.find((spec) => spec.id === agentConfigTemplateId) : activeAgentSpec;
  const draftBaseAgentLayerConfig = draftBaseAgentSpec?.layerConfigRef
    ? layerConfigs.find((config) => config.id === draftBaseAgentSpec.layerConfigRef || `${config.id}@${config.version}` === draftBaseAgentSpec.layerConfigRef)
    : activeAgentLayerConfig;
  const activeAgentInstruction = agentId === 'system'
    ? draftBaseAgentLayerConfig?.systemAgent.instructionOverride ?? ''
    : draftBaseAgentLayerConfig?.specialists.find((specialist) => specialist.agentId === agentId)?.instructionOverride ?? '';
  const activeToolDescriptionOverrides = getLayerToolDescriptionOverrides(activeAgentLayerConfig);
  const draftToolDescriptionOverrides = getLayerToolDescriptionOverrides(draftBaseAgentLayerConfig);
  const toolDescriptionOptions = uniqueStrings([
    ...DEFAULT_TOOL_DESCRIPTION_TARGETS,
    ...activeToolDescriptionOverrides.map((override) => override.toolId),
    toolDescriptionToolId,
  ]);
  const activeToolDescription = resolveToolDescriptionBaseline(toolDescriptionToolId, draftToolDescriptionOverrides);
  const toolParameterKeys = uniqueStrings([
    ...Object.keys(activeToolDescription.parameterDescriptions ?? {}),
    ...Object.keys(toolParameterDescriptions),
  ]);
  const activeAgentSpecPreview = activeAgentSpec ? buildAgentSpecPreview(activeAgentSpec, { layerConfigs, promptBlocks, memoryPolicies, retrievalPolicies, workspaceManifests }) : null;
  const defaultPromptBlock = promptBlocks.find((block) => block.productId === productId && block.status === 'active' && block.scope !== 'tool');
  const defaultPromptBlockRef = defaultPromptBlock ? `${defaultPromptBlock.id}@${defaultPromptBlock.version}` : '';
  const selectedPromptBlockPreview = buildPromptBlockPreview(selectedPromptBlockRef || defaultPromptBlockRef, promptBlocks);
  const savedAgentConfigChanges = selectedFlow?.changes.filter((change) => change.area === 'agent_prompt' || change.area === 'behavior_rule' || change.area === 'tool_description') ?? [];
  const hasHarnessBasics = layerConfigs.some((config) => config.productId === productId)
    && memoryPolicies.some((policy) => policy.productId === productId)
    && retrievalPolicies.some((policy) => policy.productId === productId)
    && workspaceManifests.some((manifest) => manifest.productId === productId);
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId);
  const fixtureTemplate = fixtureTemplateId ? fixtures.find((fixture) => fixture.id === fixtureTemplateId) : undefined;
  const agentConfigTemplate = agentConfigTemplateId ? agentSpecs.find((spec) => spec.id === agentConfigTemplateId) : undefined;
  const assertionConfigOptions = latestRecordsById(assertionConfigs.filter((config) => config.productId === productId || config.productId === selectedFixture?.productId));
  const selectedAssertionConfig = selectedAssertionConfigId ? latestVersionedRecord(assertionConfigs, selectedAssertionConfigId) : undefined;
  const selectedEvalRunConfig = evalRunConfigs.find((config) => config.id === selectedEvalRunConfigId);
  const evalRunConfigTemplate = evalRunConfigTemplateId ? evalRunConfigs.find((config) => config.id === evalRunConfigTemplateId) : undefined;
  const assertionConfigTemplate = assertionConfigTemplateId ? assertionConfigOptions.find((config) => config.id === assertionConfigTemplateId) : undefined;
  const selectedFixtureAssertionRows = fixtureAssertionsText.trim() ? buildAssertionRows(parseAssertionsText(fixtureAssertionsText)) : [];
  const selectedFixtureSession = fixtureSessions.find((session) => session.id === fixtureSourceSessionId);
  const selectableFixtureMessages = selectedFixtureSession?.messages.filter((message) => message.role === 'user') ?? [];
  const selectedFixtureMessage = selectableFixtureMessages.find((message) => message.id === fixtureMessageId);
  const selectedFixtureRunId = selectedFixtureSession && selectedFixtureMessage ? findRunIdForMessage(selectedFixtureSession, selectedFixtureMessage.id) : undefined;
  const selectedFixtureArtifact = selectedFixtureRunId ? runArtifacts.find((artifact) => artifact.runId === selectedFixtureRunId) : undefined;
  const selectedFixtureSnapshot = findSnapshotForRunOrSession(snapshots, selectedFixtureRunId, fixtureSourceSessionId);
  const selectedEvalRun = evalRuns.find((run) => run.id === selectedEvalRunId);
  const selectedRubric = rubrics.find((rubric) => rubric.id === selectedRubricId) ?? rubrics.find((rubric) => rubric.productId === productId) ?? rubrics[0];
  const reviewComplete = selectedRubric ? selectedRubric.humanScores.every((score) => {
    const state = reviewScoreStates[score.id];
    if (state !== 'scored' && state !== 'not_applicable') return false;
    if (state === 'not_applicable') return true;
    const value = reviewScores[score.id];
    return Number.isFinite(value) && value >= 1 && value <= 10;
  }) : false;
  const selectedSpecRuns = selectedAgentSpecId ? evalRuns.filter((run) => run.agentSpecId === selectedAgentSpecId) : [];
  const editedPromptBlockChanged = Boolean(selectedPromptBlockForEdit)
    && (promptBlockTitle.trim() !== (selectedPromptBlockForEdit?.title ?? '')
      || promptBlockContent.trim() !== (selectedPromptBlockForEdit?.content ?? '')
      || promptBlockScope !== selectedPromptBlockForEdit?.scope);
  const agentInstructionChanged = agentInstructionContent.trim() !== activeAgentInstruction.trim();
  const toolDescriptionChanged = !isSameToolDescription(normalizeToolDescriptionOverride({
    toolId: toolDescriptionToolId,
    description: toolDescriptionContent,
    parameterDescriptions: toolParameterDescriptions,
    outputDescription: toolOutputDescription,
  }), activeToolDescription);
  const selectedPromptBlockChangedFromActive = Boolean(selectedPromptBlockRef)
    && !(draftBaseAgentLayerConfig?.promptBlockRefs ?? []).includes(selectedPromptBlockRef);
  const policyChanged = Boolean(
    (selectedMemoryPolicyRef.trim() && selectedMemoryPolicyRef.trim() !== draftBaseAgentSpec?.memoryPolicyRef)
    || (selectedRetrievalPolicyRef.trim() && selectedRetrievalPolicyRef.trim() !== draftBaseAgentSpec?.retrievalPolicyRef)
    || (selectedToolPolicyRef.trim() && selectedToolPolicyRef.trim() !== draftBaseAgentSpec?.toolPolicyRef)
    || (selectedModelPolicyRef.trim() && selectedModelPolicyRef.trim() !== draftBaseAgentSpec?.modelPolicyRef),
  );
  const canCreateAgentSpec = Boolean(!draftBaseAgentSpec || selectedPromptBlockChangedFromActive || policyChanged);
  const createEvalRunBlockedReason = !selectedAgentSpecId
    ? '需要先选择候选运行配置'
    : !selectedFixtureId
      ? '需要先选择评测案例'
      : '';
  const reviewPipelineStep = resolveReviewPipelineStep(selectedEvalRun, assertionResultViewed, reviewScoreSkipped);
  const canNormalRelease = Boolean(selectedAgentSpecId && selectedEvalRun?.status === 'passed');

  return (
    <div className={`harness-panel${standalone ? ' harness-panel--standalone' : ''}`}>
      <div className="harness-toolbar">
        <button type="button" onClick={() => void loadSummary()} disabled={state !== 'idle'}>刷新</button>
      </div>
      {error ? <p className="git-result error">{error}</p> : null}
      {state === 'loading' ? <p className="muted">正在读取 Harness 状态...</p> : null}

      <section className="harness-section harness-flow-overview">
        <SectionHeader title="运行配置流程" description="先选择或创建一个流程，再在下方完成案例、配置、评测、审阅和发布。列表只保留定位所需信息，详细内容在具体流程里查看。" />
        <div className="harness-flow-create">
          <label><span>新流程名称</span><input value={newFlowName} onChange={(event) => setNewFlowName(event.target.value)} placeholder="例如：情景剧故事规则回归流程" /></label>
          <button type="button" onClick={() => void createRuntimeConfigFlowDraft()} disabled={state !== 'idle' || !newFlowName.trim()}>新建配置流程</button>
        </div>
        <div className="harness-form-row compact">
          <input value={flowQuery} onChange={(event) => setFlowQuery(event.target.value)} placeholder="搜索流程 ID、名称、标签" />
          <select value={flowStatusFilter} onChange={(event) => setFlowStatusFilter(event.target.value as FlowStatusFilter)}>
            <option value="all">全部状态</option>
            <option value="draft">草稿</option>
            <option value="candidate">候选</option>
            <option value="active">已发布</option>
            <option value="archived">已归档</option>
          </select>
          <select value={flowReleaseFilter} onChange={(event) => setFlowReleaseFilter(event.target.value as FlowReleaseFilter)}>
            <option value="all">全部发布状态</option>
            <option value="never_released">未发布</option>
            <option value="released">已发布</option>
            <option value="rolled_back">已回滚</option>
            <option value="archived">已归档</option>
          </select>
          <select value={flowTagFilter} onChange={(event) => setFlowTagFilter(event.target.value)}>
            <option value="all">全部标签</option>
            {flowTagOptions.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
          <select value={flowSort} onChange={(event) => setFlowSort(event.target.value as FlowSort)}>
            <option value="updatedAt">按更新时间</option>
            <option value="createdAt">按创建时间</option>
            <option value="gateStatus">按 Gate</option>
            <option value="evalCompletion">按评测完成度</option>
          </select>
        </div>
        <RuntimeConfigFlowTable
          flows={filteredFlows}
          selectedFlowId={selectedFlow?.id ?? ''}
          onSelect={(flow) => {
            setSelectedFlowId(flow.id);
            setProductId(flow.productId);
            if (flow.agentId) setAgentId(flow.agentId);
            setSelectedAgentSpecId(flow.candidateSpecId ?? flow.activeSpecId ?? flow.nodeRefs.agentConfig?.id ?? selectedAgentSpecId);
            setSelectedFixtureId(flow.nodeRefs.evalFixture?.id ?? selectedFixtureId);
            setSelectedAssertionConfigId(flow.nodeRefs.assertionConfig?.id ?? selectedAssertionConfigId);
            setSelectedEvalRunConfigId(flow.nodeRefs.evalRunConfig?.id ?? selectedEvalRunConfigId);
            setSelectedRubricId(flow.nodeRefs.reviewTemplate?.id ?? selectedRubricId);
          }}
          onOpen={(flow, tab) => {
            setSelectedFlowId(flow.id);
            setActiveHarnessTab(tab);
          }}
          onClone={(flow) => void cloneRuntimeConfigFlow(flow)}
          onArchive={(flow) => void archiveRuntimeConfigFlow(flow)}
          onDelete={(flow) => void deleteRuntimeConfigFlowDraft(flow)}
        />
      </section>

      {selectedFlow ? <section className="harness-section harness-flow-detail-shell">
        <div className="harness-flow-detail-header">
          <div>
            <strong>当前配置流程</strong>
            <small>{selectedFlow.id}</small>
          </div>
          <div className="harness-flow-rename">
            <input value={flowRenameText} onChange={(event) => setFlowRenameText(event.target.value)} aria-label="配置流程名称" />
            <button type="button" onClick={() => void renameSelectedRuntimeConfigFlow()} disabled={state !== 'idle' || !selectedFlow.id.startsWith('runtime_config_flow_') || !flowRenameText.trim() || flowRenameText.trim() === selectedFlow.name}>重命名</button>
          </div>
        </div>
      </section> : null}

      <div className="harness-workflow harness-workflow--pipeline" role="tablist" aria-label="Agent Harness 流程">
        <WorkflowStep index="1" title="评测案例上下文" detail="从历史消息或失败运行固定评测输入。" active={activeHarnessTab === 'fixtures'} onClick={() => setActiveHarnessTab('fixtures')} />
        <WorkflowStep index="2" title="Agent 配置" detail="编辑提示词、工具说明、行为规则和运行策略。" active={activeHarnessTab === 'config'} onClick={() => setActiveHarnessTab('config')} />
        <WorkflowStep index="3" title="评测运行与断言" detail="保存执行策略和断言配置。" active={activeHarnessTab === 'eval'} onClick={() => setActiveHarnessTab('eval')} />
        <WorkflowStep index="4" title="运行、审阅与发布" detail="提交运行，查看过程、断言结果，评分后发布。" active={activeHarnessTab === 'review'} onClick={() => setActiveHarnessTab('review')} />
      </div>

      {activeHarnessTab === 'config' ? <section className="harness-section harness-pipeline-node harness-config-node">
        <NodeHeader index="2" title="Agent 配置" description="提示词、行为规则和工具描述是并列配置片段；行为规则和工具描述必须标明 system/product/agent 生效范围。" />
        <div className="harness-agent-config-editor">
          <div className="harness-config-stage-head">
            <div>
              <strong>Agent 配置编辑区</strong>
              <small>可先载入已有配置作为草稿，修改名称和内容后再保存候选版本。</small>
            </div>
            <label><span>配置名称</span><input value={agentSpecName} onChange={(event) => setAgentSpecName(event.target.value)} placeholder="例如：story-agent 质量门槛实验" required /></label>
          </div>
          <div className="harness-node-reuse-bar">
            <label><span>载入已有 Agent 配置作为草稿</span><select value={agentConfigTemplateId || selectedAgentSpecId} onChange={(event) => void selectOrCloneAgentSpec(event.target.value)} disabled={state !== 'idle'}>
              <option value="">从空白配置开始...</option>
              {agentSpecs.filter((spec) => spec.productId === productId).map((spec) => <option key={spec.id} value={spec.id}>{formatAgentSpec(spec)}</option>)}
            </select></label>
            {agentConfigTemplate ? <div className="harness-reuse-draft-note"><strong>已载入草稿来源</strong><small>{formatAgentSpec(agentConfigTemplate)}</small><button type="button" onClick={resetAgentConfigTemplateDraft}>清空草稿</button></div> : null}
          </div>

          <div className="harness-config-layout">
            <aside className="harness-config-change-board" aria-label="Agent 配置改动列表">
              <div className="harness-config-change-board__head"><strong>改动列表</strong><small>{savedAgentConfigChanges.length} 条已保存</small></div>
              {savedAgentConfigChanges.length > 0 ? savedAgentConfigChanges.map((change, index) => (
                <button type="button" key={`${change.area}-${change.targetId ?? index}`} onClick={() => {
                  setAgentConfigEditType(change.area === 'agent_prompt' || change.area === 'behavior_rule' || change.area === 'tool_description' ? change.area : 'agent_prompt');
                  loadRuntimeConfigChangeIntoEditor(change);
                }}>
                  <strong>{formatRuntimeConfigChangeArea(change.area)}</strong>
                  <span>{change.summary}</span>
                  <small>{change.scope}{change.agentId ? ` / ${change.agentId}` : ''}</small>
                </button>
              )) : <div className="harness-config-change-empty"><strong>暂无改动</strong><small>在右侧选择配置类型并保存后，会出现在这里。</small></div>}
            </aside>

            <div className="harness-config-editor-shell">
              <div className="harness-config-edit-type">
                <label><span>配置类型</span><select value={agentConfigEditType} onChange={(event) => setAgentConfigEditType(event.target.value as typeof agentConfigEditType)}>
                  <option value="agent_prompt">Agent 提示词</option>
                  <option value="behavior_rule">行为规则</option>
                  <option value="tool_description">工具描述</option>
                </select></label>
              </div>

              {agentConfigEditType === 'agent_prompt' ? <section className="harness-config-fragment">
                <div className="harness-config-fragment__head"><strong>Agent 提示词</strong><span>agent / {productId} / {agentId}</span></div>
                <label><span>目标 Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agentOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                <label className="harness-field harness-field--wide"><span>候选正文</span><textarea value={agentInstructionContent} onChange={(event) => setAgentInstructionContent(event.target.value)} rows={12} placeholder="角色定位、职责、主体流程等…" /></label>
                <div className="harness-action-row">
                <button type="button" onClick={() => void saveAgentInstructionOverride()} disabled={state !== 'idle' || !draftBaseAgentSpec || !agentSpecName.trim() || !agentInstructionContent.trim() || !agentInstructionChanged}>保存提示词候选</button>
                </div>
              </section> : null}

              {agentConfigEditType === 'behavior_rule' ? <section className="harness-config-fragment">
                <div className="harness-config-fragment__head"><strong>行为规则</strong><span>{behaviorRuleScope} / {productId}{behaviorRuleScope === 'agent' ? ` / ${agentId}` : ''}</span></div>
                <div className="harness-form-grid">
                  <label><span>生效范围</span><select value={behaviorRuleScope} onChange={(event) => setBehaviorRuleScope(event.target.value as typeof behaviorRuleScope)}>
                    <option value="system">system</option>
                    <option value="product">product</option>
                    <option value="agent">agent</option>
                  </select></label>
                  <label><span>规则类型</span><select value={promptBlockScope} onChange={(event) => setPromptBlockScope(event.target.value as PromptBlock['scope'])}>
                    {promptBlockScopeOptions(agentId, promptBlockScope).map((scope) => <option key={scope} value={scope}>{PROMPT_BLOCK_SCOPE_LABELS[scope]}</option>)}
                  </select></label>
                </div>
                <label><span>选择行为规则</span><select value={selectedPromptBlockRef} onChange={(event) => {
                  const nextRef = event.target.value;
                  setSelectedPromptBlockRef(nextRef);
                  setSelectedPromptBlockId(nextRef ? parseVersionRef(nextRef).id : '');
                  setPromptBlockVersion(nextRef ? String(parseVersionRef(nextRef).version ?? 'latest') : 'latest');
                }}><option value="">新建行为规则...</option>{promptBlockGroups.map((group) => <optgroup key={group.group} label={formatPromptBlockGroupName(group.group)}>{group.blocks.map((block) => <option key={`${block.id}@${block.version}`} value={`${block.id}@${block.version}`}>{block.title} · v{block.version} · {block.status}</option>)}</optgroup>)}</select></label>
                <div className="harness-form-grid">
                  <label><span>规则标题</span><input value={selectedPromptBlockId ? promptBlockTitle : newPromptBlockTitle} onChange={(event) => selectedPromptBlockId ? setPromptBlockTitle(event.target.value) : setNewPromptBlockTitle(event.target.value)} placeholder="行为规则标题…" /></label>
                  <label><span>规则版本</span><select value={promptBlockVersion} onChange={(event) => setPromptBlockVersion(event.target.value)} disabled={!selectedPromptBlockId}>
                    <option value="latest">最新版本</option>
                    {selectedPromptBlockVersions.map((block) => <option key={`${block.id}@${block.version}`} value={String(block.version)}>v{block.version} · {block.status}</option>)}
                  </select></label>
                </div>
                <label className="harness-field harness-field--wide"><span>规则内容</span><textarea value={selectedPromptBlockId ? promptBlockContent : newPromptBlockContent} onChange={(event) => selectedPromptBlockId ? setPromptBlockContent(event.target.value) : setNewPromptBlockContent(event.target.value)} rows={8} placeholder="输出质量、写入边界、审稿口径等…" /></label>
                <div className="harness-action-row">
                  {selectedPromptBlockId ? <button type="button" onClick={() => void savePromptBlockVersion()} disabled={state !== 'idle' || !agentSpecName.trim() || !promptBlockTitle.trim() || !promptBlockContent.trim() || !editedPromptBlockChanged}>保存规则候选</button> : <button type="button" onClick={() => void createPromptBlockModel()} disabled={state !== 'idle' || !agentSpecName.trim() || !newPromptBlockTitle.trim() || !newPromptBlockContent.trim()}>新建规则候选</button>}
                  <button type="button" onClick={() => void loadPromptBlockDiff()} disabled={state !== 'idle' || !selectedPromptBlockId}>查看 diff</button>
                </div>
                {versionDiff ? <VersionDiffView diff={versionDiff} /> : null}
              </section> : null}

              {agentConfigEditType === 'tool_description' ? <section className="harness-config-fragment">
                <div className="harness-config-fragment__head"><strong>工具描述</strong><span>{toolDescriptionScope} / {productId}{toolDescriptionScope === 'agent' ? ` / ${agentId}` : ''}</span></div>
                <div className="harness-form-grid">
                  <label><span>生效范围</span><select value={toolDescriptionScope} onChange={(event) => setToolDescriptionScope(event.target.value as NonNullable<ToolDescriptionConfig['scope']>)}>
                    <option value="system">system</option>
                    <option value="product">product</option>
                    <option value="agent">agent</option>
                  </select></label>
                  <label><span>工具</span><select value={toolDescriptionToolId} onChange={(event) => setToolDescriptionToolId(event.target.value)}>
                    {toolDescriptionOptions.map((toolId) => <option key={toolId} value={toolId}>{toolId}</option>)}
                  </select></label>
                </div>
                <label className="harness-field harness-field--wide"><span>工具描述</span><textarea value={toolDescriptionContent} onChange={(event) => setToolDescriptionContent(event.target.value)} rows={7} placeholder="基于正式工具 description 编辑覆盖文案…" /></label>
                <div className="harness-form-grid">
                  {toolParameterKeys.map((parameter) => (
                    <label key={parameter} className="harness-field"><span>参数 {parameter}</span><textarea value={toolParameterDescriptions[parameter] ?? ''} onChange={(event) => setToolParameterDescriptions((current) => ({ ...current, [parameter]: event.target.value }))} rows={3} placeholder="覆盖该参数的 describe 文案…" /></label>
                  ))}
                </div>
                <label className="harness-field harness-field--wide"><span>输出描述</span><textarea value={toolOutputDescription} onChange={(event) => setToolOutputDescription(event.target.value)} rows={3} placeholder="描述工具返回结果的结构和语义…" /></label>
                <div className="harness-action-row">
                  <button type="button" onClick={() => void saveToolDescriptionOverride()} disabled={state !== 'idle' || !draftBaseAgentSpec || !agentSpecName.trim() || !toolDescriptionToolId.trim() || !toolDescriptionContent.trim() || !toolDescriptionChanged}>保存工具描述候选</button>
                </div>
              </section> : null}
            </div>
          </div>

        </div>
      </section> : null}

      {activeHarnessTab === 'fixtures' ? <section className="harness-section harness-pipeline-node">
        <NodeHeader index="1" title="评测案例上下文" description="选择一条历史用户消息，恢复这次请求前的工作区快照，再用同一输入评测候选运行配置。" />
        <div className="harness-node-reuse-bar">
          <label><span>载入已有评测案例作为草稿</span><select value={fixtureTemplateId || selectedFixtureId} onChange={(event) => void selectOrCloneEvalFixture(event.target.value)} disabled={state !== 'idle'}>
            <option value="">从历史消息新建...</option>
            {fixtures.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.name ?? fixture.target}</option>)}
          </select></label>
          {fixtureTemplate ? <div className="harness-reuse-draft-note"><strong>已载入草稿来源</strong><small>{fixtureTemplate.name ?? fixtureTemplate.target}</small><button type="button" onClick={resetFixtureTemplateDraft}>清空草稿</button></div> : null}
        </div>
        <div className="harness-config-group">
          <div className="harness-config-group__heading"><span>01</span><strong>从历史消息构造案例</strong><small>一个评测案例只对应一次用户请求。</small></div>
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
            <p className="muted">只能选择一条消息。评测案例会使用这条消息对应运行的输入快照；agent 输出只作为预期结果来源，不会被拼回输入。</p>
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
            <strong>将创建 1 个评测案例</strong>
            <small>会话：{selectedFixtureSession?.title ?? '未选择'}</small>
            <small>输入：{selectedFixtureMessage ? selectedFixtureMessage.content.slice(0, 80) : '未选择消息'}</small>
            <small>历史运行：{selectedFixtureArtifact ? `${selectedFixtureArtifact.status} · ${selectedFixtureArtifact.fileDiff.length} diffs` : '未匹配，将只使用快照'}</small>
            <small>快照：{selectedFixtureSnapshot ? `${selectedFixtureSnapshot.projectId.slice(0, 8)} · ${selectedFixtureSnapshot.fileManifest.length} files` : '未匹配'}</small>
          </div>
          <div className="harness-action-row">
            {fixtureTemplateId ? <button type="button" onClick={() => void saveFixtureFromTemplate()} disabled={state !== 'idle' || !fixtureName.trim()}>保存为新评测案例</button> : null}
            <button type="button" onClick={() => void createFixtureFromChatMessage()} disabled={state !== 'idle' || !fixtureSourceSessionId || !fixtureMessageId}>从这条消息创建评测案例</button>
          </div>
          {fixtureCreateFeedback ? <p className="git-result success">{fixtureCreateFeedback}</p> : null}
        </div>
      </section> : null}

      {activeHarnessTab === 'fixtures' ? <section className="harness-section">
        <details className="harness-secondary-section">
        <summary>底层来源（调试用）</summary>
        <p className="muted">快照是运行前工作区副本；历史运行包含一次输出、文件 diff 和工具事件。日常创建回归案例优先使用上面的历史对话入口。</p>
        <div className="harness-form-grid">
          <label><span>快照</span><select value={selectedSnapshotId} onChange={(event) => setSelectedSnapshotId(event.target.value)}>
            <option value="">选择快照</option>
            {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{formatSnapshot(snapshot)}</option>)}
          </select></label>
          <label><span>历史运行</span><select value={selectedRunArtifactId} onChange={(event) => setSelectedRunArtifactId(event.target.value)}>
            <option value="">选择历史运行</option>
            {runArtifacts.map((artifact) => <option key={artifact.runId} value={artifact.runId}>{artifact.status} · {artifact.fileDiff.length} diffs · {artifact.runId.slice(0, 18)}</option>)}
          </select></label>
        </div>
        <div className="harness-action-row">
          <button type="button" onClick={() => void createFixture()} disabled={state !== 'idle' || !selectedSnapshotId}>从快照创建评测案例</button>
          <button type="button" onClick={() => void createFixtureFromArtifact()} disabled={state !== 'idle' || !selectedRunArtifactId}>从历史运行创建评测案例</button>
        </div>
        {selectedRunArtifactId ? <ArtifactDetails artifact={runArtifacts.find((artifact) => artifact.runId === selectedRunArtifactId)} /> : null}
        </details>
      </section> : null}

      {activeHarnessTab === 'eval' ? <section className="harness-section harness-pipeline-node">
        <NodeHeader index="3" title="评测运行与断言" description="保存评测运行策略和断言配置；真正执行评测放到下一步完成。" />
        <div className="harness-eval-layout">
          <div className="harness-eval-run-compact">
            <div className="harness-config-group__heading"><span>01</span><strong>评测运行配置</strong></div>
            <div className="harness-node-reuse-bar harness-node-reuse-bar--compact">
              <label><span>载入已有运行策略作为草稿</span><select value={evalRunConfigTemplateId || selectedEvalRunConfigId} onChange={(event) => void selectOrCloneEvalRunConfig(event.target.value)} disabled={state !== 'idle'}>
                <option value="">从默认运行策略开始...</option>
                {evalRunConfigs.filter((config) => config.productId === productId).map((config) => <option key={config.id} value={config.id}>{config.name} · v{config.version}</option>)}
              </select></label>
              {evalRunConfigTemplate ? <div className="harness-reuse-draft-note"><strong>已载入草稿来源</strong><small>{evalRunConfigTemplate.name}</small><button type="button" onClick={resetEvalRunConfigTemplateDraft}>清空草稿</button></div> : null}
            </div>
            <div className="harness-eval-run-fields">
              <label><span>运行策略名称</span><input value={evalRunConfigName} onChange={(event) => setEvalRunConfigName(event.target.value)} placeholder="例如：Repro 固定记忆策略" /></label>
              <label><span>运行模式</span><select value={evalRunMode} onChange={(event) => setEvalRunMode(event.target.value as EvalRun['runMode'])}>
                <option value="repro">固定快照复现</option>
                <option value="live">当前环境验证</option>
              </select></label>
              <label><span>记忆策略</span><select value={evalMemoryMode} onChange={(event) => setEvalMemoryMode(event.target.value as EvalRunConfig['memoryMode'])}>
                <option value="fixture">固定案例记忆</option>
                <option value="mocked">Mock 记忆</option>
                <option value="live" disabled={evalRunMode === 'repro'}>Live 记忆</option>
              </select></label>
              <label><span>知识读取策略</span><select value={evalKnowledgeMode} onChange={(event) => setEvalKnowledgeMode(event.target.value as EvalRunConfig['knowledgeMode'])}>
                <option value="fixture">固定案例知识</option>
                <option value="mocked">Mock 知识</option>
                <option value="live" disabled={evalRunMode === 'repro'}>Live 知识</option>
              </select></label>
            </div>
            <div className="harness-action-row">
              <button type="button" onClick={() => void createEvalRunConfigFromForm()} disabled={state !== 'idle'}>保存运行策略</button>
            </div>
          </div>

          <div className="harness-assertion-config-workspace">
            <div className="harness-assertion-config-list">
              <div className="harness-config-group__heading"><span>02</span><strong>断言配置列表</strong></div>
              <div className="harness-assertion-list__header">
                <strong>{selectedAssertionConfig ? selectedAssertionConfig.name : assertionConfigName.trim() || '新断言配置'}</strong>
                <div className="harness-action-row">
                  <button type="button" onClick={() => toggleAllFixtureAssertions(selectedFixtureAssertionRows)} disabled={selectedFixtureAssertionRows.length === 0}>{selectedAssertionIds.length === selectedFixtureAssertionRows.length && selectedFixtureAssertionRows.length > 0 ? '清空选择' : '全选'}</button>
                  <button type="button" onClick={() => void removeSelectedFixtureAssertions()} disabled={state !== 'idle' || selectedAssertionIds.length === 0}>删除选中</button>
                </div>
              </div>
              {selectedFixtureAssertionRows.length > 0 ? selectedFixtureAssertionRows.map((assertion) => (
                <label className="harness-assertion-config-card harness-assertion-config-card--row" key={assertion.id}>
                  <input type="checkbox" checked={selectedAssertionIds.includes(assertion.id)} onChange={() => toggleFixtureAssertion(assertion.id)} />
                  <span>
                    <strong>{assertion.kind}</strong>
                    <small>{assertion.detail}</small>
                  </span>
                </label>
              )) : <div className="harness-config-change-empty"><strong>暂无断言</strong><small>在右侧填写单条断言后点击添加。</small></div>}
            </div>

            <div className="harness-assertion-config-editor">
              <div className="harness-config-group__heading"><span>03</span><strong>断言配置表单</strong></div>
              <div className="harness-node-reuse-bar harness-node-reuse-bar--compact">
                <label><span>载入已有断言配置作为草稿</span><select value={assertionConfigTemplateId || selectedAssertionConfigId} onChange={(event) => void selectOrCloneAssertionConfig(event.target.value)} disabled={state !== 'idle'}>
                  <option value="">从空白断言开始...</option>
                  {assertionConfigOptions.map((config) => <option key={config.id} value={config.id}>{config.name} · v{config.version}</option>)}
                </select></label>
                {assertionConfigTemplate ? <div className="harness-reuse-draft-note"><strong>已载入草稿来源</strong><small>{assertionConfigTemplate.name}</small><button type="button" onClick={resetAssertionConfigTemplateDraft}>清空草稿</button></div> : null}
              </div>
              <label className="harness-field harness-field--wide"><span>断言配置名称</span><input value={assertionConfigName} onChange={(event) => setAssertionConfigName(event.target.value)} placeholder={selectedAssertionConfig ? selectedAssertionConfig.name : '断言配置名称'} /></label>
              <div className="harness-assertion-builder">
                <strong>当前编辑断言</strong>
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
                <button type="button" onClick={() => void addFixtureAssertion()} disabled={state !== 'idle'}>添加断言</button>
                </div>
              </div>
              <details className="harness-advanced-editor">
                <summary>断言 JSON</summary>
                <textarea
                  value={fixtureAssertionsText}
                  onChange={(event) => {
                    fixtureAssertionsDirtyRef.current = true;
                    setFixtureAssertionsText(event.target.value);
                  }}
                  rows={8}
                  spellCheck={false}
                  placeholder="例如 { &quot;files&quot;: { &quot;mustCreateOrModify&quot;: [&quot;02 故事/**&quot;] } }…"
                />
              </details>
              <div className="harness-action-row">
                <button type="button" onClick={() => void (assertionConfigTemplateId ? saveAssertionConfigFromTemplate() : saveAssertionConfigVersionFromEditor())} disabled={state !== 'idle'}>保存断言配置</button>
              </div>
              {evalRunFeedback ? <p className="git-result success" aria-live="polite">{evalRunFeedback}</p> : null}
            </div>
          </div>
        </div>
      </section> : null}

      {activeHarnessTab === 'review' ? <section className="harness-section harness-pipeline-node">
        <NodeHeader index="4" title="运行、审阅与发布" description="提交运行后按顺序查看过程、确认断言、人工评分并发布。" />
        <div className="harness-review-workspace">
          {reviewPipelineStep === 'submit' ? <ReviewSubmitStep selectedAgentSpec={selectedAgentSpec} selectedFixture={selectedFixture} selectedEvalRunConfig={selectedEvalRunConfig} selectedAssertionConfig={selectedAssertionConfig} blockedReason={createEvalRunBlockedReason} state={state} onRun={() => void createEvalRun()} feedback={evalRunFeedback} /> : null}
          {reviewPipelineStep === 'running' && selectedEvalRun ? <ReviewRunningStep run={selectedEvalRun} fixture={fixtures.find((fixture) => fixture.id === selectedEvalRun.fixtureId)} spec={agentSpecs.find((spec) => spec.id === selectedEvalRun.agentSpecId)} /> : null}
          {reviewPipelineStep === 'assertions' && selectedEvalRun ? <ReviewAssertionStep run={selectedEvalRun} onContinue={() => setAssertionResultViewed(true)} /> : null}
          {reviewPipelineStep === 'score' ? selectedRubric ? (
            <ReviewScoreStep
              rubrics={rubrics}
              selectedRubric={selectedRubric}
              selectedEvalRun={selectedEvalRun}
              selectedRubricId={selectedRubricId}
              setSelectedRubricId={setSelectedRubricId}
              reviewTemplateName={reviewTemplateName}
              setReviewTemplateName={setReviewTemplateName}
              createReviewTemplateFromCurrent={() => void createReviewTemplateFromCurrent()}
              reviewScoreStates={reviewScoreStates}
              setReviewScoreStates={setReviewScoreStates}
              reviewScores={reviewScores}
              setReviewScores={setReviewScores}
              reviewSubScores={reviewSubScores}
              setReviewSubScores={setReviewSubScores}
              reviewAnnotationPath={reviewAnnotationPath}
              setReviewAnnotationPath={setReviewAnnotationPath}
              reviewAnnotationLine={reviewAnnotationLine}
              setReviewAnnotationLine={setReviewAnnotationLine}
              reviewAnnotationSeverity={reviewAnnotationSeverity}
              setReviewAnnotationSeverity={setReviewAnnotationSeverity}
              reviewAnnotationComment={reviewAnnotationComment}
              setReviewAnnotationComment={setReviewAnnotationComment}
              reviewAnnotations={reviewAnnotations}
              addReviewAnnotation={addReviewAnnotation}
              removeReviewAnnotation={removeReviewAnnotation}
              reviewNotes={reviewNotes}
              setReviewNotes={setReviewNotes}
              reviewComplete={reviewComplete}
              state={state}
              saveHumanReview={() => void saveHumanReview()}
              skipHumanReview={() => setReviewScoreSkipped(true)}
            />
          ) : <ReviewTemplateCreateStep reviewTemplateName={reviewTemplateName} setReviewTemplateName={setReviewTemplateName} scoreItems={reviewTemplateScoreItems} updateScoreItem={updateReviewTemplateScoreItem} addScoreItem={addReviewTemplateScoreItem} removeScoreItem={removeReviewTemplateScoreItem} state={state} createReviewTemplateFromCurrent={() => void createReviewTemplateFromCurrent()} /> : null}
          {reviewPipelineStep === 'release' ? <ReviewPublishStep releaseGate={releaseGate} selectedAgentSpec={selectedAgentSpec} canRelease={canNormalRelease} state={state} onPublish={() => void activateSelectedSpec()} /> : null}
        </div>
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

function ReleaseGateSnapshot({ gate }: { gate: AgentSpecReleaseGate }): JSX.Element {
  return (
    <div className="harness-gate-result">
      <strong>{gate.passed ? 'gate passed' : 'gate blocked'} · {gate.reason}</strong>
      {gate.checks.map((check) => <small key={check.id}>{check.passed ? 'pass' : 'fail'} · {check.id}{check.message ? ` · ${check.message}` : ''}</small>)}
      {gate.configChanges.map((change) => <small key={change.field}>{change.changed ? 'changed' : 'same'} · {change.field} · {change.message}</small>)}
    </div>
  );
}

function RuntimeConfigFlowTable({ flows, selectedFlowId, onSelect, onOpen, onClone, onArchive, onDelete }: { flows: RuntimeConfigFlow[]; selectedFlowId: string; onSelect: (flow: RuntimeConfigFlow) => void; onOpen: (flow: RuntimeConfigFlow, tab: HarnessTab) => void; onClone: (flow: RuntimeConfigFlow) => void; onArchive: (flow: RuntimeConfigFlow) => void; onDelete: (flow: RuntimeConfigFlow) => void }): JSX.Element {
  if (flows.length === 0) {
    return <div className="harness-empty-state"><strong>没有匹配的运行配置流程</strong><small>调整筛选条件，或先创建一个候选配置。</small></div>;
  }
  return (
    <div className="harness-flow-table" role="table" aria-label="运行配置流程列表">
      <div className="harness-flow-table__head" role="row">
        <span>序号</span><span>名称</span><span>状态</span><span>创建时间</span><span>操作</span>
      </div>
      {flows.slice(0, 24).map((flow, index) => (
        <div key={flow.id} className={`harness-flow-row${flow.id === selectedFlowId ? ' selected' : ''}`} role="row">
          <button type="button" className="harness-flow-row__main" onClick={() => onSelect(flow)}>
            <strong>{index + 1}</strong>
          </button>
          <div className="harness-flow-name"><strong>{flow.name}</strong></div>
          <div className="harness-flow-status"><span>{formatHarnessRecordStatus(flow.status)}</span><small>{formatFlowReleaseState(flow.releaseState)}</small></div>
          <div className="harness-flow-date"><span>{formatDateTime(flow.createdAt)}</span></div>
          <div className="harness-flow-actions">
            <button type="button" onClick={() => onOpen(flow, 'config')}>修改</button>
            <button type="button" onClick={() => onClone(flow)}>克隆</button>
            <button type="button" onClick={() => onOpen(flow, 'eval')}>评测</button>
            <button type="button" onClick={() => onOpen(flow, 'review')}>运行审阅</button>
            {flow.releaseState === 'never_released' && flow.evalRunIds.length === 0 && flow.releaseRecordIds.length === 0 && !flow.candidateSpecId && !flow.activeSpecId ? (
              <button type="button" onClick={() => onDelete(flow)}>删除</button>
            ) : flow.status !== 'archived' ? (
              <button type="button" onClick={() => onArchive(flow)}>归档</button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

type ReviewPipelineStep = 'submit' | 'running' | 'assertions' | 'score' | 'release';

function resolveReviewPipelineStep(run: EvalRun | undefined, assertionViewed: boolean, scoreSkipped: boolean): ReviewPipelineStep {
  if (!run) return 'submit';
  if (run.status === 'pending' || run.status === 'running') return 'running';
  if (!assertionViewed && !run.humanReview) return 'assertions';
  if (!run.humanReview && !scoreSkipped) return 'score';
  return 'release';
}

function ReviewSubmitStep({ selectedAgentSpec, selectedFixture, selectedEvalRunConfig, selectedAssertionConfig, blockedReason, state, onRun, feedback }: { selectedAgentSpec?: AgentSpec; selectedFixture?: HarnessSummary['evalFixtures'][number]; selectedEvalRunConfig?: EvalRunConfig; selectedAssertionConfig?: AssertionConfig; blockedReason: string; state: 'idle' | 'loading' | 'saving'; onRun: () => void; feedback: string }): JSX.Element {
  return (
    <div className="harness-review-step">
      <h3>提交运行</h3>
      <div className="harness-eval-ready">
        <small>候选配置：{selectedAgentSpec ? formatAgentSpec(selectedAgentSpec) : '未选择'}</small>
        <small>评测案例：{selectedFixture ? formatFixture(selectedFixture) : '未选择'}</small>
        <small>运行配置：{selectedEvalRunConfig ? selectedEvalRunConfig.name : '使用步骤三配置'}</small>
        <small>断言配置：{selectedAssertionConfig ? selectedAssertionConfig.name : '未保存'}</small>
        {blockedReason ? <small className="warning">{blockedReason}</small> : null}
      </div>
      <div className="harness-action-row">
        <button type="button" onClick={onRun} disabled={state !== 'idle' || Boolean(blockedReason)}>提交运行</button>
      </div>
      {feedback ? <p className="git-result success" aria-live="polite">{feedback}</p> : null}
    </div>
  );
}

function ReviewRunningStep({ run, fixture, spec }: { run: EvalRun; fixture?: HarnessSummary['evalFixtures'][number]; spec?: AgentSpec }): JSX.Element {
  return (
    <div className="harness-review-step">
      <h3>查看运行过程</h3>
      <EvalRunDetails run={run} fixture={fixture} spec={spec} />
    </div>
  );
}

function ReviewAssertionStep({ run, onContinue }: { run: EvalRun; onContinue: () => void }): JSX.Element {
  const passed = run.assertionResults.filter((result) => result.passed).length;
  const failed = run.assertionResults.filter((result) => !result.passed);
  return (
    <div className="harness-review-step">
      <h3>查看断言结果</h3>
      <div className="harness-gate-result">
        <strong>{passed}/{run.assertionResults.length} 通过</strong>
        {failed.length > 0 ? failed.map((result) => <small key={result.id}>fail · {result.id}{result.message ? ` · ${result.message}` : ''}</small>) : <small>全部断言通过</small>}
      </div>
      <div className="harness-action-row">
        <button type="button" onClick={onContinue}>进入人工审阅评分</button>
      </div>
    </div>
  );
}

function ReviewTemplateCreateStep({
  reviewTemplateName,
  setReviewTemplateName,
  scoreItems,
  updateScoreItem,
  addScoreItem,
  removeScoreItem,
  state,
  createReviewTemplateFromCurrent,
}: {
  reviewTemplateName: string;
  setReviewTemplateName: Dispatch<SetStateAction<string>>;
  scoreItems: ReviewScoreItemDraft[];
  updateScoreItem: (id: string, patch: Partial<ReviewScoreItemDraft>) => void;
  addScoreItem: () => void;
  removeScoreItem: (id: string) => void;
  state: 'idle' | 'loading' | 'saving';
  createReviewTemplateFromCurrent: () => void;
}): JSX.Element {
  return (
    <div className="harness-review-step harness-review-form">
      <h3>人工审阅模板</h3>
      <label className="harness-field"><span>模板名称</span><input value={reviewTemplateName} onChange={(event) => setReviewTemplateName(event.target.value)} placeholder="例如：情景剧质量评分模板" /></label>
      <div className="harness-review-annotations harness-score-editor">
        <div className="harness-score-editor__head">
          <strong>打分表</strong>
          <button type="button" onClick={addScoreItem}>新增打分项</button>
        </div>
        {scoreItems.length > 0 ? <table className="harness-score-table">
          <thead>
            <tr><th>打分项</th><th>权重</th><th>说明</th><th>备注提示</th><th>必填</th><th>操作</th></tr>
          </thead>
          <tbody>
            {scoreItems.map((item) => (
              <tr key={item.id}>
                <td><input value={item.label} onChange={(event) => updateScoreItem(item.id, { label: event.target.value })} placeholder="例如：笑点有效性" /></td>
                <td><input type="number" min="0.1" step="0.1" value={item.weight} onChange={(event) => updateScoreItem(item.id, { weight: Number(event.target.value) })} /></td>
                <td><input value={item.description ?? ''} onChange={(event) => updateScoreItem(item.id, { description: event.target.value })} placeholder="评分关注点" /></td>
                <td><input value={item.notePrompt ?? ''} onChange={(event) => updateScoreItem(item.id, { notePrompt: event.target.value })} placeholder="备注提示" /></td>
                <td><input type="checkbox" checked={item.required ?? true} onChange={(event) => updateScoreItem(item.id, { required: event.target.checked })} /></td>
                <td><button type="button" onClick={() => removeScoreItem(item.id)} disabled={scoreItems.length <= 1}>移除</button></td>
              </tr>
            ))}
          </tbody>
        </table> : <p className="muted">还没有打分项</p>}
      </div>
      <div className="harness-action-row">
        <button type="button" onClick={createReviewTemplateFromCurrent} disabled={state !== 'idle' || !reviewTemplateName.trim() || scoreItems.length === 0}>创建审阅模板</button>
      </div>
    </div>
  );
}

type ReviewScoreStepProps = {
  rubrics: HumanReviewRubric[];
  selectedRubric: HumanReviewRubric;
  selectedEvalRun?: EvalRun;
  selectedRubricId: string;
  setSelectedRubricId: Dispatch<SetStateAction<string>>;
  reviewTemplateName: string;
  setReviewTemplateName: Dispatch<SetStateAction<string>>;
  createReviewTemplateFromCurrent: () => void;
  reviewScoreStates: Record<string, 'scored' | 'not_applicable'>;
  setReviewScoreStates: Dispatch<SetStateAction<Record<string, 'scored' | 'not_applicable'>>>;
  reviewScores: Record<string, number>;
  setReviewScores: Dispatch<SetStateAction<Record<string, number>>>;
  reviewSubScores: Record<string, Record<string, number>>;
  setReviewSubScores: Dispatch<SetStateAction<Record<string, Record<string, number>>>>;
  reviewAnnotationPath: string;
  setReviewAnnotationPath: Dispatch<SetStateAction<string>>;
  reviewAnnotationLine: string;
  setReviewAnnotationLine: Dispatch<SetStateAction<string>>;
  reviewAnnotationSeverity: 'note' | 'issue' | 'blocker';
  setReviewAnnotationSeverity: Dispatch<SetStateAction<'note' | 'issue' | 'blocker'>>;
  reviewAnnotationComment: string;
  setReviewAnnotationComment: Dispatch<SetStateAction<string>>;
  reviewAnnotations: NonNullable<EvalRun['humanReview']>['annotations'];
  addReviewAnnotation: () => void;
  removeReviewAnnotation: (index: number) => void;
  reviewNotes: string;
  setReviewNotes: Dispatch<SetStateAction<string>>;
  reviewComplete: boolean;
  state: 'idle' | 'loading' | 'saving';
  saveHumanReview: () => void;
  skipHumanReview: () => void;
};

function ReviewScoreStep(props: ReviewScoreStepProps): JSX.Element {
  const scoreSummary = summarizeReviewScoreProgress(props.selectedRubric, props.reviewScores, props.reviewScoreStates);
  return (
    <div className="harness-review-step harness-review-form">
      <h3>人工审阅评分</h3>
      <label className="harness-field"><span>审阅模板</span><select value={props.selectedRubricId} onChange={(event) => props.setSelectedRubricId(event.target.value)}>
        {props.rubrics.map((rubric) => <option key={rubric.id} value={rubric.id}>{rubric.name ?? `${rubric.productId}/${rubric.artifactType}`} v{rubric.version} {rubric.status}</option>)}
      </select></label>
      <div className="harness-action-row">
        <input value={props.reviewTemplateName} onChange={(event) => props.setReviewTemplateName(event.target.value)} placeholder="新审阅模板名称" />
        <button type="button" onClick={props.createReviewTemplateFromCurrent} disabled={props.state !== 'idle'}>派生审阅模板</button>
      </div>
      <div className="harness-review-summary-grid">
        <div><small>总分</small><strong>{scoreSummary.averageText}</strong></div>
        <div><small>已检查</small><strong>{scoreSummary.checked}/{props.selectedRubric.humanScores.length}</strong></div>
        <div><small>提交状态</small><strong>{props.reviewComplete ? '可保存' : '待补齐'}</strong></div>
      </div>
      <table className="harness-score-table">
        <thead>
          <tr><th>打分项</th><th>权重</th><th>状态</th><th>分值</th><th>说明</th></tr>
        </thead>
        <tbody>
        {props.selectedRubric.humanScores.map((score) => (
          <tr key={score.id}>
            <td><strong>{score.label}</strong>{score.notePrompt ? <small>{score.notePrompt}</small> : null}</td>
            <td>{score.weight ?? 1}</td>
            <td><select value={props.reviewScoreStates[score.id] ?? ''} onChange={(event) => props.setReviewScoreStates((current) => ({ ...current, [score.id]: event.target.value as 'scored' | 'not_applicable' }))}>
              <option value="">待检查</option>
              <option value="scored">已评分</option>
              <option value="not_applicable">不涉及</option>
            </select></td>
            <td><input type="number" min="1" max="10" step="1" disabled={props.reviewScoreStates[score.id] === 'not_applicable'} value={props.reviewScores[score.id] ?? ''} onChange={(event) => props.setReviewScores((current) => ({ ...current, [score.id]: Number(event.target.value) }))} /></td>
            <td>{score.description ? <small>{score.description}</small> : null}{score.anchors ? <small>{formatAnchors(score.anchors)}</small> : null}</td>
          </tr>
        ))}
        </tbody>
      </table>
      <div className="harness-review-annotations">
        <strong>文件行备注</strong>
        <div className="harness-form-row compact">
          <input value={props.reviewAnnotationPath} onChange={(event) => props.setReviewAnnotationPath(event.target.value)} placeholder="文件路径" />
          <input value={props.reviewAnnotationLine} onChange={(event) => props.setReviewAnnotationLine(event.target.value)} placeholder="行号" />
          <select value={props.reviewAnnotationSeverity} onChange={(event) => props.setReviewAnnotationSeverity(event.target.value as typeof props.reviewAnnotationSeverity)}>
            <option value="note">note</option>
            <option value="issue">issue</option>
            <option value="blocker">blocker</option>
          </select>
          <button type="button" onClick={props.addReviewAnnotation}>添加备注</button>
        </div>
        <input value={props.reviewAnnotationComment} onChange={(event) => props.setReviewAnnotationComment(event.target.value)} placeholder="备注内容" />
        {(props.reviewAnnotations ?? []).length > 0 ? (
          <ul className="harness-annotation-list">
            {(props.reviewAnnotations ?? []).map((annotation, index) => (
              <li key={`${annotation.path}:${annotation.line ?? 'file'}:${index}`}>
                <span>{annotation.severity}</span>
                <strong>{annotation.line ? `${annotation.path}:${annotation.line}` : annotation.path}</strong>
                <small>{annotation.assertionId ? `${annotation.assertionId} · ` : ''}{annotation.comment}</small>
                <button type="button" onClick={() => props.removeReviewAnnotation(index)}>移除</button>
              </li>
            ))}
          </ul>
        ) : <p className="muted">还没有行级备注</p>}
      </div>
      <label className="harness-field"><span>评分备注</span><input value={props.reviewNotes} onChange={(event) => props.setReviewNotes(event.target.value)} placeholder="notes" /></label>
      <div className="harness-action-row">
        <button type="button" onClick={props.saveHumanReview} disabled={props.state !== 'idle' || !props.selectedEvalRun || !props.reviewComplete}>保存评分</button>
        <button type="button" onClick={props.skipHumanReview} disabled={props.state !== 'idle' || !props.selectedEvalRun}>跳过评分</button>
      </div>
    </div>
  );
}

function ReviewPublishStep({ releaseGate, selectedAgentSpec, canRelease, state, onPublish }: { releaseGate: AgentSpecReleaseGate | null; selectedAgentSpec?: AgentSpec; canRelease: boolean; state: 'idle' | 'loading' | 'saving'; onPublish: () => void }): JSX.Element {
  return (
    <div className="harness-review-step">
      <h3>发布</h3>
      <div className="harness-release-decision">
        <strong>{selectedAgentSpec ? formatAgentSpec(selectedAgentSpec) : '未选择候选配置'}</strong>
        <small>{releaseGate ? `发布检查：${releaseGate.passed ? '通过' : '未通过'} · ${releaseGate.reason}` : '断言通过后可发布；人工评分只作为参考依据。'}</small>
      </div>
      <div className="harness-action-row">
        <button type="button" onClick={onPublish} disabled={state !== 'idle' || !canRelease}>发布</button>
      </div>
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

function filterRuntimeConfigFlowsForPanel(
  flows: RuntimeConfigFlow[],
  filter: { status: FlowStatusFilter; releaseState: FlowReleaseFilter; tag: string; query: string; sort: FlowSort },
): RuntimeConfigFlow[] {
  const query = filter.query.trim().toLowerCase();
  const filtered = flows
    .filter((flow) => filter.status === 'all' || flow.status === filter.status)
    .filter((flow) => filter.releaseState === 'all' || flow.releaseState === filter.releaseState)
    .filter((flow) => filter.tag === 'all' || flow.tags.includes(filter.tag))
    .filter((flow) => !query || [flow.id, flow.name, ...flow.tags].filter(Boolean).join(' ').toLowerCase().includes(query));
  return filtered.sort((left, right) => {
    if (filter.sort === 'createdAt') return right.createdAt.localeCompare(left.createdAt);
    if (filter.sort === 'gateStatus') return panelGateValue(right.gateStatus) - panelGateValue(left.gateStatus) || right.updatedAt.localeCompare(left.updatedAt);
    if (filter.sort === 'evalCompletion') return panelEvalRatio(right) - panelEvalRatio(left) || right.updatedAt.localeCompare(left.updatedAt);
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function isUserRuntimeConfigFlow(flow: RuntimeConfigFlow): boolean {
  return flow.id.startsWith('runtime_config_flow_');
}

function formatHarnessRecordStatus(status: RuntimeConfigFlow['status']): string {
  if (status === 'draft') return '草稿';
  if (status === 'candidate') return '候选';
  if (status === 'active') return '已发布';
  return '已归档';
}

function formatFlowReleaseState(state: RuntimeConfigFlow['releaseState']): string {
  if (state === 'never_released') return '未发布';
  if (state === 'released') return '已发布';
  if (state === 'rolled_back') return '已回滚';
  return '已归档';
}

function formatRuntimeConfigChangeArea(area: RuntimeConfigFlow['changes'][number]['area']): string {
  if (area === 'agent_prompt') return 'Agent 提示词';
  if (area === 'behavior_rule') return '行为规则';
  if (area === 'tool_description') return '工具描述';
  if (area === 'policy') return '运行策略';
  if (area === 'eval_fixture') return '评测案例';
  if (area === 'eval_run_config') return '评测配置';
  if (area === 'assertion_config') return '断言配置';
  return '审阅模板';
}

function mergeRuntimeConfigChanges(
  existing: RuntimeConfigFlow['changes'],
  incoming: RuntimeConfigFlow['changes'],
): RuntimeConfigFlow['changes'] {
  const merged = [...existing];
  for (const change of incoming) {
    const key = runtimeConfigChangeKey(change);
    const index = merged.findIndex((item) => runtimeConfigChangeKey(item) === key);
    if (index >= 0) {
      merged[index] = change;
    } else {
      merged.push(change);
    }
  }
  return merged;
}

function runtimeConfigChangeKey(change: RuntimeConfigFlow['changes'][number]): string {
  if (change.area === 'agent_prompt') return `${change.area}|${change.agentId ?? change.targetId ?? ''}`;
  if (change.area === 'behavior_rule') return `${change.area}|${normalizeVersionedChangeTarget(change.targetId)}`;
  if (change.area === 'tool_description') return `${change.area}|${change.targetId ?? ''}`;
  return `${change.area}|${change.targetId ?? change.agentId ?? ''}`;
}

function normalizeVersionedChangeTarget(targetId: string | undefined): string {
  if (!targetId) return '';
  return parseVersionRef(targetId).id;
}

function panelGateValue(status: RuntimeConfigFlow['gateStatus']): number {
  if (status === 'passed') return 2;
  if (status === 'blocked') return 1;
  return 0;
}

function panelEvalRatio(flow: RuntimeConfigFlow): number {
  if (flow.evalCompletion.total === 0) return 0;
  return (flow.evalCompletion.passed + flow.evalCompletion.reviewed) / (flow.evalCompletion.total * 2);
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

function promptBlockFromBehaviorRule(rule: BehaviorRuleConfig): PromptBlock {
  const scope: PromptBlock['scope'] = rule.scope === 'system'
    ? 'system'
    : rule.scope === 'agent'
      ? 'specialist'
      : 'quality';
  return {
    id: rule.id,
    productId: rule.productId,
    title: rule.title,
    version: rule.version,
    status: rule.status,
    scope,
    content: rule.content,
    contentHash: rule.contentHash,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function isBehaviorRuleRelevantToAgent(rule: BehaviorRuleConfig, agentId: string, selectedRef: string): boolean {
  if (selectedRef && parseVersionRef(selectedRef).id === rule.id) return true;
  return rule.scope !== 'agent' || rule.agentId === agentId;
}

function LayerConfigPreview({ config, currentAgentId }: { config: AgentLayerConfig; currentAgentId?: string }): JSX.Element {
  const visibleSpecialists = currentAgentId
    ? config.specialists.filter((agent) => agent.agentId === currentAgentId)
    : config.specialists;
  const hiddenCount = currentAgentId ? config.specialists.length - visibleSpecialists.length : 0;
  const toolOverrides = config.toolDescriptionOverrides ?? [];
  return (
    <div className="harness-layer-preview">
      <strong>Agent 分层</strong>
      <small>system: {config.systemAgent.agentId} · tools {(config.systemAgent.allowedTools ?? []).join(', ') || 'default'} · prompts {(config.systemAgent.promptBlockRefs ?? []).join(', ') || 'none'}</small>
      {toolOverrides.length > 0 ? <small>tool descriptions: {toolOverrides.map((override) => override.toolId).join(', ')}</small> : null}
      {visibleSpecialists.map((agent) => (
        <small key={agent.agentId}>{agent.defaultEnabled ? 'enabled' : 'disabled'} · {agent.agentId} · skill {agent.skillRef ?? 'none'} · tools {(agent.allowedTools ?? []).join(', ') || 'default'} · prompts {(agent.promptBlockRefs ?? []).join(', ') || 'none'}</small>
      ))}
      {hiddenCount > 0 ? <small>另有 {hiddenCount} 个 specialist 已收起</small> : null}
    </div>
  );
}

function getLayerToolDescriptionOverrides(layerConfig: AgentLayerConfig | undefined): ToolDescriptionConfig[] {
  return layerConfig?.toolDescriptionOverrides ?? [];
}

function resolveToolDescriptionBaseline(toolId: string, overrides: ToolDescriptionConfig[]): ToolDescriptionConfig {
  const defaultSpec = DEFAULT_TOOL_DESCRIPTION_SPECS[toolId as keyof typeof DEFAULT_TOOL_DESCRIPTION_SPECS];
  const override = overrides.find((item) => item.toolId === toolId);
  return normalizeToolDescriptionOverride({
    toolId,
    description: override?.description ?? defaultSpec?.description ?? '',
    parameterDescriptions: override?.parameterDescriptions ?? defaultSpec?.parameters ?? {},
    outputDescription: override?.outputDescription ?? defaultSpec?.output ?? '',
  });
}

function normalizeToolDescriptionOverride(override: ToolDescriptionConfig): ToolDescriptionConfig {
  const parameterDescriptions = Object.fromEntries(
    Object.entries(override.parameterDescriptions ?? {})
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => key && value),
  );
  return {
    toolId: override.toolId.trim(),
    description: override.description.trim(),
    parameterDescriptions,
    outputDescription: override.outputDescription?.trim() || undefined,
  };
}

function isSameToolDescription(left: ToolDescriptionConfig, right: ToolDescriptionConfig): boolean {
  const normalizedLeft = normalizeToolDescriptionOverride(left);
  const normalizedRight = normalizeToolDescriptionOverride(right);
  return normalizedLeft.toolId === normalizedRight.toolId
    && normalizedLeft.description === normalizedRight.description
    && (normalizedLeft.outputDescription ?? '') === (normalizedRight.outputDescription ?? '')
    && stableToolDescriptionParams(normalizedLeft.parameterDescriptions) === stableToolDescriptionParams(normalizedRight.parameterDescriptions);
}

function stableToolDescriptionParams(parameters: Record<string, string> | undefined): string {
  return JSON.stringify(Object.fromEntries(Object.entries(parameters ?? {}).sort(([left], [right]) => left.localeCompare(right))));
}

function buildEvalRunConfigInput(input: CreateEvalRunConfigInput): CreateEvalRunConfigInput {
  if (input.runMode === 'repro' && (input.memoryMode === 'live' || input.knowledgeMode === 'live')) {
    return {
      ...input,
      memoryMode: input.memoryMode === 'live' ? 'fixture' : input.memoryMode,
      knowledgeMode: input.knowledgeMode === 'live' ? 'fixture' : input.knowledgeMode,
    };
  }
  if (input.runMode === 'live' && input.memoryMode !== 'live' && input.knowledgeMode !== 'live') {
    return { ...input, memoryMode: 'live' };
  }
  return input;
}

function updateLayerToolDescriptionOverride(
  layerConfig: AgentLayerConfig,
  override: ToolDescriptionConfig,
): Omit<AgentLayerConfig, 'id' | 'version' | 'createdAt' | 'updatedAt'> {
  const replaceOverride = (overrides: ToolDescriptionConfig[] | undefined): ToolDescriptionConfig[] => [
    ...(overrides ?? []).filter((item) => item.toolId !== override.toolId),
    override,
  ];
  return {
    ...stripLayerIdentity(layerConfig),
    status: 'candidate',
    toolDescriptionOverrides: replaceOverride(layerConfig.toolDescriptionOverrides),
  };
}

function updateLayerToolDescriptionRef(
  layerConfig: AgentLayerConfig,
  ref: string,
): Omit<AgentLayerConfig, 'id' | 'version' | 'createdAt' | 'updatedAt'> {
  return {
    ...stripLayerIdentity(layerConfig),
    status: 'candidate',
    toolDescriptionRefs: replaceVersionedRef(layerConfig.toolDescriptionRefs ?? [], ref),
  };
}

function stripLayerIdentity(layerConfig: AgentLayerConfig): Omit<AgentLayerConfig, 'id' | 'version' | 'createdAt' | 'updatedAt'> {
  const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = layerConfig;
  return input;
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

function latestRecordsById<T extends { id: string; version: number }>(records: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    const current = byId.get(record.id);
    if (!current || record.version > current.version) byId.set(record.id, record);
  }
  return [...byId.values()].sort((left, right) => right.version - left.version);
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
        <small>运行配置：{artifact.resolvedAgentConfig?.agentSpec?.id?.slice(0, 18) ?? artifact.resolvedAgentConfig?.layerConfig?.id?.slice(0, 18) ?? 'none'}</small>
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
      <div className="harness-tool-policy-header"><span>tool</span><span>input</span><span>output</span><span>案例保留策略</span></div>
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
        <small>固定记忆：{memoryFixture.length}</small>
        <small>固定知识：{knowledgeFixture.length}</small>
        <small>来源：{fixture.sourceRunId ? `运行 ${fixture.sourceRunId.slice(0, 12)}` : fixture.sourceSnapshotId ? `快照 ${fixture.sourceSnapshotId.slice(0, 12)}` : '手动'}</small>
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
          <h3>评测运行详情</h3>
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
  return value === 'config' || value === 'fixtures' || value === 'eval' || value === 'review';
}

function buildReviewScores(rubric: HumanReviewRubric, scores: Record<string, number>, states: Record<string, 'scored' | 'not_applicable'>): Record<string, number> {
  return Object.fromEntries(rubric.humanScores
    .filter((score) => states[score.id] !== 'not_applicable')
    .map((score) => [score.id, scores[score.id]]));
}

function normalizeReviewTemplateScores(items: ReviewScoreItemDraft[]): ReviewScoreItemDraft[] {
  const seen = new Set<string>();
  return items.flatMap((item, index) => {
    const label = item.label.trim();
    if (!label) return [];
    const id = (item.id.trim() || slugifyReviewScoreId(label, index + 1)).replace(/[^a-zA-Z0-9_-]+/g, '_');
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight <= 0) return [];
    if (seen.has(id)) return [];
    seen.add(id);
    return [{
      ...item,
      id,
      label,
      weight,
      description: item.description?.trim() || undefined,
      notePrompt: item.notePrompt?.trim() || undefined,
    }];
  });
}

function reviewTemplateScoreItemsFromRubric(rubric: HumanReviewRubric): ReviewScoreItemDraft[] {
  return rubric.humanScores.map((score) => ({
    id: score.id,
    label: score.label,
    weight: score.weight ?? 1,
    description: score.description,
    notePrompt: score.notePrompt,
    required: score.required ?? true,
  }));
}

function slugifyReviewScoreId(label: string, index: number): string {
  const ascii = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return ascii || `score_${index}`;
}

function buildReviewScoreStates(rubric: HumanReviewRubric, states: Record<string, 'scored' | 'not_applicable'>): Record<string, 'scored' | 'not_applicable'> {
  return Object.fromEntries(rubric.humanScores.map((score) => [score.id, states[score.id] ?? 'not_applicable']));
}

function buildReviewSubScores(rubric: HumanReviewRubric, subScores: Record<string, Record<string, number>>): Record<string, Record<string, number>> | undefined {
  const entries = rubric.humanScores
    .filter((score) => score.subScores && score.subScores.length > 0)
    .map((score) => [
      score.id,
      Object.fromEntries((score.subScores ?? []).map((subScore) => [subScore, subScores[score.id]?.[subScore] ?? 1])),
    ] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function summarizeReviewScoreProgress(rubric: HumanReviewRubric, scores: Record<string, number>, states: Record<string, 'scored' | 'not_applicable'>): { checked: number; averageText: string } {
  let checked = 0;
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const score of rubric.humanScores) {
    const state = states[score.id];
    if (state !== 'scored' && state !== 'not_applicable') continue;
    checked += 1;
    if (state === 'not_applicable') continue;
    const value = scores[score.id];
    if (!Number.isFinite(value)) continue;
    const weight = score.weight ?? 1;
    weightedTotal += value * weight;
    weightTotal += weight;
  }
  return {
    checked,
    averageText: weightTotal > 0 ? `${(weightedTotal / weightTotal).toFixed(1)} / 10` : 'n/a',
  };
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

function assertionDefinitionsFromCompiled(assertions: Record<string, unknown>): AssertionConfig['assertions'] {
  return buildAssertionRows(assertions).map((row, index) => ({
    id: `assertion_${index + 1}_${row.id.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48)}`,
    kind: assertionKindFromRow(row),
    enabled: true,
    severity: 'blocking',
    description: row.detail,
    config: assertionConfigFromRow(row, assertions),
  }));
}

function assertionKindFromRow(row: AssertionRow): AssertionConfig['assertions'][number]['kind'] {
  const [group, key] = parseAssertionId(row.id);
  if (group === 'files') return 'file_change';
  if (group === 'markdown') return 'markdown_section';
  if (group === 'toolEvents') return 'tool_event';
  if (group === 'manifest') return 'manifest_compliance';
  if (group === 'diff') {
    if (key === 'allowedPaths' || key === 'allowDeletes' || key === 'allowedChanges') return 'path_constraint';
    if (key === 'allowedMarkdownSections') return 'markdown_section';
    return 'diff_limit';
  }
  return 'file_change';
}

function assertionConfigFromRow(row: AssertionRow, assertions: Record<string, unknown>): Record<string, unknown> {
  const [kind, ...rest] = parseAssertionId(row.id);
  if (kind === 'files') {
    const key = rest[0] || 'mustCreateOrModify';
    const value = rest.slice(1).join(':');
    return { [key]: value ? [value] : [] };
  }
  if (kind === 'markdown') {
    return { path: rest[1] ?? '', requiredHeadings: rest[0] === 'requiredHeadings' ? [rest.slice(2).join(':')] : undefined };
  }
  if (kind === 'toolEvents') return { [rest[0] || 'mustCall']: rest.slice(1) };
  if (kind === 'diff') {
    const diff = isPlainRecord(assertions.diff) ? assertions.diff : {};
    const key = rest[0] || '';
    if (key === 'allowedPaths') return { allowedPaths: stringArray(diff.allowedPaths) };
    if (key === 'allowDeletes') return { allowDeletes: diff.allowDeletes === false ? false : true };
    if (key === 'allowedChanges') {
      const allowedChanges = isPlainRecord(diff.allowedChanges) ? diff.allowedChanges : {};
      return { allowedPaths: Object.values(allowedChanges).flatMap((value) => stringArray(value)) };
    }
    if (key === 'allowedMarkdownSections') {
      return { path: rest[1] ?? '', allowedSections: [rest.slice(2).join(':')], forbidSectionDelete: true };
    }
    return typeof diff[key] === 'number' ? { [key]: diff[key] } : {};
  }
  if (kind === 'manifest') return { artifactType: rest[1] ?? 'artifact', path: rest[2] };
  return {};
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
