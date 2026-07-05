export type Project = {
  id: string;
  productId?: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  temporary?: boolean;
  git?: ProjectGitConfig;
};

export type WorkspaceEntry = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  updatedAt?: string;
  mimeType?: string;
};

export type WorkspaceFile = {
  path: string;
  content: string;
};

export type ReferencedFile = {
  path: string;
  label: string;
};

export type ReferencedChatSnippet = {
  id: string;
  messageId: string;
  role: 'user' | 'assistant';
  label: string;
  text: string;
  createdAt: string;
};

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export type RunSource = 'web' | 'schedule' | 'qq' | 'wechat' | 'eval';

export type AgentRun = {
  id: string;
  projectId: string;
  sessionId?: string;
  inputSnapshotId?: string;
  source: RunSource;
  prompt: string;
  model?: string;
  imageGeneration?: RunImageGenerationOptions;
  referencedFiles: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  attachments?: ChatMessageAttachment[];
  events?: RunEvent[];
  referencedFiles: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  streamEvents: StreamEvent[];
  status?: 'idle' | 'running' | 'success' | 'error';
};

export type ChatMessageAttachment = {
  id: string;
  kind: 'reference-image' | 'generated-image';
  name: string;
  path: string;
  projectId: string;
  mimeType: string;
  prompt?: string;
  model?: string;
  aspectRatio?: GeminiImageAspectRatio;
  thinkingLevel?: GeminiImageThinkingLevel;
  createdAt: string;
};

export type ChatSessionKind = 'assistant' | 'image';

export type ChatSessionModelConfig = {
  chatModel?: string;
  imageModel?: string;
  imageAspectRatio?: GeminiImageAspectRatio;
  imageThinkingLevel?: GeminiImageThinkingLevel;
  imageCount?: number;
};

export type ChatSession = {
  id: string;
  projectId: string;
  kind?: ChatSessionKind;
  modelConfig?: ChatSessionModelConfig;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  messages: ChatMessage[];
};

export type ScheduledTaskStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'error';

export type ScheduledTaskFrequency = 'once' | 'minutes' | 'hourly' | 'daily' | 'weekly';

export type ScheduledTaskAction = {
  type: 'wechat_message';
  message: string;
};

export type ScheduledTask = {
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  sourcePrompt: string;
  status: ScheduledTaskStatus;
  schedule: {
    frequency: ScheduledTaskFrequency;
    intervalMinutes?: number;
    timeOfDay?: string;
    dayOfWeek?: number;
    timezone: string;
  };
  action: ScheduledTaskAction;
  nextRunAt: string;
  lastRunAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type GeminiImageModel = 'gemini-3.1-flash-image-preview' | 'gemini-3-pro-image-preview';

export type GeminiImageAspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9';

export type GeminiImageThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type ImageGenerationReferenceImage = {
  name: string;
  mimeType: string;
  contentBase64: string;
};

export type ImageGenerationRequest = {
  sessionId?: string;
  productId?: string;
  prompt: string;
  model?: string;
  aspectRatio: GeminiImageAspectRatio;
  thinkingLevel?: GeminiImageThinkingLevel;
  count: number;
  referenceImages?: ImageGenerationReferenceImage[];
};

export type RunImageGenerationOptions = {
  model?: string;
};

export type ImageGenerationResponse = {
  session: ChatSession;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
};

export type AigcHubModelMetadata = {
  id: string;
  label: string;
  provider?: string;
  capabilities: string[];
};

export type AigcHubModelListResponse = {
  configured: boolean;
  models: AigcHubModelMetadata[];
  error?: string;
};

export type RunEvent =
  | { type: 'run.start'; runId: string }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'text.message'; runId: string; text: string }
  | { type: 'agent.step.start'; runId: string; agentId: string; phase: string; iteration: number; maxIterations?: number }
  | {
    type: 'agent.step.end';
    runId: string;
    agentId: string;
    phase: string;
    iteration: number;
    maxIterations?: number;
    status: Exclude<AgentTraceStatus, 'running' | 'stopped'>;
  }
  | { type: 'agent.review.reject'; runId: string; targetAgentId: string; iteration: number; maxIterations?: number; reasons: string[] }
  | { type: 'agent.workflow.end'; runId: string; status: 'passed' | 'stopped'; outputPath?: string }
  | { type: 'memory.read'; runId: string; scope: 'workspace'; bytes: number }
  | { type: 'memory.write'; runId: string; scope: 'workspace'; authority: MemoryRecord['authority']; memoryType: MemoryRecord['memoryType']; updateMode?: MemoryRecord['updateMode']; content: string; tombstonedMemoryId?: string; mocked?: boolean; persisted?: boolean }
  | { type: 'memory.recall'; runId: string; query: string; matches: MemoryRecord[]; topK?: number; scope?: MemoryRecord['scope']; source?: 'live' | 'fixture' }
  | { type: 'knowledge.retrieve'; runId: string; query: string; matches: KnowledgeBaseEntry[]; tags?: string[]; topK?: number; source?: 'live' | 'fixture'; rightsRiskMax?: KnowledgeBaseEntry['rightsRisk'] }
  | { type: 'tool.use'; runId: string; name: string; input?: unknown }
  | { type: 'tool.input'; runId: string; name: string; inputText: string }
  | { type: 'tool.result'; runId: string; name: string; output?: unknown }
  | { type: 'file.changed'; runId: string; path: string; change: 'created' | 'modified' | 'deleted' }
  | { type: 'run.end'; runId: string; status: Exclude<RunStatus, 'pending' | 'running'>; error?: string };

