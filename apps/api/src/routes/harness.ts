import { Hono } from 'hono';
import { z } from 'zod';

import type { UpdateEvalFixtureInput, HarnessStore } from '../harness/harnessStore';

const runtimeConfigFlowNodeRefSchema = z.object({
  source: z.enum(['new', 'reused', 'derived']),
  id: z.string().trim().min(1).optional(),
  version: z.number().int().positive().optional(),
  name: z.string().trim().min(1).optional(),
});

const runtimeConfigFlowChangeSchema = z.object({
  scope: z.enum(['system', 'product', 'agent']),
  area: z.enum(['agent_prompt', 'behavior_rule', 'tool_description', 'policy', 'eval_fixture', 'eval_run_config', 'assertion_config', 'review_template']),
  targetId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
});

const createRuntimeConfigFlowSchema = z.object({
  productId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  agentId: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  nodeRefs: z.object({
    evalFixture: runtimeConfigFlowNodeRefSchema.optional(),
    agentConfig: runtimeConfigFlowNodeRefSchema.optional(),
    evalRunConfig: runtimeConfigFlowNodeRefSchema.optional(),
    assertionConfig: runtimeConfigFlowNodeRefSchema.optional(),
    reviewTemplate: runtimeConfigFlowNodeRefSchema.optional(),
  }).default({}),
  candidateSpecId: z.string().trim().min(1).optional(),
  activeSpecId: z.string().trim().min(1).optional(),
  evalRunIds: z.array(z.string().trim().min(1)).default([]),
  releaseRecordIds: z.array(z.string().trim().min(1)).default([]),
  changes: z.array(runtimeConfigFlowChangeSchema).default([]),
});

const updateRuntimeConfigFlowSchema = createRuntimeConfigFlowSchema.omit({ productId: true }).partial();

const cloneNamedRecordSchema = z.object({
  name: z.string().trim().min(1).optional(),
}).default({});

const memoryRecordSchema = z.object({
  id: z.string().trim().min(1),
  namespace: z.array(z.string().trim().min(1)),
  scope: z.enum(['session', 'workspace', 'global']),
  memoryType: z.enum(['profile', 'knowledge', 'event', 'decision', 'constraint', 'summary']),
  authority: z.enum(['user_explicit', 'file_derived', 'agent_inferred', 'workflow_event']),
  updateMode: z.enum(['upsert', 'append', 'summarize', 'tombstone']),
  key: z.string().optional(),
  content: z.string(),
  evidenceRefs: z.array(z.union([
    z.object({ type: z.literal('file'), path: z.string().trim().min(1), hash: z.string().optional() }),
    z.object({ type: z.literal('message'), sessionId: z.string().trim().min(1), messageId: z.string().trim().min(1) }),
    z.object({ type: z.literal('run'), runId: z.string().trim().min(1) }),
  ])),
  confidence: z.number().optional(),
  createdByAgent: z.string().optional(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  tombstonedAt: z.string().nullable().optional(),
});

const createAgentSpecSchema = z.object({
  productId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  layerConfigRef: z.string().trim().min(1).optional(),
  promptBlockRefs: z.array(z.string().trim().min(1)).default([]),
  skillRefs: z.array(z.object({
    skillId: z.string().trim().min(1),
    version: z.number().int().positive().optional(),
    contentHash: z.string().trim().min(1).optional(),
  })).default([]),
  memoryPolicyRef: z.string().trim().min(1).optional(),
  retrievalPolicyRef: z.string().trim().min(1).optional(),
  toolPolicyRef: z.string().trim().min(1).optional(),
  behaviorRuleRefs: z.array(z.string().trim().min(1)).default([]),
  toolPolicyRefs: z.array(z.string().trim().min(1)).default([]),
  toolDescriptionRefs: z.array(z.string().trim().min(1)).default([]),
  modelPolicyRef: z.string().trim().min(1).optional(),
  changelog: z.string().optional(),
});

const createAgentLayerConfigSchema = z.object({
  productId: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  promptBlockRefs: z.array(z.string().trim().min(1)).default([]),
  behaviorRuleRefs: z.array(z.string().trim().min(1)).default([]),
  toolPolicyRefs: z.array(z.string().trim().min(1)).default([]),
  toolDescriptionRefs: z.array(z.string().trim().min(1)).default([]),
  toolDescriptionOverrides: z.array(z.object({
    toolId: z.string().trim().min(1),
    description: z.string().trim().min(1),
    parameterDescriptions: z.record(z.string().trim().min(1)).optional(),
    outputDescription: z.string().trim().min(1).optional(),
  })).optional(),
  systemAgent: z.object({
    agentId: z.string().trim().min(1),
    promptBlockRefs: z.array(z.string().trim().min(1)).default([]),
    behaviorRuleRefs: z.array(z.string().trim().min(1)).default([]),
    toolPolicyRefs: z.array(z.string().trim().min(1)).default([]),
    toolDescriptionRefs: z.array(z.string().trim().min(1)).default([]),
    allowedTools: z.array(z.string().trim().min(1)).default([]),
    instructionOverride: z.string().optional(),
  }),
  specialists: z.array(z.object({
    agentId: z.string().trim().min(1),
    skillRef: z.string().trim().min(1).optional(),
    promptBlockRefs: z.array(z.string().trim().min(1)).default([]),
    behaviorRuleRefs: z.array(z.string().trim().min(1)).default([]),
    toolPolicyRefs: z.array(z.string().trim().min(1)).default([]),
    toolDescriptionRefs: z.array(z.string().trim().min(1)).default([]),
    defaultEnabled: z.boolean().default(true),
    allowedTools: z.array(z.string().trim().min(1)).optional(),
    instructionOverride: z.string().optional(),
  })).default([]),
  memoryPolicyRef: z.string().trim().min(1).optional(),
  retrievalPolicyRef: z.string().trim().min(1).optional(),
  toolPolicyRef: z.string().trim().min(1).optional(),
  modelPolicyRef: z.string().trim().min(1).optional(),
});

const behaviorRuleConfigSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('candidate'),
  scope: z.enum(['system', 'product', 'agent']).default('product'),
  agentId: z.string().trim().min(1).optional(),
  source: z.object({
    type: z.enum(['new', 'runtime_config', 'eval_fixture', 'assertion_config', 'eval_run_config', 'human_review_rubric', 'tool_description', 'run_artifact', 'snapshot']),
    id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
  }).optional(),
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
});

