import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TheaterSkill } from '@viwork/shared';

const SYSTEM_SKILLS: TheaterSkill[] = [
  {
    slug: 'character-bio',
    title: '角色小传',
    description: '根据系列设定生成角色背景、欲望、缺陷和喜剧触发点。',
    prompt: '请基于当前情景剧项目，生成角色小传，包含目标、弱点、口头禅和与其他角色的冲突关系。',
    enabled: true,
    scope: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    slug: 'conflict-pass',
    title: '冲突强化',
    description: '把平铺的桥段改成更强的误会、阻力和反转。',
    prompt: '请强化这段情景剧桥段的冲突，让角色目标互相碰撞，并加入清晰的喜剧反转。',
    enabled: true,
    scope: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    slug: 'storyboard-breakdown',
    title: '分镜拆解',
    description: '把剧本段落拆成可拍摄的场次、镜头和素材需求。',
    prompt: '请把这段剧本拆成分镜表，列出场次、画面、台词/声音、道具和素材需求。',
    enabled: true,
    scope: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    slug: 'video-prompt',
    title: '视频提示词',
    description: '把分镜或首尾帧描述整理为视频生成提示词。',
    prompt: '请根据分镜生成视频提示词，包含角色动作、场景、镜头运动、风格和负面约束。',
    enabled: true,
    scope: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

export type SkillStore = {
  listSkills(): Promise<TheaterSkill[]>;
  setEnabled(slug: string, enabled: boolean): Promise<TheaterSkill | undefined>;
  createSkill(input: { title: string; description: string; prompt: string }): Promise<TheaterSkill>;
};

export function createSkillStore(root: string): SkillStore {
  const dbPath = path.join(root, 'skills.json');

  async function readSkills(): Promise<TheaterSkill[]> {
    try {
      const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as TheaterSkill[];
      return persisted;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        await writeSkills(SYSTEM_SKILLS);
        return SYSTEM_SKILLS;
      }
      throw error;
    }
  }

  async function writeSkills(skills: TheaterSkill[]): Promise<void> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(skills, null, 2), 'utf8');
  }

  return {
    async listSkills() {
      return readSkills();
    },

    async setEnabled(slug, enabled) {
      const skills = await readSkills();
      const index = skills.findIndex((skill) => skill.slug === slug);
      if (index < 0) return undefined;
      const updated = { ...skills[index], enabled, updatedAt: new Date().toISOString() };
      skills[index] = updated;
      await writeSkills(skills);
      return updated;
    },

    async createSkill(input) {
      const skills = await readSkills();
      const now = new Date().toISOString();
      const baseSlug = slugifyPinyinFallback(input.title);
      let slug = baseSlug;
      let suffix = 2;
      while (skills.some((skill) => skill.slug === slug)) {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
      }
      const skill: TheaterSkill = {
        slug,
        title: input.title,
        description: input.description,
        prompt: input.prompt,
        enabled: true,
        scope: 'user',
        createdAt: now,
        updatedAt: now,
      };
      await writeSkills([...skills, skill]);
      return skill;
    },
  };
}

function slugifyPinyinFallback(value: string): string {
  const known: Record<string, string> = {
    冷: 'leng',
    开: 'kai',
    场: 'chang',
    生: 'sheng',
    成: 'cheng',
    器: 'qi',
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
