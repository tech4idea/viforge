import { useCallback, useMemo, useState } from 'react';

export type PreviewWorkspaceScope = 'global' | 'project' | 'temporary';
export type MarkdownMode = 'source' | 'split' | 'preview';
export type PreviewTabCloseMode = 'left' | 'right' | 'others' | 'all';

export type PreviewTab = {
  id: string;
  workspaceScope: PreviewWorkspaceScope;
  projectId: string | null;
  path: string;
};

export type PreviewTabContextMenu = {
  x: number;
  y: number;
  tabId: string;
};

export type PreviewTabCloseAvailability = {
  canCloseLeft: boolean;
  canCloseRight: boolean;
  canCloseOthers: boolean;
  canCloseAll: boolean;
};

export function previewTabId(workspaceScope: PreviewWorkspaceScope, projectId: string | null, path: string): string {
  return `${workspaceScope}:${projectId ?? 'global'}:${path}`;
}

export function usePreviewTabs({
  activeWorkspaceScope,
  activeProjectWorkspaceId,
  selectedPath,
  selectWorkspacePath,
  clearWorkspaceSelection,
  maxTabs = 12,
}: {
  activeWorkspaceScope: PreviewWorkspaceScope;
  activeProjectWorkspaceId: string | null;
  selectedPath: string | null;
  selectWorkspacePath: (workspaceScope: PreviewWorkspaceScope, projectId: string | null, path: string) => void;
  clearWorkspaceSelection: (workspaceScope: PreviewWorkspaceScope) => void;
  maxTabs?: number;
}) {
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [markdownModesByTabId, setMarkdownModesByTabId] = useState<Record<string, MarkdownMode>>({});
  const [contextMenu, setContextMenu] = useState<PreviewTabContextMenu | null>(null);

  const selectedTabId = selectedPath ? previewTabId(activeWorkspaceScope, activeProjectWorkspaceId, selectedPath) : null;
  const selectedMarkdownMode = selectedTabId ? markdownModesByTabId[selectedTabId] ?? 'split' : 'split';

  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.workspaceScope === activeWorkspaceScope && tab.projectId === activeProjectWorkspaceId),
    [activeProjectWorkspaceId, activeWorkspaceScope, tabs],
  );

  const openTab = useCallback((workspaceScope: PreviewWorkspaceScope, projectId: string | null, path: string) => {
    const tab: PreviewTab = {
      id: previewTabId(workspaceScope, projectId, path),
      workspaceScope,
      projectId,
      path,
    };
    setTabs((current) => {
      if (current.some((item) => item.id === tab.id)) return current;
      return [...current, tab].slice(-maxTabs);
    });
  }, [maxTabs]);

  const selectTab = useCallback((tab: PreviewTab) => {
    selectWorkspacePath(tab.workspaceScope, tab.projectId, tab.path);
  }, [selectWorkspacePath]);

  const closeTab = useCallback((tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;

    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);

    if (selectedTabId === tabId) {
      const fallback = next[Math.max(0, index - 1)] ?? next[0] ?? null;
      if (fallback) {
        selectTab(fallback);
      } else {
        clearWorkspaceSelection(activeWorkspaceScope);
      }
    }
  }, [activeWorkspaceScope, clearWorkspaceSelection, selectTab, selectedTabId, tabs]);

  const closeTabsByMode = useCallback((tabId: string, mode: PreviewTabCloseMode) => {
    const scopedTabs = tabs.filter((tab) => tab.workspaceScope === activeWorkspaceScope && tab.projectId === activeProjectWorkspaceId);
    const targetIndex = scopedTabs.findIndex((tab) => tab.id === tabId);
    if (targetIndex === -1) return;

    const scopedIdsToClose = new Set(scopedTabs
      .filter((tab, index) => {
        if (mode === 'left') return index < targetIndex;
        if (mode === 'right') return index > targetIndex;
        if (mode === 'others') return tab.id !== tabId;
        return true;
      })
      .map((tab) => tab.id));
    const next = tabs.filter((tab) => !scopedIdsToClose.has(tab.id));

    setTabs(next);

    if (selectedTabId && scopedIdsToClose.has(selectedTabId)) {
      const fallback = next.find((tab) => tab.id === tabId) ?? next.find((tab) => tab.workspaceScope === activeWorkspaceScope && tab.projectId === activeProjectWorkspaceId) ?? null;
      if (fallback) {
        selectTab(fallback);
      } else {
        clearWorkspaceSelection(activeWorkspaceScope);
      }
    }
  }, [activeProjectWorkspaceId, activeWorkspaceScope, clearWorkspaceSelection, selectTab, selectedTabId, tabs]);

  const setSelectedMarkdownMode = useCallback((mode: MarkdownMode) => {
    if (!selectedTabId) return;
    setMarkdownModesByTabId((current) => ({ ...current, [selectedTabId]: mode }));
  }, [selectedTabId]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const getCloseAvailability = useCallback((tabId: string): PreviewTabCloseAvailability => {
    const targetIndex = visibleTabs.findIndex((tab) => tab.id === tabId);
    if (targetIndex === -1) {
      return { canCloseLeft: false, canCloseRight: false, canCloseOthers: false, canCloseAll: false };
    }
    const hasOtherTabs = visibleTabs.length > 1;
    return {
      canCloseLeft: targetIndex > 0,
      canCloseRight: targetIndex < visibleTabs.length - 1,
      canCloseOthers: hasOtherTabs,
      canCloseAll: visibleTabs.length > 0,
    };
  }, [visibleTabs]);

  return useMemo(() => ({
    tabs,
    visibleTabs,
    selectedTabId,
    selectedMarkdownMode,
    contextMenu,
    setContextMenu,
    closeContextMenu,
    openTab,
    selectTab,
    closeTab,
    closeTabsByMode,
    getCloseAvailability,
    setSelectedMarkdownMode,
  }), [
    closeContextMenu,
    closeTab,
    closeTabsByMode,
    contextMenu,
    getCloseAvailability,
    openTab,
    selectTab,
    selectedMarkdownMode,
    selectedTabId,
    setSelectedMarkdownMode,
    tabs,
    visibleTabs,
  ]);
}