const createBehaviorRuleConfigVersionSchema = behaviorRuleConfigSchema.omit({ id: true, productId: true, version: true }).partial();

const agentToolPolicySchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('candidate'),
  scope: z.enum(['system', 'product', 'agent']).default('product'),
  agentId: z.string().trim().min(1).optional(),
  source: z.object({
    type: z.enum(['new', 'runtime_config', 'eval_fixture', 'assertion_config', 'eval_run_config', 'human_review_rubric', 'tool_description', 'run_artifact', 'snapshot']),
    id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
  }).optional(),
  allowedToolIds: z.array(z.string().trim().min(1)).default([]),
  deniedToolIds: z.array(z.string().trim().min(1)).default([]),
  highRiskToolIds: z.array(z.string().trim().min(1)).default([]),
  toolDescriptionRefs: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
});

const createAgentToolPolicyVersionSchema = agentToolPolicySchema.omit({ id: true, productId: true, version: true }).partial();

const createMemoryPolicySchema = z.object({
  productId: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  namespaces: z.object({
    session: z.array(z.string().trim().min(1)),
    workspace: z.array(z.string().trim().min(1)),
    global: z.array(z.string().trim().min(1)),
  }),
  recallOrder: z.array(z.enum(['session', 'workspace', 'global'])),
  writeRules: z.record(z.enum(['allow', 'allow_with_evidence', 'confirm_for_long_term', 'deny'])),
  conflictPolicy: z.enum(['formal_file_wins', 'newest_wins', 'manual_review']),
  tombstoneRequired: z.boolean(),
});

const knowledgeBaseEntrySchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  path: z.string().trim().min(1),
  type: z.enum(['mechanism', 'viewpoint', 'joke_pattern', 'source_note', 'inbox']),
  tags: z.array(z.string().trim().min(1)).default([]),
  rightsRisk: z.enum(['low', 'medium', 'high']),
  source: z.string().optional(),
  contentHash: z.string().optional(),
  updatedAt: z.string().optional(),
});

const createRetrievalPolicySchema = z.object({
  productId: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  enabledTypes: z.array(z.enum(['mechanism', 'viewpoint', 'joke_pattern', 'source_note', 'inbox'])),
  defaultTopK: z.number().int().positive(),
  rightsRiskMax: z.enum(['low', 'medium', 'high']),
  writeFlow: z.enum(['inbox_then_confirm', 'direct_confirmed_only']),
  forbiddenUse: z.array(z.string().trim().min(1)).default([]),
  mockable: z.boolean().default(true),
});

const createPromptBlockSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  title: z.string().trim().min(1),
  scope: z.enum(['system', 'specialist', 'reviewer', 'tool', 'quality', 'other']),
  content: z.string().min(1),
});

const createSkillSnapshotSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  skillId: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  source: z.enum(['agent_config', 'product_profile', 'imported', 'manual']),
  content: z.string().min(1),
});

const createPromptBlockVersionSchema = z.object({
  status: z.enum(['draft', 'candidate', 'active', 'archived']).optional(),
  title: z.string().trim().min(1).optional(),
  scope: z.enum(['system', 'specialist', 'reviewer', 'tool', 'quality', 'other']).optional(),
  content: z.string().min(1).optional(),
});

const toolDescriptionConfigSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('candidate'),
  scope: z.enum(['system', 'product', 'agent']).default('product'),
  agentId: z.string().trim().min(1).optional(),
  source: z.object({
    type: z.enum(['new', 'runtime_config', 'eval_fixture', 'assertion_config', 'eval_run_config', 'human_review_rubric', 'tool_description', 'run_artifact', 'snapshot']),
    id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
  }).optional(),
  toolId: z.string().trim().min(1),
  description: z.string().trim().min(1),
  parameterDescriptions: z.record(z.string().trim().min(1)).optional(),
  outputDescription: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
});

const createToolDescriptionConfigVersionSchema = toolDescriptionConfigSchema.omit({ id: true, productId: true, version: true, toolId: true }).partial();

const updateVersionedRecordStatusSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']),
});

const createSkillSnapshotVersionSchema = z.object({
  status: z.enum(['draft', 'candidate', 'active', 'archived']).optional(),
  source: z.enum(['agent_config', 'product_profile', 'imported', 'manual']).optional(),
  content: z.string().min(1).optional(),
});

const createEvalFixtureBaseSchema = z.object({
  snapshotId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  target: z.string().trim().min(1),
  inputMessages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    createdAt: z.string().optional(),
  })).optional(),
  memoryFixture: z.array(memoryRecordSchema).optional(),
  knowledgeFixture: z.array(knowledgeBaseEntrySchema).optional(),
  toolMocks: z.record(z.unknown()).optional(),
  assertions: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

const createEvalFixtureSchema = createEvalFixtureBaseSchema.transform((input) => ({
  ...input,
  knowledgeFixture: input.knowledgeFixture?.map((entry) => ({
    ...entry,
    updatedAt: entry.updatedAt ?? new Date().toISOString(),
  })),
}));

const createEvalRunSchema = z.object({
  fixtureId: z.string().trim().min(1),
  agentSpecId: z.string().trim().min(1),
  evalRunConfigId: z.string().trim().min(1).optional(),
  assertionConfigId: z.string().trim().min(1).optional(),
  humanReviewRubricId: z.string().trim().min(1).optional(),
  runMode: z.enum(['live', 'repro']).optional(),
});

const assertionDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(['file_change', 'path_constraint', 'markdown_section', 'tool_event', 'diff_limit', 'manifest_compliance']),
  enabled: z.boolean().default(true),
  severity: z.enum(['blocking', 'warning', 'info']).default('blocking'),
  description: z.string().optional(),
  config: z.record(z.unknown()).default({}),
});

const createAssertionConfigSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  source: z.object({
    type: z.enum(['new', 'runtime_config', 'eval_fixture', 'assertion_config', 'eval_run_config', 'human_review_rubric', 'tool_description', 'run_artifact', 'snapshot']),
    id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
  }).optional(),
  assertions: z.array(assertionDefinitionSchema).min(1),
  compiledAssertions: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).default([]),
});

const createAssertionConfigVersionSchema = createAssertionConfigSchema.omit({ id: true, productId: true, version: true }).partial();

const createEvalRunConfigSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  source: z.object({
    type: z.enum(['new', 'runtime_config', 'eval_fixture', 'assertion_config', 'eval_run_config', 'human_review_rubric', 'tool_description', 'run_artifact', 'snapshot']),
    id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
  }).optional(),
  runMode: z.enum(['live', 'repro']),
  modelOverride: z.string().trim().min(1).optional(),
  memoryMode: z.enum(['fixture', 'live', 'mocked']),
  knowledgeMode: z.enum(['fixture', 'live', 'mocked']),
  highRiskToolMode: z.enum(['mock', 'allow', 'deny']),
  toolMocks: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).default([]),
});

