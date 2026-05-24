import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSkillsRoutes } from './skills';
import { createSkillStore } from '../skills/skillStore';

let root: string;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-skills-'));
  app = new Hono().route('/api', createSkillsRoutes(createSkillStore(root)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skills routes', () => {
  it('lists theater creation skills', async () => {
    const response = await app.request('/api/skills');

    expect(response.status).toBe(200);
    const skills = await response.json();
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'character-bio', title: '角色小传', enabled: true }),
      expect.objectContaining({ slug: 'conflict-pass', title: '冲突强化', enabled: true }),
      expect.objectContaining({ slug: 'storyboard-breakdown', title: '分镜拆解', enabled: true }),
      expect.objectContaining({ slug: 'video-prompt', title: '视频提示词', enabled: true }),
    ]));
  });

  it('toggles a theater skill', async () => {
    const response = await app.request('/api/skills/conflict-pass', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ slug: 'conflict-pass', enabled: false });

    const listResponse = await app.request('/api/skills');
    const skills = await listResponse.json();
    expect(skills.find((skill: { slug: string }) => skill.slug === 'conflict-pass')).toMatchObject({ enabled: false });
  });

  it('creates a custom prompt skill for sitcom writing', async () => {
    const response = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '冷开场生成器',
        description: '根据本集主题写一个 30 秒冷开场。',
        prompt: '请生成一个短促、有反转的情景剧冷开场。',
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      slug: 'leng-kai-chang-sheng-cheng-qi',
      title: '冷开场生成器',
      enabled: true,
      scope: 'user',
    });
  });
});
