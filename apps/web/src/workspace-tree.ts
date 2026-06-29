import type { WorkspaceTreeNode } from '@viwork/shared';
import type { WorkspaceEntry } from './api';
import { ACTIVE_PRODUCT_PROFILE } from './product-profile';

export type WorkspaceSection = {
  key: 'global' | 'adaptations';
  title: string;
  description: string;
};

export const WORKSPACE_SECTIONS: WorkspaceSection[] = [
  { key: 'global', ...ACTIVE_PRODUCT_PROFILE.workspaceSections.global },
  { key: 'adaptations', title: ACTIVE_PRODUCT_PROFILE.workspaceSections.project.title, description: ACTIVE_PRODUCT_PROFILE.workspaceSections.project.description },
];

const HIDDEN_GLOBAL_PATHS = ['Agent 配置'];

export const GLOBAL_TREE = ACTIVE_PRODUCT_PROFILE.globalTree.filter((node) => !isHiddenGlobalPath(node.path));

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

export function filterVisibleGlobalWorkspaceEntries(entries: WorkspaceEntry[], collapsedDirectoryPaths: string[]): WorkspaceEntry[] {
  return filterVisibleWorkspaceEntries(
    entries.filter((entry) => !isHiddenGlobalPath(entry.path)),
    collapsedDirectoryPaths,
  );
}

function isHiddenGlobalPath(entryPath: string): boolean {
  return HIDDEN_GLOBAL_PATHS.some((hiddenPath) => entryPath === hiddenPath || entryPath.startsWith(`${hiddenPath}/`));
}