const createEvalRunConfigVersionSchema = createEvalRunConfigSchema.omit({ id: true, productId: true, version: true }).partial();

const updateEvalFixtureSchema = z.object({
  name: z.string().trim().min(1).optional(),
  target: z.string().trim().min(1).optional(),
  inputMessages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    createdAt: z.string().optional(),
  })).optional(),
  referencedSnippets: z.array(z.object({
    id: z.string().trim().min(1),
    messageId: z.string().trim().min(1),
    role: z.enum(['user', 'assistant']),
    label: z.string().trim().min(1),
    text: z.string(),
    createdAt: z.string().trim().min(1),
  })).optional(),
  memoryFixture: z.array(memoryRecordSchema).optional(),
  knowledgeFixture: z.array(knowledgeBaseEntrySchema).optional(),
  expectedChangedFiles: z.array(z.object({
    path: z.string().trim().min(1),
    change: z.enum(['created', 'modified', 'deleted']),
    content: z.string().optional(),
    hash: z.string().optional(),
  })).optional(),
  expectedToolEvents: z.array(z.unknown()).optional(),
  toolRetentionPolicy: z.array(z.object({
    toolCallId: z.string().trim().min(1),
    toolName: z.string().optional(),
    retention: z.enum(['full', 'excerpt_hash', 'summary_hash', 'drop']),
    sensitivity: z.enum(['low', 'medium', 'high']),
    reason: z.string(),
    matchedSensitiveRules: z.array(z.string().trim().min(1)).optional(),
  })).optional(),
  sensitiveFieldRules: z.array(z.object({
    id: z.string().trim().min(1),
    pattern: z.string().trim().min(1),
    enabled: z.boolean(),
  })).optional(),
  toolRetentionArtifacts: z.array(z.object({
    toolCallId: z.string().trim().min(1),
    toolName: z.string().optional(),
    retention: z.enum(['full', 'excerpt_hash', 'summary_hash', 'drop']),
    inputExcerpt: z.string().optional(),
    inputSummary: z.string().optional(),
    inputHash: z.string().optional(),
    inputChars: z.number().int().nonnegative(),
    outputExcerpt: z.string().optional(),
    outputSummary: z.string().optional(),
    outputHash: z.string().optional(),
    outputChars: z.number().int().nonnegative(),
    dropped: z.boolean().optional(),
  })).optional(),
  toolMocks: z.record(z.unknown()).optional(),
  assertions: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

const updateAgentSpecStatusSchema = z.object({
  status: z.enum(['candidate', 'active', 'archived']),
  force: z.boolean().optional(),
  forceReason: z.enum(['emergency_fix', 'eval_gap', 'manual_override', 'rollback', 'bad_active_regression', 'bad_release', 'data_corruption', 'policy_violation', 'other']).optional(),
  auditCategory: z.enum(['gate_bypass', 'quality_regression', 'operational_incident', 'data_integrity', 'policy_exception', 'planned_rollback', 'other']).optional(),
  reviewer: z.string().trim().min(1).optional(),
  notes: z.string().optional(),
}).superRefine((input, context) => {
  if (!input.force) return;
  if (!input.forceReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['forceReason'], message: 'forceReason is required when force is true' });
  }
  if (!input.notes?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['notes'], message: 'notes are required when force is true' });
  }
});

const rollbackAgentSpecSchema = z.object({
  forceReason: z.enum(['emergency_fix', 'eval_gap', 'manual_override', 'rollback', 'bad_active_regression', 'bad_release', 'data_corruption', 'policy_violation', 'other']).optional(),
  auditCategory: z.enum(['gate_bypass', 'quality_regression', 'operational_incident', 'data_integrity', 'policy_exception', 'planned_rollback', 'other']).optional(),
  reviewer: z.string().trim().min(1).optional(),
  sourceReleaseRecordId: z.string().trim().min(1).optional(),
  notes: z.string().optional(),
}).superRefine((input, context) => {
  if (!input.notes?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['notes'], message: 'notes are required for rollback' });
  }
});

