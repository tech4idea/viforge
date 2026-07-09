import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSkillsRoutes } from './skills';
import { createSkillStore } from '../skills/skillStore';

let root: string;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viforge-skills-'));
  app = new Hono().route('/api', createSkillsRoutes(createSkillStore({
    agentConfigSkillsRoot: path.join(root, 'agent-config-skills'),
  })));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skills routes', () => {
  it('lists skills from the global Agent config skills directory', async () => {
    await mkdir(path.join(root, 'agent-config-skills', 'gemini-api-dev'), { recursive: true });
    await writeFile(
      path.join(root, 'agent-config-skills', 'gemini-api-dev', 'SKILL.md'),
      [
        '---',
        'name: gemini-api-dev',
        'description: Use this skill for Gemini API application development.',
        '---',
        '',
        '# gemini-api-dev',
      ].join('\n'),
      'utf8',
    );

    const response = await app.request('/api/skills');

    expect(response.status).toBe(200);
    const skills = await response.json();
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: 'agent-config:gemini-api-dev',
        title: 'gemini-api-dev',
        source: 'agent-config',
        mutable: false,
        location: 'Agent 配置/skills/gemini-api-dev/SKILL.md',
      }),
    ]));
    expect(skills).toHaveLength(1);
  });

  it('does not toggle file-backed Agent config skills', async () => {
    const response = await app.request('/api/skills/agent-config%3Agemini-api-dev', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(404);
  });

  it('creates an Agent config skill in the skills directory', async () => {
    const response = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '原著分析助手',
        description: '根据原著片段提炼主题、人物关系和可改编场面。',
        prompt: '请分析这段原著，提炼主题、人物关系、关键场面和改编风险。',
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      slug: 'agent-config:yuan-zhu-fen-xi-zhu-shou',
      title: 'yuan-zhu-fen-xi-zhu-shou',
      enabled: true,
      scope: 'user',
      source: 'agent-config',
      location: 'Agent 配置/skills/yuan-zhu-fen-xi-zhu-shou/SKILL.md',
    });
    const listResponse = await app.request('/api/skills');
    await expect(listResponse.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'agent-config:yuan-zhu-fen-xi-zhu-shou' }),
    ]));
  });
});
