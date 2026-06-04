import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProductProfile, TheaterSkill } from '@viwork/shared';

import { PRODUCT_PROFILE } from '../env';

import { listAgentConfigSkillDefinitions, toTheaterSkill } from './agentConfigSkills';

export type SkillStore = {
  listSkills(): Promise<TheaterSkill[]>;
  setEnabled(slug: string, enabled: boolean): Promise<TheaterSkill | undefined>;
  createSkill(input: { title: string; description: string; prompt: string }): Promise<TheaterSkill>;
};

type SkillStoreOptions = {
  agentConfigSkillsRoot: string;
  productProfile?: ProductProfile;
};

export function createSkillStore(options: SkillStoreOptions): SkillStore {
  const defaultAgentSkillNames = new Set((options.productProfile ?? PRODUCT_PROFILE).defaultAgentSkillNames);
  return {
    async listSkills() {
      const skills = await listAgentConfigSkillDefinitions(options.agentConfigSkillsRoot);
      return skills.map((skill) => toTheaterSkill(skill, defaultAgentSkillNames));
    },

    async setEnabled() {
      return undefined;
    },

    async createSkill(input) {
      const now = new Date().toISOString();
      const slug = await nextAvailableSkillDirectory(options.agentConfigSkillsRoot, slugifyPinyinFallback(input.title));
      const skillRoot = path.join(options.agentConfigSkillsRoot, slug);
      const skillPath = path.join(skillRoot, 'SKILL.md');
      await mkdir(skillRoot, { recursive: true });
      await writeFile(skillPath, skillMarkdown(slug, input.description, input.prompt), 'utf8');

      return {
        slug: `agent-config:${slug}`,
        title: slug,
        description: input.description,
        prompt: '',
        enabled: true,
        scope: 'user',
        createdAt: now,
        updatedAt: now,
        source: 'agent-config',
        mutable: false,
        location: `Agent 配置/skills/${slug}/SKILL.md`,
      };
    },
  };
}

async function nextAvailableSkillDirectory(root: string, baseSlug: string): Promise<string> {
  let slug = baseSlug;
  let suffix = 2;
  const existing = new Set((await listAgentConfigSkillDefinitions(root)).map((skill) => skill.name));

  while (existing.has(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

function skillMarkdown(name: string, description: string, prompt: string): string {
  return [
    '---',
    `name: ${yamlString(name)}`,
    `description: ${yamlString(description)}`,
    '---',
    '',
    `# ${name}`,
    '',
    prompt,
    '',
  ].join('\n');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function slugifyPinyinFallback(value: string): string {
  const known: Record<string, string> = {
    冷: 'leng',
    开: 'kai',
    场: 'chang',
    生: 'sheng',
    成: 'cheng',
    器: 'qi',
    原: 'yuan',
    著: 'zhu',
    分: 'fen',
    析: 'xi',
    助: 'zhu',
    手: 'shou',
  };
  const parts: string[] = [];
  for (const char of value.trim()) {
    if (/[a-zA-Z0-9]/.test(char)) {
      parts.push(char.toLowerCase());
    } else if (known[char]) {
      parts.push(known[char]);
    } else if (/[\s_-]/.test(char)) {
      parts.push('-');
    }
  }
  return parts.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `skill-${Date.now()}`;
}