const createHumanReviewSchema = z.object({
  rubricId: z.string().trim().min(1),
  rubricVersion: z.number().int().positive(),
  reviewer: z.string().trim().min(1),
  decision: z.enum(['pass', 'fail', 'improved', 'regressed', 'needs_regression_case']),
  scoreStates: z.record(z.enum(['scored', 'not_applicable'])).optional(),
  scores: z.record(z.number()),
  subScores: z.record(z.record(z.number())).optional(),
  annotations: z.array(z.object({
    path: z.string().trim().min(1),
    line: z.number().int().positive().optional(),
    assertionId: z.string().trim().min(1).optional(),
    severity: z.enum(['note', 'issue', 'blocker']),
    comment: z.string().trim().min(1),
  })).optional(),
  notes: z.string().optional(),
});

const humanReviewRubricSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  artifactType: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  status: z.enum(['draft', 'candidate', 'active', 'archived']).default('draft'),
  source: z.object({
    type: z.enum(['new', 'runtime_config', 'eval_fixture', 'assertion_config', 'eval_run_config', 'human_review_rubric', 'tool_description', 'run_artifact', 'snapshot']),
    id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
  }).optional(),
  hardChecks: z.array(z.object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    source: z.enum(['program', 'human']),
  })).default([]),
  humanScores: z.array(z.object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    scale: z.literal(10),
    weight: z.number().positive().optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    notePrompt: z.string().optional(),
    anchors: z.record(z.string()).optional(),
    subScores: z.array(z.string().trim().min(1)).optional(),
  })).min(1),
  decisionRules: z.object({
    minimumAverageScore: z.number().optional(),
    minimumRequiredScores: z.record(z.number()).optional(),
    requiresHumanDecision: z.literal(true),
  }),
});

const createHumanReviewRubricVersionSchema = humanReviewRubricSchema.omit({ id: true, productId: true, version: true }).partial();

const createBatchHumanReviewSchema = createHumanReviewSchema.extend({
  evalRunIds: z.array(z.string().trim().min(1)).min(1),
});

