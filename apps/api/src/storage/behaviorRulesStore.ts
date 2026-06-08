import { z } from 'zod';

import type { WorkspaceStore } from './workspaceStore';

export type BehaviorRule = {
  id: string;
  label: string;
  content: string;
  enabled: boolean;
  builtIn: boolean;
};

export type BehaviorRulesStore = {
  getRules(): Promise<BehaviorRule[]>;
  saveRules(rules: BehaviorRule[]): Promise<BehaviorRule[]>;
};

const BEHAVIOR_RULES_PATH = 'Agent 配置/behavior-rules.json';

const behaviorRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  content: z.string(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
});

const behaviorRulesFileSchema = z.object({
  rules: z.array(behaviorRuleSchema),
});

const DEFAULT_RULES: BehaviorRule[] = [
  {
    id: 'image-tool-confirmation',
    label: '图片工具确认协议',
    content:
      '调用 generate_project_image 或 edit_project_image 之前，必须先在回复中向用户展示完整的提示词（prompt）、图片比例、生成数量、预计保存路径；编辑时还需说明基于哪张原图和修改要点。展示后等待用户明确同意（如"可以""确认""好的""开始吧"等）再调用工具。用户未确认或要求调整时，先修改方案再重新展示，不要自行调用。',
    enabled: true,
    builtIn: true,
  },
];

export function createBehaviorRulesStore(store: WorkspaceStore): BehaviorRulesStore {
  return {
    async getRules() {
      try {
        const file = await store.readGlobalWorkspaceFile(BEHAVIOR_RULES_PATH);
        const parsed = behaviorRulesFileSchema.parse(JSON.parse(file.content));
        return ensureBuiltInRules(parsed.rules);
      } catch {
        return DEFAULT_RULES;
      }
    },

    async saveRules(rules) {
      const validated = behaviorRulesFileSchema.parse({ rules });
      const merged = ensureBuiltInRules(validated.rules);
      await store.writeGlobalWorkspaceFile(BEHAVIOR_RULES_PATH, JSON.stringify({ rules: merged }, null, 2));
      return merged;
    },
  };
}

function ensureBuiltInRules(rules: BehaviorRule[]): BehaviorRule[] {
  const result = [...rules];
  for (const defaultRule of DEFAULT_RULES) {
    const existing = result.find((r) => r.id === defaultRule.id);
    if (!existing) {
      result.push(defaultRule);
    }
  }
  return result;
}
