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
  it('groups the sidebar into global and adaptation workspaces', () => {
    expect(WORKSPACE_SECTIONS.map((section) => section.title)).toEqual(['全局区域', '改编项目区域']);
    expect(GLOBAL_TREE.map((node) => node.name)).toEqual(['Agent 配置', '知识库', '模板库']);
  });

  it('flattens global workspace nodes with visible hierarchy depth', () => {
    const visibleNodes = flattenGlobalWorkspaceTree(GLOBAL_TREE, []);

    expect(visibleNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Agent 配置', depth: 0 }),
      expect.objectContaining({ path: 'Agent 配置/config.toml', depth: 1 }),
      expect.objectContaining({ path: '知识库/改编知识/小说改编原则.md', depth: 2 }),
    ]));
  });

  it('hides descendants of collapsed global directories', () => {
    const visibleNodes = flattenGlobalWorkspaceTree(GLOBAL_TREE, ['Agent 配置']);

    expect(visibleNodes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Agent 配置' })]));
    expect(visibleNodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Agent 配置/config.toml' })]));
  });

  it('defaults global workspace directories to collapsed', () => {
    const collapsedPaths = buildDefaultCollapsedGlobalPaths(GLOBAL_TREE);
    const visibleNodes = flattenGlobalWorkspaceTree(GLOBAL_TREE, collapsedPaths);

    expect(collapsedPaths).toEqual(expect.arrayContaining(['Agent 配置', '知识库', '模板库']));
    expect(visibleNodes.map((node) => node.path)).toEqual(['Agent 配置', '知识库', '模板库']);
  });

  it('toggles collapsed paths deterministically', () => {
    expect(toggleCollapsedPath([], 'Agent 配置')).toEqual(['Agent 配置']);
    expect(toggleCollapsedPath(['Agent 配置', '知识库'], 'Agent 配置')).toEqual(['知识库']);
  });

  it('defaults project workspace directories to collapsed', () => {
    const entries: WorkspaceEntry[] = [
      { path: '01 原著资料', name: '01 原著资料', type: 'directory' },
      { path: '01 原著资料/项目简介.md', name: '项目简介.md', type: 'file' },
      { path: '02 改编方案', name: '02 改编方案', type: 'directory' },
      { path: '02 改编方案/01 第一集', name: '01 第一集', type: 'directory' },
      { path: '02 改编方案/01 第一集/单集改编方案.md', name: '单集改编方案.md', type: 'file' },
    ];

    const collapsedPaths = buildDefaultCollapsedDirectoryPaths(entries);

    expect(collapsedPaths).toEqual(['01 原著资料', '02 改编方案', '02 改编方案/01 第一集']);
    expect(filterVisibleWorkspaceEntries(entries, collapsedPaths).map((entry) => entry.path)).toEqual([
      '01 原著资料',
      '02 改编方案',
    ]);
  });

  it('can keep the selected file visible while collapsing unrelated directories', () => {
    const entries: WorkspaceEntry[] = [
      { path: '01 原著资料', name: '01 原著资料', type: 'directory' },
      { path: '01 原著资料/项目简介.md', name: '项目简介.md', type: 'file' },
      { path: '02 改编方案', name: '02 改编方案', type: 'directory' },
      { path: '02 改编方案/01 第一集', name: '01 第一集', type: 'directory' },
      { path: '02 改编方案/01 第一集/单集改编方案.md', name: '单集改编方案.md', type: 'file' },
    ];

    const collapsedPaths = buildCollapsedDirectoryPaths(entries, '02 改编方案/01 第一集/单集改编方案.md');

    expect(collapsedPaths).toEqual(['01 原著资料']);
    expect(filterVisibleWorkspaceEntries(entries, collapsedPaths).map((entry) => entry.path)).toEqual([
      '01 原著资料',
      '02 改编方案',
      '02 改编方案/01 第一集',
      '02 改编方案/01 第一集/单集改编方案.md',
    ]);
  });
});