export function createHarnessRoutes(store: HarnessStore): Hono {
  const routes = new Hono();

  routes.get('/harness', async (context) => context.json(await store.getSummary()));

  routes.get('/harness/runtime-config-flows', async (context) => context.json(await store.listRuntimeConfigFlows({
    productId: context.req.query('productId') || undefined,
    agentId: context.req.query('agentId') || undefined,
    status: parseHarnessRecordStatus(context.req.query('status')),
    releaseState: parseRuntimeConfigFlowReleaseState(context.req.query('releaseState')),
    tag: context.req.query('tag') || undefined,
    query: context.req.query('query') || undefined,
    sort: parseRuntimeConfigFlowSort(context.req.query('sort')),
  })));

  routes.post('/harness/runtime-config-flows', async (context) => {
    const parsed = createRuntimeConfigFlowSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid runtime config flow' }, 400);
    try {
      return context.json(await store.createRuntimeConfigFlow(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/runtime-config-flows/:flowId/clone', async (context) => {
    const parsed = cloneNamedRecordSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid runtime config flow clone' }, 400);
    try {
      return context.json(await store.cloneRuntimeConfigFlow(context.req.param('flowId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.patch('/harness/runtime-config-flows/:flowId', async (context) => {
    const parsed = updateRuntimeConfigFlowSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid runtime config flow update' }, 400);
    try {
      return context.json(await store.updateRuntimeConfigFlow(context.req.param('flowId'), parsed.data));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.delete('/harness/runtime-config-flows/:flowId', async (context) => {
    try {
      return context.json(await store.deleteRuntimeConfigFlow(context.req.param('flowId')));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/agent-layer-configs', async (context) => context.json(await store.listAgentLayerConfigs()));

  routes.post('/harness/agent-layer-configs', async (context) => {
    const parsed = createAgentLayerConfigSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid agent layer config' }, 400);
    return context.json(await store.createAgentLayerConfig(parsed.data), 201);
  });

  routes.get('/harness/behavior-rule-configs', async (context) => context.json(await store.listBehaviorRuleConfigs()));

  routes.post('/harness/behavior-rule-configs', async (context) => {
    const parsed = behaviorRuleConfigSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid behavior rule config' }, 400);
    try {
      return context.json(await store.createBehaviorRuleConfig(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/behavior-rule-configs/:ruleConfigId/versions', async (context) => {
    const parsed = createBehaviorRuleConfigVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid behavior rule config version' }, 400);
    try {
      return context.json(await store.createBehaviorRuleConfigVersion(context.req.param('ruleConfigId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/agent-tool-policies', async (context) => context.json(await store.listAgentToolPolicies()));

  routes.post('/harness/agent-tool-policies', async (context) => {
    const parsed = agentToolPolicySchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid agent tool policy' }, 400);
    try {
      return context.json(await store.createAgentToolPolicy(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/agent-tool-policies/:policyId/versions', async (context) => {
    const parsed = createAgentToolPolicyVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid agent tool policy version' }, 400);
    try {
      return context.json(await store.createAgentToolPolicyVersion(context.req.param('policyId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/agent-specs', async (context) => context.json(await store.listAgentSpecs()));

  routes.get('/harness/release-records', async (context) => context.json(await store.listReleaseRecords({
    productId: context.req.query('productId') || undefined,
    agentId: context.req.query('agentId') || undefined,
    action: parseReleaseAction(context.req.query('action')),
    auditCategory: parseReleaseAuditCategory(context.req.query('auditCategory')),
    force: parseOptionalBoolean(context.req.query('force')),
    limit: parseOptionalPositiveInt(context.req.query('limit')),
  })));

  routes.get('/harness/agent-specs/:agentSpecId/release-gate', async (context) => {
    try {
      return context.json(await store.getAgentSpecReleaseGate(context.req.param('agentSpecId')));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/agent-specs', async (context) => {
    const parsed = createAgentSpecSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid agent spec' }, 400);
    return context.json(await store.createAgentSpec(parsed.data), 201);
  });

  routes.post('/harness/agent-specs/:agentSpecId/clone', async (context) => {
    const parsed = cloneNamedRecordSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid agent spec clone' }, 400);
    try {
      return context.json(await store.cloneAgentSpec(context.req.param('agentSpecId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.patch('/harness/agent-specs/:agentSpecId/status', async (context) => {
    const parsed = updateAgentSpecStatusSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid agent spec status' }, 400);
    try {
      return context.json(await store.updateAgentSpecStatus(context.req.param('agentSpecId'), parsed.data.status, {
        force: parsed.data.force,
        forceReason: parsed.data.forceReason,
        auditCategory: parsed.data.auditCategory,
        reviewer: parsed.data.reviewer,
        notes: parsed.data.notes,
      }));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.delete('/harness/agent-specs/:agentSpecId', async (context) => {
    try {
      return context.json(await store.deleteAgentSpec(context.req.param('agentSpecId')));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/agent-specs/:agentSpecId/rollback', async (context) => {
    const parsed = rollbackAgentSpecSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid rollback request' }, 400);
    try {
      return context.json(await store.rollbackAgentSpec(context.req.param('agentSpecId'), parsed.data));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/memory-policies', async (context) => context.json(await store.listMemoryPolicies()));

  routes.post('/harness/memory-policies', async (context) => {
    const parsed = createMemoryPolicySchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid memory policy' }, 400);
    return context.json(await store.createMemoryPolicy(parsed.data), 201);
  });

  routes.get('/harness/knowledge-base-entries', async (context) => context.json(await store.listKnowledgeBaseEntries()));

  routes.post('/harness/knowledge-base-entries', async (context) => {
    const parsed = knowledgeBaseEntrySchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid knowledge base entry' }, 400);
    return context.json(await store.upsertKnowledgeBaseEntry(parsed.data), 201);
  });

  routes.get('/harness/retrieval-policies', async (context) => context.json(await store.listRetrievalPolicies()));

  routes.post('/harness/retrieval-policies', async (context) => {
    const parsed = createRetrievalPolicySchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid retrieval policy' }, 400);
    return context.json(await store.createRetrievalPolicy(parsed.data), 201);
  });

  routes.get('/harness/prompt-blocks', async (context) => context.json(await store.listPromptBlocks()));

  routes.post('/harness/prompt-blocks', async (context) => {
    const parsed = createPromptBlockSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid prompt block' }, 400);
    return context.json(await store.createPromptBlock(parsed.data), 201);
  });

  routes.post('/harness/prompt-blocks/:promptBlockId/versions', async (context) => {
    const parsed = createPromptBlockVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid prompt block version' }, 400);
    try {
      return context.json(await store.createPromptBlockVersion(context.req.param('promptBlockId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/prompt-blocks/:promptBlockId/diff', async (context) => {
    const fromVersion = parseOptionalPositiveInt(context.req.query('fromVersion'));
    const toVersion = parseOptionalPositiveInt(context.req.query('toVersion'));
    try {
      return context.json(await store.getPromptBlockDiff(context.req.param('promptBlockId'), fromVersion, toVersion));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.patch('/harness/prompt-blocks/:promptBlockId/status', async (context) => {
    const parsed = updateVersionedRecordStatusSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid prompt block status' }, 400);
    try {
      return context.json(await store.updatePromptBlockStatus(context.req.param('promptBlockId'), parsed.data.version, parsed.data.status));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/tool-description-configs', async (context) => context.json(await store.listToolDescriptionConfigs()));

  routes.post('/harness/tool-description-configs', async (context) => {
    const parsed = toolDescriptionConfigSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid tool description config' }, 400);
    try {
      return context.json(await store.createToolDescriptionConfig(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/tool-description-configs/:toolDescriptionConfigId/versions', async (context) => {
    const parsed = createToolDescriptionConfigVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid tool description config version' }, 400);
    try {
      return context.json(await store.createToolDescriptionConfigVersion(context.req.param('toolDescriptionConfigId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/tool-description-configs/:toolDescriptionConfigId/diff', async (context) => {
    const fromVersion = parseOptionalPositiveInt(context.req.query('fromVersion'));
    const toVersion = parseOptionalPositiveInt(context.req.query('toVersion'));
    try {
      return context.json(await store.getToolDescriptionConfigDiff(context.req.param('toolDescriptionConfigId'), fromVersion, toVersion));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/skill-snapshots', async (context) => context.json(await store.listSkillSnapshots()));

  routes.post('/harness/skill-snapshots', async (context) => {
    const parsed = createSkillSnapshotSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid skill snapshot' }, 400);
    return context.json(await store.createSkillSnapshot(parsed.data), 201);
  });

  routes.post('/harness/skill-snapshots/:skillSnapshotId/versions', async (context) => {
    const parsed = createSkillSnapshotVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid skill snapshot version' }, 400);
    try {
      return context.json(await store.createSkillSnapshotVersion(context.req.param('skillSnapshotId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/skill-snapshots/:skillSnapshotId/diff', async (context) => {
    const fromVersion = parseOptionalPositiveInt(context.req.query('fromVersion'));
    const toVersion = parseOptionalPositiveInt(context.req.query('toVersion'));
    try {
      return context.json(await store.getSkillSnapshotDiff(context.req.param('skillSnapshotId'), fromVersion, toVersion));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.patch('/harness/skill-snapshots/:skillSnapshotId/status', async (context) => {
    const parsed = updateVersionedRecordStatusSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid skill snapshot status' }, 400);
    try {
      return context.json(await store.updateSkillSnapshotStatus(context.req.param('skillSnapshotId'), parsed.data.version, parsed.data.status));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/workspace-manifests', async (context) => context.json(await store.listWorkspaceManifests()));

  routes.get('/harness/snapshots', async (context) => context.json(await store.listRunInputSnapshots()));

  routes.get('/harness/run-artifacts', async (context) => context.json(await store.listRunArtifacts()));

  routes.get('/harness/run-artifacts/:runId', async (context) => {
    const artifact = await store.getRunArtifact(context.req.param('runId'));
    if (!artifact) return context.json({ error: 'Run artifact not found' }, 404);
    return context.json(artifact);
  });

  routes.get('/harness/eval-fixtures', async (context) => context.json(await store.listEvalFixtures()));

  routes.post('/harness/eval-fixtures', async (context) => {
    const parsed = createEvalFixtureSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval fixture' }, 400);

    try {
      return context.json(await store.createEvalFixtureFromSnapshot(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/run-artifacts/:runId/eval-fixtures', async (context) => {
    const parsed = createEvalFixtureBaseSchema.omit({ snapshotId: true }).extend({
      snapshotId: z.string().trim().min(1).optional(),
    }).transform((input) => ({
      ...input,
      knowledgeFixture: input.knowledgeFixture?.map((entry) => ({
        ...entry,
        updatedAt: entry.updatedAt ?? new Date().toISOString(),
      })),
    })).safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval fixture' }, 400);

    try {
      return context.json(await store.createEvalFixtureFromRunArtifact(context.req.param('runId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/eval-fixtures/:fixtureId/clone', async (context) => {
    const parsed = cloneNamedRecordSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval fixture clone' }, 400);
    try {
      return context.json(await store.cloneEvalFixture(context.req.param('fixtureId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.patch('/harness/eval-fixtures/:fixtureId', async (context) => {
    const parsed = updateEvalFixtureSchema.transform((input) => ({
      ...input,
      knowledgeFixture: input.knowledgeFixture?.map((entry) => ({
        ...entry,
        updatedAt: entry.updatedAt ?? new Date().toISOString(),
      })),
    })).safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval fixture update' }, 400);
    try {
      return context.json(await store.updateEvalFixture(context.req.param('fixtureId'), parsed.data as UpdateEvalFixtureInput));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/assertion-configs', async (context) => context.json(await store.listAssertionConfigs()));

  routes.post('/harness/assertion-configs', async (context) => {
    const parsed = createAssertionConfigSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid assertion config' }, 400);
    try {
      return context.json(await store.createAssertionConfig(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/assertion-configs/:assertionConfigId/clone', async (context) => {
    const parsed = cloneNamedRecordSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid assertion config clone' }, 400);
    try {
      return context.json(await store.cloneAssertionConfig(context.req.param('assertionConfigId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/assertion-configs/:assertionConfigId/versions', async (context) => {
    const parsed = createAssertionConfigVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid assertion config version' }, 400);
    try {
      return context.json(await store.createAssertionConfigVersion(context.req.param('assertionConfigId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/eval-run-configs', async (context) => context.json(await store.listEvalRunConfigs()));

  routes.post('/harness/eval-run-configs', async (context) => {
    const parsed = createEvalRunConfigSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval run config' }, 400);
    try {
      return context.json(await store.createEvalRunConfig(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/eval-run-configs/:evalRunConfigId/clone', async (context) => {
    const parsed = cloneNamedRecordSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval run config clone' }, 400);
    try {
      return context.json(await store.cloneEvalRunConfig(context.req.param('evalRunConfigId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/eval-run-configs/:evalRunConfigId/versions', async (context) => {
    const parsed = createEvalRunConfigVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval run config version' }, 400);
    try {
      return context.json(await store.createEvalRunConfigVersion(context.req.param('evalRunConfigId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/eval-runs', async (context) => context.json(await store.listEvalRuns()));

  routes.post('/harness/eval-runs', async (context) => {
    const parsed = createEvalRunSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid eval run' }, 400);

    try {
      return context.json(await store.createEvalRun(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/human-reviews/batch', async (context) => {
    const parsed = createBatchHumanReviewSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid batch human review' }, 400);
    try {
      return context.json(await store.addBatchHumanReview(parsed.data));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/eval-runs/:evalRunId/human-review', async (context) => {
    const parsed = createHumanReviewSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid human review' }, 400);
    try {
      return context.json(await store.addHumanReview(context.req.param('evalRunId'), parsed.data));
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.get('/harness/human-review-rubrics', async (context) => context.json(await store.listHumanReviewRubrics()));

  routes.post('/harness/human-review-rubrics', async (context) => {
    const parsed = humanReviewRubricSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid human review rubric' }, 400);
    try {
      return context.json(await store.createHumanReviewRubric(parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  routes.post('/harness/human-review-rubrics/:rubricId/versions', async (context) => {
    const parsed = createHumanReviewRubricVersionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid human review rubric version' }, 400);
    try {
      return context.json(await store.createHumanReviewRubricVersion(context.req.param('rubricId'), parsed.data), 201);
    } catch (error) {
      return handleHarnessError(context, error);
    }
  });

  return routes;
}

function handleHarnessError(context: { json: (data: { error: string }, status: 404) => Response }, error: unknown): Response {
  if (error instanceof Error) return context.json({ error: error.message }, 404);
  return context.json({ error: 'Harness resource not found' }, 404);
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parseReleaseAction(value: string | undefined): 'activate' | 'rollback' | undefined {
  return value === 'activate' || value === 'rollback' ? value : undefined;
}

function parseReleaseAuditCategory(value: string | undefined) {
  return value === 'gate_bypass'
    || value === 'quality_regression'
    || value === 'operational_incident'
    || value === 'data_integrity'
    || value === 'policy_exception'
    || value === 'planned_rollback'
    || value === 'other'
    ? value
    : undefined;
}

function parseHarnessRecordStatus(value: string | undefined) {
  return value === 'draft' || value === 'candidate' || value === 'active' || value === 'archived' ? value : undefined;
}

function parseRuntimeConfigFlowReleaseState(value: string | undefined) {
  return value === 'never_released' || value === 'released' || value === 'rolled_back' || value === 'archived' ? value : undefined;
}

function parseRuntimeConfigFlowSort(value: string | undefined) {
  return value === 'updatedAt' || value === 'createdAt' || value === 'gateStatus' || value === 'evalCompletion' ? value : undefined;
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
