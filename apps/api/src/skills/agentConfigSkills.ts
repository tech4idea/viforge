import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { TheaterSkill } from '@viwork/shared';

const DEFAULT_AGENT_SKILL_NAMES = new Set([
  'brainstorm-agent',
  'source-analyst-agent',
  'adaptation-planner-agent',
  'screenwriter-agent',
  'reviewer-agent',
]);

export type AgentConfigSkillDefinition = {
  name: string;
  description: string;
  location: string;
  createdAt: string;
  updatedAt: string;
};

export async function listAgentConfigSkillDefinitions(skillsRoot: string): Promise<AgentConfigSkillDefinition[]> {
  const entries = await safeReaddir(skillsRoot);
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
        try {
          const [content, metadata] = await Promise.all([
            readFile(skillPath, 'utf8'),
            stat(skillPath),
          ]);
          const frontmatter = readYamlFrontmatter(content);
          const name = parseFrontmatterScalar(frontmatter, 'name') ?? entry.name;
          const description = (
            parseFrontmatterScalar(frontmatter, 'description') ??
            `Agent skill: ${name}.`
          ).trim();

          return {
            name,
            description,
            location: `Agent 配置/skills/${entry.name}/SKILL.md`,
            createdAt: metadata.birthtime.toISOString(),
            updatedAt: metadata.mtime.toISOString(),
          } satisfies AgentConfigSkillDefinition;
        } catch {
          return null;
        }
      }),
  );

  return skills
    .filter((skill): skill is AgentConfigSkillDefinition => skill !== null)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
}

export function toTheaterSkill(skill: AgentConfigSkillDefinition): TheaterSkill {
  return {
    slug: `agent-config:${skill.name}`,
    title: skill.name,
    description: skill.description,
    prompt: '',
    enabled: true,
    scope: DEFAULT_AGENT_SKILL_NAMES.has(skill.name) ? 'system' : 'user',
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    source: 'agent-config',
    mutable: false,
    location: skill.location,
  };
}

export function isDefaultAgentSkill(name: string): boolean {
  return DEFAULT_AGENT_SKILL_NAMES.has(name);
}

async function safeReaddir(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function readYamlFrontmatter(content: string): string {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? '';
}

function parseFrontmatterScalar(frontmatter: string, key: string): string | null {
  if (!frontmatter) {
    return null;
  }

  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, 'm'));
  if (!match) {
    return null;
  }

  return normalizeYamlScalar(match[1]);
}

function normalizeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