export type StreamRunStatus = 'success' | 'error' | 'cancelled';

export type StreamToolStatus = 'running' | 'succeeded' | 'failed';

export type AgentTraceStatus = 'running' | 'passed' | 'rejected' | 'failed' | 'stopped';

export type AgentTraceEvent =
  | { type: 'agent.step.start'; runId: string; emittedAt: string; agentId: string; phase: string; iteration: number; maxIterations?: number }
  | {
    type: 'agent.step.end';
    runId: string;
    emittedAt: string;
    agentId: string;
    phase: string;
    iteration: number;
    maxIterations?: number;
    status: Exclude<AgentTraceStatus, 'running' | 'stopped'>;
  }
  | { type: 'agent.review.reject'; runId: string; emittedAt: string; targetAgentId: string; iteration: number; maxIterations?: number; reasons: string[] }
  | { type: 'agent.workflow.end'; runId: string; emittedAt: string; status: 'passed' | 'stopped'; outputPath?: string };

export type StreamEvent =
  | { type: 'run.start'; runId: string; emittedAt: string }
  | { type: 'thread.started'; runId: string; emittedAt: string; threadId: string }
  | { type: 'text.delta'; runId: string; emittedAt: string; delta: string; sequence: number }
  | { type: 'thinking.delta'; runId: string; emittedAt: string; delta: string; sequence: number }
  | { type: 'thinking.end'; runId: string; emittedAt: string; text: string; sequence: number }
  | { type: 'tool_use.start'; runId: string; emittedAt: string; toolCallId: string; toolName: string }
  | {
    type: 'tool_use.delta';
    runId: string;
    emittedAt: string;
    toolCallId: string;
    stream: 'input' | 'output';
    delta: string;
    sequence: number;
  }
  | {
    type: 'tool_use.end';
    runId: string;
    emittedAt: string;
    toolCallId: string;
    status: StreamToolStatus;
    outputText: string | null;
    errorMessage: string | null;
  }
  | { type: 'file.changed'; runId: string; emittedAt: string; path: string; change: 'created' | 'modified' | 'deleted' }
  | { type: 'memory.read'; runId: string; emittedAt: string; scope: 'workspace'; bytes: number }
  | { type: 'memory.write'; runId: string; emittedAt: string; scope: 'workspace'; authority: MemoryRecord['authority']; memoryType: MemoryRecord['memoryType']; updateMode?: MemoryRecord['updateMode']; content: string; tombstonedMemoryId?: string; mocked?: boolean; persisted?: boolean }
  | { type: 'memory.recall'; runId: string; emittedAt: string; query: string; matches: MemoryRecord[]; topK?: number; scope?: MemoryRecord['scope']; source?: 'live' | 'fixture' }
  | { type: 'knowledge.retrieve'; runId: string; emittedAt: string; query: string; matches: KnowledgeBaseEntry[]; tags?: string[]; topK?: number; source?: 'live' | 'fixture'; rightsRiskMax?: KnowledgeBaseEntry['rightsRisk'] }
  | { type: 'image.generated'; runId: string; emittedAt: string; attachment: ChatMessageAttachment }
  | { type: 'wechat.file_sent'; runId: string; emittedAt: string; path: string; mimeType: string }
  | { type: 'choice.request'; runId: string; emittedAt: string; question: string; options: [string, ...string[]] }
  | { type: 'run.end'; runId: string; emittedAt: string; status: StreamRunStatus; errorMessage: string | null }
  | AgentTraceEvent;

