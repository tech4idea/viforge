import { describe, expect, it } from 'vitest';

import {
  GLOBAL_TREE,
  WORKSPACE_SECTIONS,
  buildDefaultCollapsedDirectoryPaths,
  buildCollapsedDirectoryPaths,
  buildDefaultCollapsedGlobalPaths,
  filterVisibleWorkspaceEntries,
  flattenGlobalWorkspaceTree,
  toggleCollapsedPath,
} from './workspace-tree';
import type { WorkspaceEntry } from './api';

describe('workspace tree navigation', () => {
  it('groups the sidebar into global and sitcom workspaces', () => {
    expect(WORKSPACE_SECTIONS.map((section) => section.title)).toEqual(['全局区域', '情景剧区域']);
    expect(GLOBAL_TREE.map((node) => node.name)).toEqual(['Agent 配置', '知识库', '模板库']);
  });

  it('flattens global workspace nodes with visible hierarchy depth', () => {
    const visibleNodes = flattenGlobalWorkspaceTree(GLOBAL_TREE, []);

    expect(visibleNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Agent 配置', depth: 0 }),
      expect.objectContaining({ path: 'Agent 配置/skills', depth: 1 }),
      expect.objectContaining({ path: 'Agent 配置/skills/人物设定技能', depth: 2 }),
      expect.objectContaining({ path: 'Agent 配置/skills/人物设定技能/SKILL.md', depth: 3 }),
      expect.objectContaining({ path: '知识库/编剧知识/情景剧结构参考.md', depth: 2 }),
    ]));
  });

  it('hides descendants of collapsed global directories', () => {
    const visibleNodes = flattenGlobalWorkspaceTree(GLOBAL_TREE, ['Agent 配置/skills']);

    expect(visibleNodes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Agent 配置/skills' })]));
    expect(visibleNodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Agent 配置/skills/人物设定技能' })]));
  });

  it('defaults global workspace directories to collapsed', () => {
    const collapsedPaths = buildDefaultCollapsedGlobalPaths(GLOBAL_TREE);
    const visibleNodes = flattenGlobalWorkspaceTree(GLOBAL_TREE, collapsedPaths);

    expect(collapsedPaths).toEqual(expect.arrayContaining(['Agent 配置', 'Agent 配置/skills', '知识库', '模板库']));
    expect(visibleNodes.map((node) => node.path)).toEqual(['Agent 配置', '知识库', '模板库']);
  });

  it('toggles collapsed paths deterministically', () => {
    expect(toggleCollapsedPath([], 'Agent 配置')).toEqual(['Agent 配置']);
    expect(toggleCollapsedPath(['Agent 配置', '知识库'], 'Agent 配置')).toEqual(['知识库']);
  });

  it('defaults project workspace directories to collapsed', () => {
    const entries: WorkspaceEntry[] = [
      { path: '01 基本设定', name: '01 基本设定', type: 'directory' },
      { path: '01 基本设定/项目简介.md', name: '项目简介.md', type: 'file' },
      { path: '02 故事', name: '02 故事', type: 'directory' },
      { path: '02 故事/01 第一集', name: '01 第一集', type: 'directory' },
      { path: '02 故事/01 第一集/单集大纲.md', name: '单集大纲.md', type: 'file' },
    ];

    const collapsedPaths = buildDefaultCollapsedDirectoryPaths(entries);

    expect(collapsedPaths).toEqual(['01 基本设定', '02 故事', '02 故事/01 第一集']);
    expect(filterVisibleWorkspaceEntries(entries, collapsedPaths).map((entry) => entry.path)).toEqual([
      '01 基本设定',
      '02 故事',
    ]);
  });

  it('can keep the selected file visible while collapsing unrelated directories', () => {
    const entries: WorkspaceEntry[] = [
      { path: '01 基本设定', name: '01 基本设定', type: 'directory' },
      { path: '01 基本设定/项目简介.md', name: '项目简介.md', type: 'file' },
      { path: '02 故事', name: '02 故事', type: 'directory' },
      { path: '02 故事/01 第一集', name: '01 第一集', type: 'directory' },
      { path: '02 故事/01 第一集/单集大纲.md', name: '单集大纲.md', type: 'file' },
    ];

    const collapsedPaths = buildCollapsedDirectoryPaths(entries, '02 故事/01 第一集/单集大纲.md');

    expect(collapsedPaths).toEqual(['01 基本设定']);
    expect(filterVisibleWorkspaceEntries(entries, collapsedPaths).map((entry) => entry.path)).toEqual([
      '01 基本设定',
      '02 故事',
      '02 故事/01 第一集',
      '02 故事/01 第一集/单集大纲.md',
    ]);
  });
});
