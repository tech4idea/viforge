import { GLOBAL_WORKSPACE_TREE, type WorkspaceTreeNode } from '@viwork/shared';
import type { WorkspaceEntry } from './api';

export type WorkspaceSection = {
  key: 'global' | 'adaptations';
  title: string;
  description: string;
};

export const WORKSPACE_SECTIONS: WorkspaceSection[] = [
  { key: 'global', title: '全局区域', description: '创作规范、技能、知识库与模板库' },
  { key: 'adaptations', title: '改编项目区域', description: '每个项目独立管理原著资料、改编方案、剧本、分镜、视频和产物' },
];

export const GLOBAL_TREE = GLOBAL_WORKSPACE_TREE;

export function buildDefaultCollapsedGlobalPaths(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type !== 'directory') {
      return [];
    }

    return [node.path, ...buildDefaultCollapsedGlobalPaths(node.children ?? [])];
  });
}

export function flattenGlobalWorkspaceTree(
  nodes: WorkspaceTreeNode[],
  collapsedPaths: string[],
  depth = 0,
): Array<WorkspaceTreeNode & { depth: number }> {
  return nodes.flatMap((node) => {
    const current = { ...node, depth };
    if (node.type === 'file' || collapsedPaths.includes(node.path)) {
      return [current];
    }

    return [current, ...flattenGlobalWorkspaceTree(node.children ?? [], collapsedPaths, depth + 1)];
  });
}

export function toggleCollapsedPath(currentPaths: string[], path: string): string[] {
  const collapsed = new Set(currentPaths);
  if (collapsed.has(path)) {
    collapsed.delete(path);
  } else {
    collapsed.add(path);
  }
  return [...collapsed];
}

export function buildDefaultCollapsedDirectoryPaths(entries: WorkspaceEntry[]): string[] {
  return entries.filter((entry) => entry.type === 'directory').map((entry) => entry.path);
}

export function buildCollapsedDirectoryPaths(entries: WorkspaceEntry[], revealPath?: string | null): string[] {
  const collapsedPaths = buildDefaultCollapsedDirectoryPaths(entries);
  if (!revealPath) {
    return collapsedPaths;
  }

  const visibleAncestors = new Set<string>();
  const parts = revealPath.split('/').filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    visibleAncestors.add(parts.slice(0, index).join('/'));
  }

  return collapsedPaths.filter((path) => !visibleAncestors.has(path));
}

export function filterVisibleWorkspaceEntries(entries: WorkspaceEntry[], collapsedDirectoryPaths: string[]): WorkspaceEntry[] {
  return entries.filter((entry) => {
    const parts = entry.path.split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join('/');
      if (collapsedDirectoryPaths.includes(ancestor)) {
        return false;
      }
    }
    return true;
  });
}