export type TheaterSkill = {
  slug: string;
  title: string;
  description: string;
  prompt: string;
  enabled: boolean;
  scope: 'system' | 'user';
  createdAt: string;
  updatedAt: string;
  source?: 'plaza' | 'agent-config';
  mutable?: boolean;
  location?: string;
};

export type BehaviorRule = {
  id: string;
  label: string;
  content: string;
  enabled: boolean;
  builtIn: boolean;
};

export type WechatStatus = {
  state: 'not_connected' | 'pending' | 'connected';
  connection: {
    displayName: string;
    externalUserId: string;
    connectedAt: string;
  } | null;
  setupSession: WechatSetupSession | null;
  ilink: {
    configured: boolean;
    baseUrl?: string | null;
    accountId?: string | null;
    routeTag?: string | null;
    allowFrom?: string[];
    pollerRunning?: boolean;
    lastPollAt?: string | null;
    pollError?: string | null;
  };
};

export type WechatSetupSession = {
  sessionId: string;
  status: 'qr_ready' | 'connected' | 'cancelled';
  qrUrl: string;
  expiresAt: string;
};

export type ProjectGitConfig = {
  remoteUrl: string;
  accessToken?: string;
  lastSyncAt?: string;
  lastCommitHash?: string;
  branch?: string;
};

export type GlobalGitConfig = {
  accessToken: string;
  defaultBranch?: string;
};

export type GitSyncResult = {
  success: boolean;
  commitHash?: string;
  filesChanged: number;
  message: string;
};

export type GitLogEntry = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
};

export type ProjectGitStatus = {
  initialized: boolean;
  hasRemote: boolean;
  changedFiles: number;
  lastSyncAt?: string;
  lastCommitHash?: string;
  branch?: string;
};

export type HarnessRecordStatus = 'draft' | 'candidate' | 'active' | 'archived';

export type AgentLayerConfig = {
  id: string;
  productId: string;
  version: number;
  status: HarnessRecordStatus;
  systemAgent: {
    agentId: string;
    promptBlockRefs: string[];
    allowedTools: string[];
    instructionOverride?: string;
  };
  specialists: Array<{
    agentId: string;
    skillRef?: string;
    promptBlockRefs: string[];
    defaultEnabled: boolean;
    allowedTools?: string[];
    instructionOverride?: string;
  }>;
  memoryPolicyRef?: string;
  retrievalPolicyRef?: string;
  toolPolicyRef?: string;
  modelPolicyRef?: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryPolicy = {
  id: string;
  productId: string;
  version: number;
  status: HarnessRecordStatus;
  namespaces: {
    session: string[];
    workspace: string[];
    global: string[];
  };
  recallOrder: Array<'session' | 'workspace' | 'global'>;
  writeRules: Record<string, 'allow' | 'allow_with_evidence' | 'confirm_for_long_term' | 'deny'>;
  conflictPolicy: 'formal_file_wins' | 'newest_wins' | 'manual_review';
  tombstoneRequired: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryRecord = {
  id: string;
  namespace: string[];
  scope: 'session' | 'workspace' | 'global';
  memoryType: 'profile' | 'knowledge' | 'event' | 'decision' | 'constraint' | 'summary';
  authority: 'user_explicit' | 'file_derived' | 'agent_inferred' | 'workflow_event';
  updateMode: 'upsert' | 'append' | 'summarize' | 'tombstone';
  key?: string;
  content: string;
  evidenceRefs: Array<
    | { type: 'file'; path: string; hash?: string }
    | { type: 'message'; sessionId: string; messageId: string }
    | { type: 'run'; runId: string }
  >;
  confidence?: number;
  createdByAgent?: string;
  createdAt: string;
  updatedAt: string;
  tombstonedAt?: string | null;
};

export type KnowledgeBaseEntry = {
  id: string;
  title: string;
  path: string;
  type: 'mechanism' | 'viewpoint' | 'joke_pattern' | 'source_note' | 'inbox';
  tags: string[];
  rightsRisk: 'low' | 'medium' | 'high';
  source?: string;
  contentHash?: string;
  updatedAt: string;
};

export type RetrievalPolicy = {
  id: string;
  productId: string;
  version: number;
  status: HarnessRecordStatus;
  enabledTypes: KnowledgeBaseEntry['type'][];
  defaultTopK: number;
  rightsRiskMax: KnowledgeBaseEntry['rightsRisk'];
  writeFlow: 'inbox_then_confirm' | 'direct_confirmed_only';
  forbiddenUse: string[];
  mockable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PromptBlock = {
  id: string;
  productId: string;
  version: number;
  status: HarnessRecordStatus;
  title: string;
  scope: 'system' | 'specialist' | 'reviewer' | 'tool' | 'quality' | 'other';
  content: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
};

export type HarnessTextDiffLine = {
  lineNumber?: number;
  previousLineNumber?: number;
  nextLineNumber?: number;
  change: 'same' | 'added' | 'removed';
  text: string;
};

export type HarnessVersionDiff = {
  recordType: 'prompt_block' | 'skill_snapshot';
  id: string;
  previousVersion: number;
  nextVersion: number;
  previousHash: string;
  nextHash: string;
  changed: boolean;
  lines: HarnessTextDiffLine[];
};

export type SkillSnapshot = {
  id: string;
  productId: string;
  skillId: string;
  version: number;
  status: HarnessRecordStatus;
  source: 'agent_config' | 'product_profile' | 'imported' | 'manual';
  content: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentSpec = {
  id: string;
  name?: string;
  productId: string;
  agentId: string;
  version: number;
  status: HarnessRecordStatus;
  layerConfigRef?: string;
  promptBlockRefs: string[];
  skillRefs: Array<{ skillId: string; version?: number; contentHash?: string }>;
  memoryPolicyRef?: string;
  retrievalPolicyRef?: string;
  toolPolicyRef?: string;
  modelPolicyRef?: string;
  changelog?: string;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string | null;
};

export type WorkspaceManifestArtifact = {
  canonicalPath: string;
  requiredSections: string[];
};

export type WorkspaceManifest = {
  id: string;
  productId: string;
  templateVersion: number;
  status: HarnessRecordStatus;
  requiredDirectories: string[];
  artifactTypes: Record<string, WorkspaceManifestArtifact>;
  validationRules: string[];
  createdAt: string;
  updatedAt: string;
};

export type RunInputSnapshotFile = {
  path: string;
  hash: string;
  size: number;
  mimeType?: string;
};

export type RunInputSnapshot = {
  id: string;
  runId: string;
  projectId: string;
  sessionId?: string;
  prompt?: string;
  productId?: string;
  snapshotMode: 'full_project';
  root: string;
  excludeRules: string[];
  projectGitCommit?: string;
  projectGitDirty?: boolean;
  fileManifest: RunInputSnapshotFile[];
  referencedFiles: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  createdAt: string;
};

export type EvalFixture = {
  id: string;
  name?: string;
  productId: string;
  target: string;
  sourceRunId?: string;
  sourceSnapshotId?: string;
  workspaceSnapshotRoot: string;
  inputMessages: Array<{ role: 'user' | 'assistant'; content: string; createdAt?: string }>;
  referencedSnippets: ReferencedChatSnippet[];
  memoryFixture: MemoryRecord[];
  knowledgeFixture: KnowledgeBaseEntry[];
  expectedChangedFiles?: RunArtifact['changedFiles'];
  expectedToolEvents?: StreamEvent[];
  toolRetentionPolicy?: Array<{
    toolCallId: string;
    toolName?: string;
    retention: 'full' | 'excerpt_hash' | 'summary_hash' | 'drop';
    sensitivity: 'low' | 'medium' | 'high';
    reason: string;
    matchedSensitiveRules?: string[];
  }>;
  sensitiveFieldRules?: Array<{
    id: string;
    pattern: string;
    enabled: boolean;
  }>;
  toolRetentionArtifacts?: Array<{
    toolCallId: string;
    toolName?: string;
    retention: 'full' | 'excerpt_hash' | 'summary_hash' | 'drop';
    inputExcerpt?: string;
    inputSummary?: string;
    inputHash?: string;
    inputChars: number;
    outputExcerpt?: string;
    outputSummary?: string;
    outputHash?: string;
    outputChars: number;
    dropped?: boolean;
  }>;
  toolMocks: Record<string, unknown>;
  assertions: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type RunArtifact = {
  runId: string;
  projectId: string;
  sessionId?: string;
  productId?: string;
  inputSnapshotId?: string;
  traceId?: string;
  model?: string;
  modelParams?: {
    model?: string;
    modelPolicyRef?: string;
    temperature?: number;
    maxSteps?: number;
    source: 'run_input' | 'resolved_agent_config' | 'runtime_default';
  };
  prompt: string;
  referencedFiles: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  streamEvents: StreamEvent[];
  fileDiff: Array<{ path: string; change: 'created' | 'modified' | 'deleted' }>;
  changedFiles: Array<{ path: string; change: 'created' | 'modified' | 'deleted'; content?: string; hash?: string }>;
  memoryFixture: MemoryRecord[];
  knowledgeFixture: KnowledgeBaseEntry[];
  memoryWrites: Array<{ authority: MemoryRecord['authority']; memoryType: MemoryRecord['memoryType']; updateMode?: MemoryRecord['updateMode']; content: string; emittedAt: string; tombstonedMemoryId?: string; mocked?: boolean; persisted?: boolean }>;
  memoryTombstones: Array<{ memoryId?: string; content: string; emittedAt: string }>;
  knowledgeRetrievals: Array<{ query: string; matches: KnowledgeBaseEntry[]; emittedAt: string; tags?: string[]; topK?: number; source?: 'live' | 'fixture'; rightsRiskMax?: KnowledgeBaseEntry['rightsRisk'] }>;
  toolIoSummaries: Array<{ toolCallId: string; toolName?: string; inputChars: number; outputChars: number; inputTruncated: boolean; outputTruncated: boolean }>;
  toolEvents: StreamEvent[];
  resolvedAgentConfig?: EvalRun['resolvedAgentConfig'];
  status: 'running' | 'success' | 'error' | 'cancelled';
  createdAt: string;
  updatedAt: string;
};

export type EvalAssertionResult = {
  id: string;
  passed: boolean;
  message?: string;
};

export type EvalRun = {
  id: string;
  fixtureId: string;
  agentSpecId: string;
  runMode: 'live' | 'repro';
  executionMode?: 'fixture_replay' | 'custom_executor' | 'langgraph_isolated';
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error';
  model?: string;
  modelParams?: RunArtifact['modelParams'];
  startedAt: string;
  endedAt?: string;
  outputMessage?: string;
  errorMessage?: string;
  toolEvents: StreamEvent[];
  fileDiff: Array<{ path: string; change: 'created' | 'modified' | 'deleted' }>;
  changedFiles?: RunArtifact['changedFiles'];
  assertionResults: EvalAssertionResult[];
  humanReview?: HumanReview | null;
  resolvedAgentConfig?: {
    agentSpec?: AgentSpec;
    layerConfig?: AgentLayerConfig;
    memoryPolicy?: MemoryPolicy;
    retrievalPolicy?: RetrievalPolicy;
  promptBlockRefs?: string[];
  skillRefs?: AgentSpec['skillRefs'];
    promptBlocks?: Array<{ ref: string; content?: string; contentHash?: string; source: 'prompt_block' | 'agent_spec' | 'layer_config' | 'missing' }>;
    skills?: Array<{ ref: string; skillId: string; content?: string; contentHash?: string; source: 'skill_snapshot' | 'agent_config' | 'product_profile' | 'agent_spec_hash' | 'missing' }>;
  toolPolicyRef?: string;
    modelPolicyRef?: string;
    workspaceManifest?: WorkspaceManifest;
  };
  traceId?: string;
};

export type HumanReviewRubric = {
  id: string;
  productId: string;
  artifactType: string;
  version: number;
  status: HarnessRecordStatus;
  hardChecks: Array<{ id: string; label: string; source: 'program' | 'human' }>;
  humanScores: Array<{
    id: string;
    label: string;
    scale: number;
    anchors?: Record<string, string>;
    subScores?: string[];
  }>;
  decisionRules: {
    minimumAverageScore?: number;
    minimumRequiredScores?: Record<string, number>;
    requiresHumanDecision: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type HumanReview = {
  evalRunId: string;
  rubricId: string;
  rubricVersion: number;
  reviewer: string;
  decision: 'pass' | 'fail' | 'improved' | 'regressed' | 'needs_regression_case';
  scores: Record<string, number>;
  subScores?: Record<string, Record<string, number>>;
  annotations?: Array<{
    path: string;
    line?: number;
    assertionId?: string;
    severity: 'note' | 'issue' | 'blocker';
    comment: string;
  }>;
  notes?: string;
  createdAt: string;
};

export type AgentSpecReleaseGate = {
  agentSpecId: string;
  passed: boolean;
  reason: string;
  evalRunIds: string[];
  checks: Array<{ id: string; passed: boolean; message?: string }>;
  configChanges: Array<{ field: string; changed: boolean; message: string }>;
};

export type AgentSpecReleaseForceReason =
  | 'emergency_fix'
  | 'eval_gap'
  | 'manual_override'
  | 'rollback'
  | 'bad_active_regression'
  | 'bad_release'
  | 'data_corruption'
  | 'policy_violation'
  | 'other';

export type AgentSpecReleaseAuditCategory =
  | 'gate_bypass'
  | 'quality_regression'
  | 'operational_incident'
  | 'data_integrity'
  | 'policy_exception'
  | 'planned_rollback'
  | 'other';

export type AgentSpecReleaseRecord = {
  id: string;
  agentSpecId: string;
  productId: string;
  agentId: string;
  action: 'activate' | 'rollback';
  previousActiveSpecId?: string;
  targetSpecId: string;
  evalRunIds: string[];
  force?: boolean;
  forceReason?: AgentSpecReleaseForceReason;
  gate?: AgentSpecReleaseGate;
  auditCategory?: AgentSpecReleaseAuditCategory;
  sourceReleaseRecordId?: string;
  reviewer?: string;
  notes?: string;
  createdAt: string;
};

export type HarnessSummary = {
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
