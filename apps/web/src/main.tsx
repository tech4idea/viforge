import {
  Fragment,
  StrictMode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  apiClient,
  resolveApiUrl,
  type AigcHubModelMetadata,
  type AgentRun,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatSession,
  type GeminiImageAspectRatio,
  type BrowserConnectorStatus,
  type GeminiImageThinkingLevel,
  type ImageGenerationReferenceImage,
  type Project,
  type ReferencedChatSnippet,
  type ReferencedFile,
  type ReleaseInfo,
  type RuntimeConfig,
  type UpdateRuntimeConfigInput,
  type RunEvent,
  type ScheduledTask,
  type StreamEvent,
  type WechatSetupSession,
  type WechatStatus,
  type WorkspaceEntry,
} from './api';
import { AssistantStreamBody, streamEventsFromRunEvents } from './assistant-stream';
import { buildReferenceSuggestions, getActiveReferenceQuery, insertReference, type FileReference, type ReferenceSuggestion } from './chat-references';
import { renderEditorViewer } from './viewer-components';
import {
  WORKSPACE_SECTIONS,
  buildCollapsedDirectoryPaths,
  filterVisibleGlobalWorkspaceEntries,
  filterVisibleWorkspaceEntries,
  toggleCollapsedPath,
} from './workspace-tree';
import { ACTIVE_PRODUCT_PROFILE, SELECTABLE_PRODUCT_PROFILES } from './product-profile';
import { ActivityRail, type ThemeMode as RailThemeMode } from './components/ActivityRail';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConnectorsPanel } from './components/ConnectorsPanel';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { EditorHeader } from './components/EditorHeader';
import { GitSyncPanel } from './components/GitSyncPanel';
import { HarnessPanel } from './components/HarnessPanel';
import {
  ArrowDown,
  Braces,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Edit3,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderUp,
  Globe,
  Hash,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Type,
  Upload,
  X,
} from './components/icons';
import { usePreviewTabs } from './usePreviewTabs';
import './styles.css';

const DEFAULT_PROJECT_NAME = ACTIVE_PRODUCT_PROFILE.defaultProjectName;
const DEFAULT_PROJECT_DESCRIPTION = ACTIVE_PRODUCT_PROFILE.defaultProjectDescription;
const TEXT_FILE_PATTERN = /\.(md|markdown|txt|toml|json|js|jsx|ts|tsx|css|html|pug|csv|yml|yaml)$/i;
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|webp|svg)$/i;
const PDF_FILE_PATTERN = /\.pdf$/i;
const HTML_FILE_PATTERN = /\.html?$/i;
const SIDEBAR_CONTEXT_MENU_WIDTH = 168;
const SIDEBAR_CONTEXT_MENU_MAX_HEIGHT = 260;
const VIEWPORT_EDGE_GAP = 8;
const WORKSPACE_PANEL_MIN_WIDTH = 180;
const WORKSPACE_PANEL_MAX_WIDTH = 420;
const CHAT_PANEL_MIN_WIDTH = 240;
const CHAT_PANEL_FALLBACK_MAX_WIDTH = 960;
const DEFAULT_WORKSPACE_PANEL_WIDTH = 238;
const CHAT_READING_MODE_STORAGE_KEY = 'viforge.chatReadingMode.v1';
const SELECTED_PROJECT_STORAGE_KEY = 'viforge.selectedProjectId.v1';
const TEMPORARY_CHAT_SESSION_STORAGE_KEY = 'viforge.temporaryChatSession.v1';
const CHAT_SCOPE_STORAGE_KEY = 'viforge.chatScope.v1';
const WORKSPACE_SELECTION_STORAGE_KEY = 'viforge.workspaceSelection.v1';
const ACTIVE_CHAT_SESSION_STORAGE_KEY = 'viforge.activeChatSession.v1';
const PANEL_VISIBILITY_STORAGE_KEY = 'viforge.panelVisibility.v1';
const THEME_MODE_STORAGE_KEY = 'viforge.themeMode.v1';
const TEMPORARY_CHAT_SCOPE_ID = '__temporary__';
const CHAT_MODEL_STORAGE_KEY = 'viforge.chatModel.v1';
const IMAGE_MODEL_STORAGE_KEY = 'viforge.imageModel.v1';
const RUN_NOTIFY_STORAGE_KEY = 'viforge.runNotify.v1';
const QUEUED_ASSISTANT_MESSAGE = '排队中，等待当前会话上一条任务完成...';

declare global {
  interface Window {
    viforgeDesktop?: {
      selectDataRoot(): Promise<{
        canceled: boolean;
        dataRoot?: string;
        restartRequired?: boolean;
      }>;
      getAppVersion(): Promise<string>;
    };
  }
}

type RunNotifyMode = 'off' | 'sound' | 'wechat' | 'both';
type RunStreamBinding = {
  runId: string;
  sessionId: string;
  messageId: string;
  projectId: string;
};

function readStoredRunNotifyMode(): RunNotifyMode {
  try {
    const raw = localStorage.getItem(RUN_NOTIFY_STORAGE_KEY);
    if (raw === 'sound' || raw === 'wechat' || raw === 'both' || raw === 'off') return raw;
  } catch { /* noop */ }
  return 'off';
}

function writeStoredRunNotifyMode(mode: RunNotifyMode): void {
  try { localStorage.setItem(RUN_NOTIFY_STORAGE_KEY, mode); } catch { /* noop */ }
}

function playNotificationSound(): void {
  try {
    const ctx = new AudioContext();

    function play() {
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.value = 587;
      gain1.gain.setValueAtTime(0.3, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc1.connect(gain1).connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.3);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = 880;
      gain2.gain.setValueAtTime(0, now + 0.15);
      gain2.gain.linearRampToValueAtTime(0.3, now + 0.2);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      osc2.connect(gain2).connect(ctx.destination);
      osc2.start(now + 0.15);
      osc2.stop(now + 0.6);

      setTimeout(() => void ctx.close(), 1000);
    }

    if (ctx.state === 'suspended') {
      void ctx.resume().then(play);
    } else {
      play();
    }
  } catch { /* audio not available */ }
}

type LoadState = 'idle' | 'loading' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type RunState = 'idle' | 'queued' | 'running' | 'success' | 'error';
type ChatMode = 'assistant' | 'image';
type ChatScope = 'project' | 'temporary';
type WorkspaceScope = 'global' | 'project' | 'temporary';
type ChatSessionView = 'active' | 'archived';
type ThemeMode = 'light' | 'dark' | 'soft';
type WorkspaceTarget = { workspaceScope: WorkspaceScope; projectId: string | null; parentPath: string };
type ChatSessionsUpdate = ChatSession[] | ((currentSessions: ChatSession[]) => ChatSession[]);
type PendingChatMessageUpdate = { sessionId: string; messageId: string; message: ChatMessage };
type ChatMessageTextSelectionHandler = (event: React.MouseEvent, message: ChatMessage) => void;

function isHarnessStandaloneRoute(): boolean {
  return new URLSearchParams(window.location.search).get('tool') === 'harness';
}

function openHarnessStandalone(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('tool', 'harness');
  url.hash = '';
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
}

type ImageReferenceDraft = ImageGenerationReferenceImage & {
  id: string;
};

type ImageThinkingLevelOption = 'default' | GeminiImageThinkingLevel;

type StoredWorkspaceSelection = {
  activeWorkspaceScope: WorkspaceScope;
  selectedProjectPath: string | null;
  selectedGlobalPath: string | null;
  selectedTemporaryProjectId: string | null;
  selectedTemporaryPath: string | null;
};

type StoredActiveChatSession = {
  projectSessionIds: Record<string, string>;
  temporarySessionId: string | null;
  chatSessionView: ChatSessionView;
};

type SidebarContextMenu = {
  x: number;
  y: number;
  workspaceScope: WorkspaceScope;
  projectId: string | null;
  entryPath: string | null;
  entryType: WorkspaceEntry['type'] | null;
};

type ChatSessionContextMenu = {
  x: number;
  y: number;
  sessionId: string;
  title?: string;
};

type SelectedTextContextMenu = {
  x: number;
  y: number;
  text: string;
} & (
  | { source: 'file'; sourcePath: string }
  | { source: 'chat'; messageId: string; role: ChatMessage['role']; label: string; createdAt: string }
);

type CreateEntryDraft = {
  workspaceScope: WorkspaceScope;
  projectId: string | null;
  parentPath: string;
  kind: 'folder' | 'file';
  name: string;
};

type RenameEntryDraft = {
  workspaceScope: WorkspaceScope;
  projectId: string | null;
  entryPath: string;
  originalName: string;
  name: string;
};

type DragEntryDraft = {
  workspaceScope: WorkspaceScope;
  projectId: string | null;
  entryPath: string;
  entryType: WorkspaceEntry['type'];
};

function App() {
  const fileUploadRef = useRef<HTMLInputElement | null>(null);
  const folderUploadRef = useRef<HTMLInputElement | null>(null);
  const imageReferenceInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatThreadRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const workspaceGridRef = useRef<HTMLElement | null>(null);
  const chatMessagePersistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingChatMessageUpdatesRef = useRef<Map<string, PendingChatMessageUpdate>>(new Map());
  const chatMessageUpdateFlushScheduledRef = useRef(false);
  const createEntryInputRef = useRef<HTMLInputElement | null>(null);
  const skipCreateEntryBlurRef = useRef(false);
  const renameEntryInputRef = useRef<HTMLInputElement | null>(null);
  const skipRenameEntryBlurRef = useRef(false);
  const suppressNextShellClickRef = useRef(false);
  const streamBatchRef = useRef<Map<string, { sessionId: string; messageId: string; runProjectId: string; events: StreamEvent[] }>>(new Map());
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeStreamCloseRef = useRef<(() => void) | null>(null);
  const streamCloseByRunIdRef = useRef<Map<string, () => void>>(new Map());
  const activeRunIdRef = useRef<string | null>(null);
  const runStreamBindingRef = useRef<RunStreamBinding | null>(null);
  const runStreamBindingsRef = useRef<Map<string, RunStreamBinding>>(new Map());
  const seenRunStreamEventsRef = useRef<Map<string, Set<string>>>(new Map());
  const initState = useMemo(() => readInitialStoredState(), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initState.selectedProjectId);
  const [temporaryProjectId, setTemporaryProjectId] = useState<string | null>(initState.selectedTemporaryProjectId);
  const [projectLoadState, setProjectLoadState] = useState<LoadState>('idle');
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);

  useEffect(() => {
    document.title = ACTIVE_PRODUCT_PROFILE.documentTitle || 'ViForge';
  }, []);

  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [entriesProjectId, setEntriesProjectId] = useState<string | null>(null);
  const [entriesState, setEntriesState] = useState<LoadState>('idle');
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [globalEntries, setGlobalEntries] = useState<WorkspaceEntry[]>([]);
  const [globalEntriesState, setGlobalEntriesState] = useState<LoadState>('idle');
  const [globalEntriesError, setGlobalEntriesError] = useState<string | null>(null);
  const [temporaryEntriesByProject, setTemporaryEntriesByProject] = useState<Record<string, WorkspaceEntry[]>>({});
  const [temporaryEntriesStateByProject, setTemporaryEntriesStateByProject] = useState<Record<string, LoadState>>({});
  const [temporaryEntriesErrorByProject, setTemporaryEntriesErrorByProject] = useState<Record<string, string | null>>({});

  const [activeWorkspaceScope, setActiveWorkspaceScope] = useState<WorkspaceScope>(initState.activeWorkspaceScope);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(initState.selectedProjectPath);
  const [selectedGlobalPath, setSelectedGlobalPath] = useState<string | null>(initState.selectedGlobalPath);
  const [selectedTemporaryProjectId, setSelectedTemporaryProjectId] = useState<string | null>(initState.selectedTemporaryProjectId);
  const [selectedTemporaryPath, setSelectedTemporaryPath] = useState<string | null>(initState.selectedTemporaryPath);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedProjectPathRef = useRef(selectedProjectPath);
  const selectedTemporaryProjectIdRef = useRef(selectedTemporaryProjectId);
  const selectedTemporaryPathRef = useRef(selectedTemporaryPath);
  selectedProjectIdRef.current = selectedProjectId;
  selectedProjectPathRef.current = selectedProjectPath;
  selectedTemporaryProjectIdRef.current = selectedTemporaryProjectId;
  selectedTemporaryPathRef.current = selectedTemporaryPath;
  const [fileContent, setFileContent] = useState('');
  const [lastSavedContent, setLastSavedContent] = useState('');
  const [fileState, setFileState] = useState<LoadState>('idle');
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [runState, setRunState] = useState<RunState>('idle');
  const [runError, setRunError] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<AgentRun | null>(null);
  const [referencedFiles, setReferencedFiles] = useState<FileReference[]>([]);
  const [referencedSnippets, setReferencedSnippets] = useState<ReferencedChatSnippet[]>([]);
  const [referenceSuggestions, setReferenceSuggestions] = useState<ReferenceSuggestion[]>([]);
  const [referenceQuery, setReferenceQuery] = useState<{ start: number; end: number; query: string } | null>(null);
  const [activeReferenceIndex, setActiveReferenceIndex] = useState(0);
  const [chatReadingMode, setChatReadingMode] = useState(initState.chatReadingMode);
  const [runNotifyMode, setRunNotifyMode] = useState<RunNotifyMode>(readStoredRunNotifyMode());
  const [chatMode, setChatMode] = useState<ChatMode>('assistant');
  const [aigcHubModels, setAigcHubModels] = useState<AigcHubModelMetadata[]>([]);
  const [aigcHubModelError, setAigcHubModelError] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState(initState.chatModel);
  const [imageModel, setImageModel] = useState(initState.imageModel);
  const [imageAspectRatio, setImageAspectRatio] = useState<GeminiImageAspectRatio>('1:1');
  const [imageThinkingLevel, setImageThinkingLevel] = useState<ImageThinkingLevelOption>('default');
  const [imageCount, setImageCount] = useState(1);
  const [imageReferenceDrafts, setImageReferenceDrafts] = useState<ImageReferenceDraft[]>([]);
  const [chatSessions, setChatSessionsState] = useState<ChatSession[]>([]);
  const chatSessionsRef = useRef<ChatSession[]>([]);
  const [scheduledTasksBySession, setScheduledTasksBySession] = useState<Record<string, ScheduledTask[]>>({});
  const [scheduledTaskState, setScheduledTaskState] = useState<LoadState>('idle');
  const [scheduledTaskBusyId, setScheduledTaskBusyId] = useState<string | null>(null);
  const [scheduleOverviewOpen, setScheduleOverviewOpen] = useState(false);
  const [chatScope, setChatScope] = useState<ChatScope>(initState.chatScope);
  const [chatSessionsProjectId, setChatSessionsProjectId] = useState<string | null>(null);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(initState.activeChatSessionId);
  const [chatSessionView, setChatSessionView] = useState<ChatSessionView>(initState.chatSessionView);
  const [collapsedPanels, setCollapsedPanels] = useState({ workspace: false, editor: false, chat: false });
  const [sidebarOpen, setSidebarOpen] = useState(initState.sidebarOpen);
  const [chatPanelOpen, setChatPanelOpen] = useState(initState.chatPanelOpen);
  const [editorPanelOpen, setEditorPanelOpen] = useState(initState.editorPanelOpen);
  const [panelWidths, setPanelWidths] = useState(() => initialPanelWidths());
  const [themeMode, setThemeMode] = useState<ThemeMode>(initState.themeMode);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: 'info' | 'success' | 'error' }>>([]);
  const toastIdRef = useRef(0);

  const showToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  type ConfirmDialogState = {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    promptMode?: boolean;
    promptPlaceholder?: string;
    promptInitialValue?: string;
    requireMatch?: string;
    onConfirm: (value?: string) => void;
    onCancel: () => void;
  };
  const [confirmDialogState, setConfirmDialogState] = useState<ConfirmDialogState | null>(null);
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [createProjectDraft, setCreateProjectDraft] = useState(() => ({
    productId: ACTIVE_PRODUCT_PROFILE.id,
    name: ACTIVE_PRODUCT_PROFILE.defaultProjectName,
    description: ACTIVE_PRODUCT_PROFILE.defaultProjectDescription,
  }));

  function showConfirm(options: { title: string; message: string; danger?: boolean; confirmLabel?: string }): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmDialogState({
        title: options.title,
        message: options.message,
        danger: options.danger,
        confirmLabel: options.confirmLabel ?? '确认',
        onConfirm: () => { setConfirmDialogState(null); resolve(true); },
        onCancel: () => { setConfirmDialogState(null); resolve(false); },
      });
    });
  }

  function showPrompt(options: { title: string; message?: string; placeholder?: string; initialValue?: string; requireMatch?: string; confirmLabel?: string }): Promise<string | null> {
    return new Promise((resolve) => {
      setConfirmDialogState({
        title: options.title,
        message: options.message,
        promptMode: true,
        promptPlaceholder: options.placeholder,
        promptInitialValue: options.initialValue ?? '',
        requireMatch: options.requireMatch,
        confirmLabel: options.confirmLabel ?? '确认',
        onConfirm: (value) => { setConfirmDialogState(null); resolve(value ?? null); },
        onCancel: () => { setConfirmDialogState(null); resolve(null); },
      });
    });
  }

  const [temporaryWorkspaceCollapsed, setTemporaryWorkspaceCollapsed] = useState(true);
  const [collapsedGlobalPaths, setCollapsedGlobalPaths] = useState<string[]>([]);
  const [collapsedDirectoriesByProject, setCollapsedDirectoriesByProject] = useState<Record<string, string[]>>({});
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(new Set());
  const [collapsedTemporarySessionIds, setCollapsedTemporarySessionIds] = useState<string[]>([]);
  const [collapsedDirectoriesByTemporaryProject, setCollapsedDirectoriesByTemporaryProject] = useState<Record<string, string[]>>({});
  const [activeToolPanel, setActiveToolPanel] = useState<'connectors' | 'git' | 'harness' | 'settings' | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [runtimeConfigState, setRuntimeConfigState] = useState<LoadState>('idle');
  const [sidebarContextMenu, setSidebarContextMenu] = useState<SidebarContextMenu | null>(null);
  const [chatSessionContextMenu, setChatSessionContextMenu] = useState<ChatSessionContextMenu | null>(null);
  const [selectedTextContextMenu, setSelectedTextContextMenu] = useState<SelectedTextContextMenu | null>(null);
  const [createEntryDraft, setCreateEntryDraft] = useState<CreateEntryDraft | null>(null);
  const [renameEntryDraft, setRenameEntryDraft] = useState<RenameEntryDraft | null>(null);
  const createEntryFocusKey = createEntryDraft
    ? `${createEntryDraft.workspaceScope}:${createEntryDraft.projectId ?? ''}:${createEntryDraft.parentPath}:${createEntryDraft.kind}`
    : null;
  const renameEntryFocusKey = renameEntryDraft
    ? `${renameEntryDraft.workspaceScope}:${renameEntryDraft.projectId ?? ''}:${renameEntryDraft.entryPath}`
    : null;
  const [quickActionError, setQuickActionError] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<WorkspaceTarget | null>(null);
  const [uploadMode, setUploadMode] = useState<'files' | 'folder'>('files');
  const [uploadState, setUploadState] = useState<'idle' | 'uploading'>('idle');
  const [dragEntry, setDragEntry] = useState<DragEntryDraft | null>(null);
  const [dragOverTargetKey, setDragOverTargetKey] = useState<string | null>(null);
  const [wechatStatus, setWechatStatus] = useState<WechatStatus | null>(null);
  const [wechatSetup, setWechatSetup] = useState<WechatSetupSession | null>(null);
  const [wechatState, setWechatState] = useState<LoadState>('idle');
  const [browserStatus, setBrowserStatus] = useState<BrowserConnectorStatus | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const activeProjectWorkspaceId = activeWorkspaceScope === 'project'
    ? selectedProjectId
    : activeWorkspaceScope === 'temporary'
      ? selectedTemporaryProjectId
      : null;
  const activeEntries = activeWorkspaceScope === 'global'
    ? globalEntries
    : activeWorkspaceScope === 'temporary' && selectedTemporaryProjectId
      ? temporaryEntriesByProject[selectedTemporaryProjectId] ?? []
      : selectedProjectId && entriesProjectId === selectedProjectId
        ? entries
        : [];
  const selectedPath = activeWorkspaceScope === 'global'
    ? selectedGlobalPath
    : activeWorkspaceScope === 'temporary'
      ? selectedTemporaryPath
      : selectedProjectPath;
  const selectedEntry = useMemo(
    () => activeEntries.find((entry) => entry.path === selectedPath) ?? null,
    [activeEntries, selectedPath],
  );
  const isTextFile = selectedEntry?.type === 'file' && isSupportedTextFile(selectedEntry.path);
  const isImageFile = selectedEntry?.type === 'file' && IMAGE_FILE_PATTERN.test(selectedEntry.path);
  const isPdfFile = selectedEntry?.type === 'file' && PDF_FILE_PATTERN.test(selectedEntry.path);
  const isHtmlFile = selectedEntry?.type === 'file' && HTML_FILE_PATTERN.test(selectedEntry.path);
  const rawPreviewUrl = selectedPath
    ? activeWorkspaceScope === 'global'
      ? resolveApiUrl(`/api/global/raw/${encodeWorkspacePath(selectedPath)}`)
      : activeProjectWorkspaceId
        ? resolveApiUrl(`/api/projects/${encodeURIComponent(activeProjectWorkspaceId)}/raw/${encodeWorkspacePath(selectedPath)}`)
        : ''
    : '';
  const hasUnsavedChanges = isTextFile && fileContent !== lastSavedContent;
  const selectWorkspacePath = useCallback((workspaceScope: WorkspaceScope, projectId: string | null, path: string) => {
    setActiveWorkspaceScope(workspaceScope);
    if (workspaceScope === 'global') {
      setSelectedGlobalPath(path);
      return;
    }
    if (workspaceScope === 'temporary') {
      setSelectedTemporaryProjectId(projectId);
      setSelectedTemporaryPath(path);
      return;
    }
    if (projectId) setSelectedProjectId(projectId);
    setSelectedProjectPath(path);
  }, []);

  const clearWorkspaceSelection = useCallback((workspaceScope: WorkspaceScope) => {
    if (workspaceScope === 'global') {
      setSelectedGlobalPath(null);
    } else if (workspaceScope === 'temporary') {
      setSelectedTemporaryPath(null);
    } else {
      setSelectedProjectPath(null);
    }
  }, []);

  const previewTabs = usePreviewTabs({
    activeWorkspaceScope,
    activeProjectWorkspaceId,
    selectedPath,
    selectWorkspacePath,
    clearWorkspaceSelection,
  });

  const selectEntryForPreview = useCallback((workspaceScope: WorkspaceScope, projectId: string | null, entry: WorkspaceEntry) => {
    selectWorkspacePath(workspaceScope, projectId, entry.path);
    if (entry.type === 'file') {
      setEditorPanelOpen(true);
      previewTabs.openTab(workspaceScope, projectId, entry.path);
    }
  }, [previewTabs, selectWorkspacePath]);

  const navigateToMarkdownReference = useCallback((path: string) => {
    const targetEntry = activeEntries.find((entry) => entry.type === 'file' && entry.path === path);
    if (!targetEntry) {
      showToast(`未找到引用文件：${path}`, 'error');
      return;
    }
    selectEntryForPreview(activeWorkspaceScope, activeProjectWorkspaceId, targetEntry);
  }, [activeEntries, activeProjectWorkspaceId, activeWorkspaceScope, selectEntryForPreview, showToast]);
  const projectChatSessions = useMemo(
    () =>
      chatSessions
        .filter((session) => isSessionInActiveChatMode(session, chatMode, chatScope, selectedProjectId) && !session.archivedAt)
        .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt)),
    [chatMode, chatScope, chatSessions, selectedProjectId],
  );
  const archivedChatSessions = useMemo(
    () =>
      chatSessions
        .filter((session) => isSessionInActiveChatMode(session, chatMode, chatScope, selectedProjectId) && session.archivedAt)
        .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt)),
    [chatMode, chatScope, chatSessions, selectedProjectId],
  );
  const displayedChatSessions = chatSessionView === 'archived' ? archivedChatSessions : projectChatSessions;
  const activeChatSession = useMemo(
    () =>
      displayedChatSessions.find((session) => session.id === activeChatSessionId) ??
      displayedChatSessions[0] ??
      null,
    [activeChatSessionId, displayedChatSessions],
  );
  const activeChatLastMessage = activeChatSession?.messages[activeChatSession.messages.length - 1] ?? null;
  const activeChatSessionArchived = Boolean(activeChatSession?.archivedAt);
  const activeChatSessionRunning = Boolean(activeChatSession && hasRunningAssistantMessage(activeChatSession));
  const activeChatSessionQueuedCount = activeChatSession ? countQueuedAssistantMessages(activeChatSession) : 0;
  const allScheduledTasks = useMemo(
    () => {
      const allowedSessionIds = new Set(
        chatSessions
          .filter((session) => selectedProjectId ? session.projectId === selectedProjectId : session.id === activeChatSession?.id)
          .map((session) => session.id),
      );
      return Object.entries(scheduledTasksBySession)
        .filter(([sessionId]) => allowedSessionIds.has(sessionId))
        .flatMap(([, tasks]) => tasks)
        .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
    },
    [activeChatSession?.id, chatSessions, scheduledTasksBySession, selectedProjectId],
  );
  const visibleEntries = useMemo(
    () => filterVisibleWorkspaceEntries(selectedProjectId && entriesProjectId === selectedProjectId ? entries : [], collapsedDirectoriesByProject[selectedProjectId ?? ''] ?? []),
    [collapsedDirectoriesByProject, entries, entriesProjectId, selectedProjectId],
  );
  const visibleGlobalEntries = useMemo(
    () => filterVisibleGlobalWorkspaceEntries(globalEntries, collapsedGlobalPaths),
    [collapsedGlobalPaths, globalEntries],
  );
  const temporaryChatSessions = useMemo(
    () =>
      chatSessions
        .filter((session) => isTemporaryProjectId(session.projectId))
        .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt)),
    [chatSessions],
  );
  const selectedProjectFiles = useMemo(
    () => activeWorkspaceScope === 'project' && selectedProjectId && entriesProjectId === selectedProjectId ? entries.filter((entry) => entry.type === 'file') : [],
    [activeWorkspaceScope, entries, entriesProjectId, selectedProjectId],
  );
  const activeChatScopeName = chatScope === 'project' && selectedProject ? selectedProject.name : '临时工作目录';
  const chatModelOptions = useMemo(() => modelsForCapability(aigcHubModels, 'chat'), [aigcHubModels]);
  const imageModelOptions = useMemo(() => modelsForCapability(aigcHubModels, 'image'), [aigcHubModels]);
  const embeddingModelOptions = useMemo(() => modelsForCapability(aigcHubModels, 'embedding'), [aigcHubModels]);
  const handleChatTextSelection = useCallback<ChatMessageTextSelectionHandler>((event, message) => {
    const selectedText = getSelectedTextFromEvent(event).trim();
    if (!selectedText) {
      return;
    }

    if (event.type === 'contextmenu') {
      event.preventDefault();
    }
    event.stopPropagation();
    setSidebarContextMenu(null);
    setChatSessionContextMenu(null);
    previewTabs.closeContextMenu();
    const menuX = Math.min(event.clientX, window.innerWidth - SIDEBAR_CONTEXT_MENU_WIDTH - VIEWPORT_EDGE_GAP);
    const menuY = Math.min(event.clientY, window.innerHeight - 90 - VIEWPORT_EDGE_GAP);
    setSelectedTextContextMenu({
      x: Math.max(VIEWPORT_EDGE_GAP, menuX),
      y: Math.max(VIEWPORT_EDGE_GAP, menuY),
      text: selectedText.slice(0, 2000),
      source: 'chat',
      messageId: message.id,
      role: message.role,
      label: `${message.role === 'user' ? '你' : '创作助手'}片段`,
      createdAt: message.createdAt,
    });
  }, [previewTabs]);

  useEffect(() => {
    if (!selectedPath || !previewTabs.selectedTabId) return;
    const selectedTabIsVisible = previewTabs.visibleTabs.some((tab) => tab.id === previewTabs.selectedTabId);
    if (!selectedTabIsVisible) return;
    const selectedEntryStillExists = activeEntries.some((entry) => entry.type === 'file' && entry.path === selectedPath);
    if (selectedEntryStillExists) return;
    const fallback = previewTabs.visibleTabs.find((tab) => tab.id !== previewTabs.selectedTabId) ?? null;
    if (fallback) {
      selectWorkspacePath(fallback.workspaceScope, fallback.projectId, fallback.path);
      return;
    }
    if (activeWorkspaceScope === 'global') {
      setSelectedGlobalPath(null);
    } else if (activeWorkspaceScope === 'temporary') {
      setSelectedTemporaryPath(null);
    } else {
      setSelectedProjectPath(null);
    }
  }, [activeEntries, activeWorkspaceScope, previewTabs.selectedTabId, previewTabs.visibleTabs, selectWorkspacePath, selectedPath]);

  const openAttachmentFnRef = useRef<(attachment: ChatMessageAttachment) => void>(() => {});
  openAttachmentFnRef.current = (attachment: ChatMessageAttachment) => {
    setEditorPanelOpen(true);
    if (isTemporaryProjectId(attachment.projectId)) {
      setActiveWorkspaceScope('temporary');
      setSelectedTemporaryProjectId(attachment.projectId);
      setSelectedTemporaryPath(attachment.path);
      void loadTemporaryEntries(attachment.projectId, { keepSelectedPath: attachment.path, revealPath: attachment.path });
    } else {
      setActiveWorkspaceScope('project');
      setSelectedProjectId(attachment.projectId);
      setSelectedProjectPath(attachment.path);
      void loadEntries(attachment.projectId, { keepSelectedPath: attachment.path, revealPath: attachment.path });
    }
  };
  const handleOpenChatAttachment = useCallback(
    (attachment: ChatMessageAttachment) => openAttachmentFnRef.current(attachment),
    [],
  );

  function setChatSessions(update: ChatSessionsUpdate) {
    const nextSessions = typeof update === 'function' ? update(chatSessionsRef.current) : update;
    chatSessionsRef.current = nextSessions;
    setChatSessionsState(nextSessions);
  }

  function switchChatScope(nextScope: ChatScope) {
    if (nextScope === 'project' && !selectedProjectId) {
      return;
    }

    setChatScope(nextScope);
    setChatSessionView('active');
    closeReferenceMenu();

    if (nextScope === 'temporary') {
      setReferencedFiles([]);
      const stored = readStoredActiveChatSession();
      const nextSession = pickPreferredChatSession(
        chatSessionsRef.current.filter((session) => isTemporaryProjectId(session.projectId) && getSessionKind(session) === 'assistant'),
        stored.temporarySessionId,
        chatSessionView,
      );
      if (nextSession) {
        setChatSessionView(nextSession.archivedAt ? 'archived' : 'active');
      }
      setActiveChatSessionId(nextSession?.id ?? null);
      if (chatSessionsProjectId !== TEMPORARY_CHAT_SCOPE_ID) {
        void loadTemporaryChatSessions({ activate: true });
      }
      return;
    }

    const stored = readStoredActiveChatSession();
    const nextSession = selectedProjectId
      ? pickPreferredChatSession(
        chatSessionsRef.current.filter((session) => session.projectId === selectedProjectId && getSessionKind(session) === 'assistant'),
        stored.projectSessionIds[selectedProjectId] ?? null,
        chatSessionView,
      )
      : null;
    if (nextSession) {
      setChatSessionView(nextSession.archivedAt ? 'archived' : 'active');
    }
    setActiveChatSessionId(nextSession?.id ?? null);
    if (selectedProjectId && chatSessionsProjectId !== selectedProjectId) {
      void loadProjectChatSessions(selectedProjectId);
    }
  }

  useEffect(() => {
    void loadProjects();
    void loadGlobalEntries();
    void loadTemporaryChatSessions({ activate: false });
    void loadAigcHubModels();
  }, []);

  useEffect(() => () => {
    if (streamFlushTimerRef.current) clearTimeout(streamFlushTimerRef.current);
  }, []);

  useEffect(() => {
    writeStoredModel(CHAT_MODEL_STORAGE_KEY, chatModel);
  }, [chatModel]);

  useEffect(() => {
    writeStoredModel(IMAGE_MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  useEffect(() => {
    writeStoredChatReadingMode(chatReadingMode);
  }, [chatReadingMode]);

  useEffect(() => {
    writeStoredRunNotifyMode(runNotifyMode);
  }, [runNotifyMode]);

  useEffect(() => {
    if (!activeChatSession || getSessionKind(activeChatSession) !== 'assistant') {
      setScheduledTaskState('idle');
      return;
    }
    void loadScheduledTasks(activeChatSession.id);
  }, [activeChatSession?.id]);

  useEffect(() => {
    if (!activeChatSession || getSessionKind(activeChatSession) !== 'assistant') return;
    const pendingMessages = activeChatSession.messages
      .filter((message) => message.role === 'assistant' && (message.status === 'running' || message.status === 'queued') && message.runId);

    for (const message of pendingMessages) {
      if (!message.runId || streamCloseByRunIdRef.current.has(message.runId)) continue;
      attachRunStream({
        runId: message.runId,
        sessionId: activeChatSession.id,
        messageId: message.id,
        projectId: activeChatSession.projectId,
      });
    }
  }, [activeChatSession?.id, activeChatSession?.messages]);

  useEffect(() => {
    writeStoredThemeMode(themeMode);
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode === 'dark' ? 'dark' : 'light';
  }, [themeMode]);

  const saveFileRef = useRef(saveFile);
  saveFileRef.current = saveFile;

  const saveShortcutRef = useRef({ selectedPath, isTextFile, fileContent, lastSavedContent });
  saveShortcutRef.current = { selectedPath, isTextFile, fileContent, lastSavedContent };

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }

      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        setChatPanelOpen((v) => !v);
        return;
      }

      if (event.key === '.' || event.key === '>') {
        event.preventDefault();
        setEditorPanelOpen((v) => !v);
        return;
      }

      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        event.stopPropagation();
        const { selectedPath: sp, isTextFile: itf, fileContent: fc, lastSavedContent: lsc } = saveShortcutRef.current;
        if (sp && itf && fc !== lsc) {
          void saveFileRef.current().then(() => {
            showToast('文件已保存', 'success');
          }).catch(() => {
            showToast('保存失败', 'error');
          });
        }
        return;
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [showToast]);

  useEffect(() => {
    writeStoredSelectedProjectId(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    writeStoredChatScope(chatScope);
  }, [chatScope]);

  useEffect(() => {
    writeStoredWorkspaceSelection({
      activeWorkspaceScope,
      selectedProjectPath,
      selectedGlobalPath,
      selectedTemporaryProjectId,
      selectedTemporaryPath,
    });
  }, [activeWorkspaceScope, selectedGlobalPath, selectedProjectPath, selectedTemporaryPath, selectedTemporaryProjectId]);

  useEffect(() => {
    writeStoredActiveChatSessionView(chatSessionView);
  }, [chatSessionView]);

  useEffect(() => {
    writeStoredPanelVisibility({ sidebarOpen, editorPanelOpen, chatPanelOpen });
  }, [chatPanelOpen, editorPanelOpen, sidebarOpen]);

  useEffect(() => {
    if (!activeChatSessionId) {
      return;
    }

    if (chatScope === 'project' && selectedProjectId) {
      writeStoredProjectActiveChatSession(selectedProjectId, activeChatSessionId);
      return;
    }

    if (chatScope === 'temporary') {
      writeStoredTemporaryActiveChatSession(activeChatSessionId);
      const session = chatSessions.find((item) => item.id === activeChatSessionId && isTemporaryProjectId(item.projectId));
      if (session) {
        writeStoredTemporaryChatSession({ projectId: session.projectId, sessionId: session.id });
      }
    }
  }, [activeChatSessionId, chatScope, chatSessions, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId && chatScope === 'project') {
      setChatScope('temporary');
    }
  }, [chatScope, selectedProjectId]);

  useEffect(() => {
    if (activeWorkspaceScope === 'project' && !selectedProjectId) {
      setActiveWorkspaceScope('temporary');
    }
  }, [activeWorkspaceScope, selectedProjectId, selectedTemporaryProjectId]);

  useEffect(() => {
    if (!createEntryDraft) return;
    requestAnimationFrame(() => {
      createEntryInputRef.current?.focus();
      createEntryInputRef.current?.select();
    });
  }, [createEntryFocusKey]);

  useEffect(() => {
    if (!renameEntryDraft) return;
    requestAnimationFrame(() => {
      renameEntryInputRef.current?.focus();
      renameEntryInputRef.current?.select();
    });
  }, [renameEntryFocusKey]);

  useEffect(() => {
    if (activeToolPanel === 'connectors') {
      void loadWechatStatus();
      void loadBrowserStatus();
    }
    if (activeToolPanel === 'settings') {
      void loadReleaseInfo();
      void loadRuntimeConfig();
    }
  }, [activeToolPanel]);

  useEffect(() => {
    if (activeToolPanel !== 'connectors' || !wechatSetup || wechatStatus?.state === 'connected') return;
    const timer = window.setInterval(() => {
      void loadWechatStatus();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeToolPanel, wechatSetup?.sessionId, wechatStatus?.state]);

  useEffect(() => {
    if (!selectedProjectId) {
      setEntries([]);
      setEntriesProjectId(null);
      setSelectedProjectPath(null);
      return;
    }

    void loadEntries(selectedProjectId, {
      keepSelectedPath: selectedProjectPath,
      revealPath: selectedProjectPath,
      selectFirstTextFile: true,
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (activeWorkspaceScope !== 'temporary' || !selectedTemporaryProjectId) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(temporaryEntriesByProject, selectedTemporaryProjectId)) {
      return;
    }

    void loadTemporaryEntries(selectedTemporaryProjectId, {
      keepSelectedPath: selectedTemporaryPath,
      revealPath: selectedTemporaryPath,
    });
  }, [activeWorkspaceScope, selectedTemporaryPath, selectedTemporaryProjectId, temporaryEntriesByProject]);

  useEffect(() => {
    if (!selectedProjectId) {
      setReferencedFiles([]);
      setReferencedSnippets([]);
      closeReferenceMenu();
      return;
    }

    if (chatMode === 'assistant' && chatScope === 'project' && chatSessionsProjectId !== selectedProjectId) {
      void loadProjectChatSessions(selectedProjectId);
    }
  }, [chatMode, chatScope, chatSessionsProjectId, selectedProjectId]);

  useEffect(() => {
    if (chatScope !== 'temporary' || chatSessionsProjectId === TEMPORARY_CHAT_SCOPE_ID) {
      return;
    }

    void loadTemporaryChatSessions({ activate: true });
  }, [chatScope, chatSessionsProjectId]);

  useEffect(() => {
    if (chatMode !== 'assistant' || chatScope !== 'project' || chatSessionView !== 'active' || !selectedProjectId || chatSessionsProjectId !== selectedProjectId) {
      return;
    }

    const existingSession = projectChatSessions[0] ?? null;
    if (existingSession) {
      setActiveChatSessionId((currentId) =>
        currentId && projectChatSessions.some((session) => session.id === currentId)
          ? currentId
          : existingSession.id,
      );
      return;
    }

    void createAndActivateChatSession(selectedProjectId);
  }, [chatMode, chatScope, chatSessionView, chatSessionsProjectId, projectChatSessions, selectedProjectId]);

  useEffect(() => {
    if (!selectedEntry || selectedEntry.type !== 'file') {
      setFileContent('');
      setLastSavedContent('');
      setFileState('idle');
      setFileError(null);
      setSaveState('idle');
      setSaveError(null);
      return;
    }

    if (!isSupportedTextFile(selectedEntry.path)) {
      setFileContent('');
      setLastSavedContent('');
      setFileState('idle');
      setFileError(null);
      setSaveState('idle');
      setSaveError(null);
      return;
    }

    if (activeWorkspaceScope === 'global') {
      void loadGlobalFile(selectedEntry.path);
      return;
    }

    if (activeProjectWorkspaceId) {
      void loadFile(activeProjectWorkspaceId, selectedEntry.path);
    }
  }, [activeProjectWorkspaceId, activeWorkspaceScope, selectedEntry?.path, selectedEntry?.type]);

  useEffect(() => {
    if (!selectedEntry || selectedEntry.type !== 'file' || !selectedPath) return;
    previewTabs.openTab(activeWorkspaceScope, activeProjectWorkspaceId, selectedPath);
  }, [activeProjectWorkspaceId, activeWorkspaceScope, previewTabs, selectedEntry?.path, selectedEntry?.type, selectedPath]);

  useEffect(() => {
    setReferencedFiles([]);
    setReferencedSnippets([]);
    setPrompt('');
    closeReferenceMenu();
  }, [activeChatSessionId]);

  useEffect(() => {
    autoScrollRef.current = true;
    setShowScrollBottom(false);

    const thread = chatThreadRef.current;
    if (!thread) return;

    const frame = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeChatSession?.id]);

  useEffect(() => {
    if (!autoScrollRef.current) {
      return;
    }

    const thread = chatThreadRef.current;
    if (!thread) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeChatSession?.id,
    activeChatSession?.messages.length,
    activeChatLastMessage?.content,
  ]);

  useEffect(() => {
    const el = chatThreadRef.current;
    if (!el) return;

    let ticking = false;
    const scrollEl = el;
    function handleScroll() {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
          const atBottom = distanceFromBottom < 32;
          autoScrollRef.current = atBottom;
          setShowScrollBottom(distanceFromBottom > 80);
          ticking = false;
        });
        ticking = true;
      }
    }

    handleScroll();
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [activeChatSession?.id, chatPanelOpen]);
  async function loadProjects() {
    setProjectLoadState('loading');
    setProjectLoadError(null);

    try {
      const loadedProjects = await apiClient.listProjects();
      setProjects(loadedProjects);
      setSelectedProjectId((currentId) => {
        if (currentId && loadedProjects.some((project) => project.id === currentId)) {
          return currentId;
        }

        const storedProjectId = readStoredSelectedProjectId();
        if (storedProjectId && loadedProjects.some((project) => project.id === storedProjectId)) {
          return storedProjectId;
        }

        return null;
      });
      setProjectLoadState('idle');
    } catch (error) {
      setProjectLoadState('error');
      setProjectLoadError(errorToMessage(error));
    }
  }

  async function loadAigcHubModels() {
    try {
      const response = await apiClient.listAigcHubModels();
      setAigcHubModels(response.models);
      setAigcHubModelError(response.error ?? null);
      setChatModel((current) => current || preferredModelId(response.models, 'chat') || response.models[0]?.id || '');
      setImageModel((current) => current || preferredModelId(response.models, 'image') || response.models[0]?.id || '');
    } catch (error) {
      setAigcHubModelError(errorToMessage(error));
    }
  }

  async function loadRuntimeConfig() {
    setRuntimeConfigState('loading');
    try {
      const config = await apiClient.getRuntimeConfig();
      setRuntimeConfig(config);
      setRuntimeConfigState('idle');
    } catch (error) {
      setRuntimeConfigState('error');
      showToast(`读取运行设置失败：${errorToMessage(error)}`, 'error');
    }
  }

  async function loadReleaseInfo() {
    try {
      setReleaseInfo(await apiClient.getReleaseInfo());
    } catch (error) {
      showToast(`读取版本信息失败：${errorToMessage(error)}`, 'error');
    }
  }

  async function saveRuntimeConfig(input: UpdateRuntimeConfigInput) {
    setRuntimeConfigState('loading');
    try {
      const config = await apiClient.updateRuntimeConfig(input);
      setRuntimeConfig(config);
      setRuntimeConfigState('idle');
      showToast('运行设置已保存', 'success');
      await loadAigcHubModels();
    } catch (error) {
      setRuntimeConfigState('error');
      showToast(`保存运行设置失败：${errorToMessage(error)}`, 'error');
    }
  }

  async function loadGlobalEntries(options: { selectFirstTextFile?: boolean; keepSelectedPath?: string | null; revealPath?: string | null } = {}) {
    setGlobalEntriesState('loading');
    setGlobalEntriesError(null);

    try {
      const loadedEntries = await apiClient.listGlobalWorkspaceEntries();
      setGlobalEntries(loadedEntries);

      const preferredPath = options.keepSelectedPath ?? selectedGlobalPath;
      const preferredEntry = preferredPath ? loadedEntries.find((entry) => entry.path === preferredPath) : null;
      if (preferredEntry) {
        setSelectedGlobalPath(preferredEntry.path);
      } else if (options.selectFirstTextFile) {
        setSelectedGlobalPath(loadedEntries.find((entry) => entry.type === 'file' && isSupportedTextFile(entry.path))?.path ?? null);
      }

      setCollapsedGlobalPaths(buildCollapsedDirectoryPaths(loadedEntries, options.revealPath ?? preferredEntry?.path ?? null));
      setGlobalEntriesState('idle');
    } catch (error) {
      setGlobalEntriesState('error');
      setGlobalEntriesError(errorToMessage(error));
    }
  }

  async function loadProjectChatSessions(projectId: string) {
    try {
      const sessions = await apiClient.listChatSessions(projectId, { includeArchived: true });
      setChatSessions((currentSessions) => [
        ...currentSessions.filter((session) => session.projectId !== projectId),
        ...sessions,
      ]);
      setChatSessionsProjectId(projectId);
      const preferredSession = pickPreferredChatSession(sessions, null, chatSessionView);
      if (preferredSession) {
        setChatSessionView(preferredSession.archivedAt ? 'archived' : 'active');
      }
      setActiveChatSessionId(preferredSession?.id ?? null);
    } catch (error) {
      setRunError(errorToMessage(error));
      setChatSessionsProjectId(projectId);
    }
  }

  async function loadTemporaryChatSessions(options: { activate?: boolean } = {}) {
    try {
      const existingTemporarySessionIds = new Set(
        chatSessionsRef.current.filter((session) => isTemporaryProjectId(session.projectId)).map((session) => session.id),
      );
      const sessions = await apiClient.listTemporaryChatSessions({ includeArchived: true });
      setChatSessions((currentSessions) => [
        ...currentSessions.filter((session) => !isTemporaryProjectId(session.projectId)),
        ...sessions,
      ]);
      setCollapsedTemporarySessionIds((current) => [
        ...new Set([
          ...current,
          ...sessions
            .filter((session) => !existingTemporarySessionIds.has(session.id))
            .map((session) => session.id),
        ]),
      ]);

      const storedWorkspace = readStoredWorkspaceSelection();
      const storedTemporary = readStoredTemporaryChatSession();
      const storedActive = readStoredActiveChatSession();
      const storedSessionId = storedActive.temporarySessionId ?? storedTemporary?.sessionId ?? null;
      const modeSessions = sessions.filter((session) => getSessionKind(session) === chatMode);
      const preferredSession = pickPreferredChatSession(modeSessions, null, chatSessionView);

      if (!options.activate) {
        const latestSession = preferredSession ?? pickPreferredChatSession(modeSessions, null, 'active') ?? pickPreferredChatSession(sessions, null, 'active');
        if (latestSession) {
          setTemporaryProjectId(latestSession.projectId);
        }
        const selectedTemporarySession = storedWorkspace?.selectedTemporaryProjectId
          ? sessions.find((session) => session.projectId === storedWorkspace.selectedTemporaryProjectId) ?? null
          : null;
        const projectToRestore = selectedTemporarySession?.projectId ?? latestSession?.projectId ?? null;
        if (activeWorkspaceScope === 'temporary' && projectToRestore) {
          setSelectedTemporaryProjectId(projectToRestore);
          void loadTemporaryEntries(projectToRestore, {
            keepSelectedPath: projectToRestore === storedWorkspace?.selectedTemporaryProjectId ? storedWorkspace.selectedTemporaryPath : null,
            revealPath: projectToRestore === storedWorkspace?.selectedTemporaryProjectId ? storedWorkspace.selectedTemporaryPath : null,
          });
        }
        return;
      }

      const activeSession = preferredSession;
      setChatSessionsProjectId(TEMPORARY_CHAT_SCOPE_ID);

      if (activeSession) {
        setChatSessionView(activeSession.archivedAt ? 'archived' : 'active');
        setTemporaryProjectId(activeSession.projectId);
        setSelectedTemporaryProjectId((currentId) => currentId ?? activeSession.projectId);
        setActiveChatSessionId(activeSession.id);
        writeStoredTemporaryChatSession({ projectId: activeSession.projectId, sessionId: activeSession.id });
        return;
      }

      setTemporaryProjectId(null);
      setActiveChatSessionId(null);
      clearStoredTemporaryChatSession();
    } catch (error) {
      setRunError(errorToMessage(error));
      if (options.activate) {
        setChatSessionsProjectId(TEMPORARY_CHAT_SCOPE_ID);
      }
    }
  }

  async function createAndActivateChatSession(projectId: string): Promise<ChatSession | null> {
    try {
      const session = await apiClient.createChatSession(projectId);
      setChatSessions((currentSessions) => [session, ...currentSessions.filter((current) => current.id !== session.id)]);
      setActiveChatSessionId(session.id);
      return session;
    } catch (error) {
      setRunError(errorToMessage(error));
      return null;
    }
  }

  async function createProjectFromContext() {
    setCreateProjectDraft({
      productId: ACTIVE_PRODUCT_PROFILE.id,
      name: ACTIVE_PRODUCT_PROFILE.defaultProjectName,
      description: ACTIVE_PRODUCT_PROFILE.defaultProjectDescription,
    });
    setCreateProjectError(null);
    setCreateProjectDialogOpen(true);
  }

  async function submitCreateProjectDialog() {
    const selectedProfile = SELECTABLE_PRODUCT_PROFILES.find((profile) => profile.id === createProjectDraft.productId) ?? ACTIVE_PRODUCT_PROFILE;
    const name = createProjectDraft.name.trim();
    if (!name) return;

    setIsCreatingProject(true);
    setCreateProjectError(null);
    try {
      const project = await apiClient.createProject({
        name,
        description: createProjectDraft.description.trim(),
        productId: selectedProfile.id,
      });
      setProjects((currentProjects) => [project, ...currentProjects.filter((item) => item.id !== project.id)]);
      setSelectedProjectId(project.id);
      setCreateProjectDialogOpen(false);
    } catch (error) {
      setCreateProjectError(errorToMessage(error));
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function renameProjectFromContext(context: SidebarContextMenu | null) {
    const projectId = context?.projectId;
    if (!projectId) return;
    const current = projects.find((project) => project.id === projectId);
    if (!current) return;
    const nextName = await showPrompt({ title: '重命名项目', placeholder: current.name, initialValue: current.name, confirmLabel: '保存' });
    if (!nextName?.trim() || nextName.trim() === current.name) return;
    setQuickActionError(null);
    try {
      const updated = await apiClient.updateProject(projectId, { name: nextName.trim() });
      setProjects((currentProjects) => currentProjects.map((project) => (project.id === updated.id ? updated : project)));
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  async function deleteProjectFromContext(context: SidebarContextMenu | null) {
    const projectId = context?.projectId;
    if (!projectId) return;
    const current = projects.find((project) => project.id === projectId);
    if (!current) return;
    const firstConfirm = await showConfirm({
      title: `删除项目「${current.name}」`,
      message: '项目目录及其中的所有文件、聊天记录都将被永久删除，且无法恢复。',
      danger: true,
      confirmLabel: '继续删除',
    });
    if (!firstConfirm) return;
    const typed = await showPrompt({ title: '二次确认', message: `请输入项目名「${current.name}」以完成删除`, requireMatch: current.name, confirmLabel: '确认删除' });
    if (typed === null) return;
    if (typed !== current.name) {
      setQuickActionError('项目名不匹配，已取消删除。');
      return;
    }
    setQuickActionError(null);
    try {
      await apiClient.deleteProject(projectId);
      setProjects((currentProjects) => currentProjects.filter((project) => project.id !== projectId));
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setEntries([]);
        setEntriesProjectId(null);
        setSelectedProjectPath(null);
      }
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  async function loadEntries(projectId: string, options: { selectFirstTextFile?: boolean; keepSelectedPath?: string | null; revealPath?: string | null } = {}) {
    setEntriesState('loading');
    setEntriesError(null);

    try {
      const loadedEntries = await apiClient.listWorkspaceEntries(projectId);
      setEntries(loadedEntries);
      setEntriesProjectId(projectId);

      const preferredPath = options.keepSelectedPath ?? selectedProjectPath;
      const preferredEntry = preferredPath ? loadedEntries.find((entry) => entry.path === preferredPath) : null;
      if (preferredEntry) {
        setSelectedProjectPath(preferredEntry.path);
      } else if (options.selectFirstTextFile) {
        setSelectedProjectPath(loadedEntries.find((entry) => entry.type === 'file' && isSupportedTextFile(entry.path))?.path ?? null);
      }

      setCollapsedDirectoriesByProject((current) => ({
        ...current,
        [projectId]: buildCollapsedDirectoryPaths(loadedEntries, options.revealPath ?? preferredEntry?.path ?? null),
      }));
      setEntriesState('idle');
    } catch (error) {
      setEntriesState('error');
      setEntriesError(errorToMessage(error));
    }
  }

  async function loadTemporaryEntries(projectId: string, options: { keepSelectedPath?: string | null; revealPath?: string | null } = {}) {
    setTemporaryEntriesStateByProject((current) => ({ ...current, [projectId]: 'loading' }));
    setTemporaryEntriesErrorByProject((current) => ({ ...current, [projectId]: null }));

    try {
      const loadedEntries = await apiClient.listWorkspaceEntries(projectId);
      setTemporaryEntriesByProject((current) => ({ ...current, [projectId]: loadedEntries }));

      const preferredPath = options.keepSelectedPath ?? (selectedTemporaryProjectId === projectId ? selectedTemporaryPath : null);
      const preferredEntry = preferredPath ? loadedEntries.find((entry) => entry.path === preferredPath) : null;
      if (preferredEntry) {
        setSelectedTemporaryProjectId(projectId);
        setSelectedTemporaryPath(preferredEntry.path);
      }

      setCollapsedDirectoriesByTemporaryProject((current) => ({
        ...current,
        [projectId]: buildCollapsedDirectoryPaths(loadedEntries, options.revealPath ?? preferredEntry?.path ?? null),
      }));
      setTemporaryEntriesStateByProject((current) => ({ ...current, [projectId]: 'idle' }));
    } catch (error) {
      setTemporaryEntriesStateByProject((current) => ({ ...current, [projectId]: 'error' }));
      setTemporaryEntriesErrorByProject((current) => ({ ...current, [projectId]: errorToMessage(error) }));
    }
  }

  async function loadFile(projectId: string, path: string) {
    setFileState('loading');
    setFileError(null);
    setSaveState('idle');
    setSaveError(null);
    setFileContent('');
    setLastSavedContent('');

    try {
      const file = await apiClient.readWorkspaceFile(projectId, path);
      setFileContent(file.content);
      setLastSavedContent(file.content);
      setFileState('idle');
    } catch (error) {
      setFileState('error');
      setFileError(errorToMessage(error));
    }
  }

  async function loadGlobalFile(path: string) {
    setFileState('loading');
    setFileError(null);
    setSaveState('idle');
    setSaveError(null);
    setFileContent('');
    setLastSavedContent('');

    try {
      const file = await apiClient.readGlobalWorkspaceFile(path);
      setFileContent(file.content);
      setLastSavedContent(file.content);
      setFileState('idle');
    } catch (error) {
      setFileState('error');
      setFileError(errorToMessage(error));
    }
  }

  async function saveFile() {
    if (!selectedPath || !isTextFile) {
      return;
    }

    setSaveState('saving');
    setSaveError(null);

    try {
      if (activeWorkspaceScope === 'global') {
        const savedFile = await apiClient.writeGlobalWorkspaceFile(selectedPath, fileContent);
        setLastSavedContent(savedFile.content);
        setSaveState('saved');
        await loadGlobalEntries({ keepSelectedPath: selectedPath, revealPath: selectedPath });
        return;
      }

      if (!activeProjectWorkspaceId) {
        return;
      }

      const savedFile = await apiClient.writeWorkspaceFile(activeProjectWorkspaceId, selectedPath, fileContent);
      setLastSavedContent(savedFile.content);
      setSaveState('saved');
      if (activeWorkspaceScope === 'temporary') {
        await loadTemporaryEntries(activeProjectWorkspaceId, { keepSelectedPath: selectedPath, revealPath: selectedPath });
      } else {
        await loadEntries(activeProjectWorkspaceId, { keepSelectedPath: selectedPath, revealPath: selectedPath });
      }
    } catch (error) {
      setSaveState('error');
      setSaveError(errorToMessage(error));
    }
  }

  async function createDraftEntry(draft: CreateEntryDraft) {
    const name = draft.name.trim();
    if (!name) {
      setCreateEntryDraft(null);
      return;
    }

    if (name.includes('/') || name.includes('\\')) {
      setQuickActionError('请输入名称，不要输入完整路径。');
      return;
    }

    const entryPath = joinWorkspacePath(draft.parentPath, name);
    setQuickActionError(null);
    try {
      if (draft.workspaceScope === 'global') {
        if (draft.kind === 'folder') {
          await apiClient.createGlobalFolder(entryPath);
        } else {
          await apiClient.createGlobalFile(entryPath, `# ${entryTitleFromPath(entryPath)}\n`);
        }
        setCreateEntryDraft(null);
        await loadGlobalEntries({ keepSelectedPath: entryPath, revealPath: entryPath });
        return;
      }

      if (!draft.projectId) return;
      if (draft.kind === 'folder') {
        await apiClient.createFolder(draft.projectId, entryPath);
      } else {
        await apiClient.createFile(draft.projectId, entryPath, `# ${entryTitleFromPath(entryPath)}\n`);
      }
      setCreateEntryDraft(null);
      if (draft.workspaceScope === 'temporary') {
        setSelectedTemporaryProjectId(draft.projectId);
        await loadTemporaryEntries(draft.projectId, { keepSelectedPath: entryPath, revealPath: entryPath });
      } else {
        await loadEntries(draft.projectId, { keepSelectedPath: entryPath, revealPath: entryPath });
      }
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  async function moveSelectedEntry(targetPath: string) {
    if (!selectedPath || !targetPath.trim()) return;
    setQuickActionError(null);
    try {
      if (activeWorkspaceScope === 'global') {
        const moved = await apiClient.moveGlobalEntry(selectedPath, targetPath.trim());
        await loadGlobalEntries({ keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedGlobalPath(moved.path);
        return;
      }

      if (!activeProjectWorkspaceId) return;
      const moved = await apiClient.moveEntry(activeProjectWorkspaceId, selectedPath, targetPath.trim());
      if (activeWorkspaceScope === 'temporary') {
        await loadTemporaryEntries(activeProjectWorkspaceId, { keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedTemporaryPath(moved.path);
      } else {
        await loadEntries(activeProjectWorkspaceId, { keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedProjectPath(moved.path);
      }
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  async function moveEntryToDirectory(entry: DragEntryDraft, target: WorkspaceTarget) {
    if (entry.workspaceScope !== target.workspaceScope || entry.projectId !== target.projectId) {
      setQuickActionError('只能在同一个工作区内移动文件。');
      return;
    }

    if (entry.entryType === 'directory' && (target.parentPath === entry.entryPath || target.parentPath.startsWith(`${entry.entryPath}/`))) {
      setQuickActionError('不能把目录移动到自身或子目录中。');
      return;
    }

    const targetPath = joinWorkspacePath(target.parentPath, basename(entry.entryPath));
    if (targetPath === entry.entryPath) {
      return;
    }

    setQuickActionError(null);
    try {
      if (entry.workspaceScope === 'global') {
        const moved = await apiClient.moveGlobalEntry(entry.entryPath, targetPath);
        await loadGlobalEntries({ keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedGlobalPath(moved.path);
        return;
      }

      if (!entry.projectId) return;
      const moved = await apiClient.moveEntry(entry.projectId, entry.entryPath, targetPath);
      if (entry.workspaceScope === 'temporary') {
        await loadTemporaryEntries(entry.projectId, { keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedTemporaryProjectId(entry.projectId);
        setSelectedTemporaryPath(moved.path);
      } else {
        await loadEntries(entry.projectId, { keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedProjectPath(moved.path);
      }
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  async function renameDraftEntry(draft: RenameEntryDraft) {
    const name = draft.name.trim();
    if (!name || name === draft.originalName) {
      setRenameEntryDraft(null);
      return;
    }

    if (name.includes('/') || name.includes('\\')) {
      setQuickActionError('请输入名称，不要输入完整路径。');
      return;
    }

    const targetPath = joinWorkspacePath(parentDirectory(draft.entryPath), name);
    setQuickActionError(null);
    try {
      if (draft.workspaceScope === 'global') {
        const moved = await apiClient.moveGlobalEntry(draft.entryPath, targetPath);
        setRenameEntryDraft(null);
        await loadGlobalEntries({ keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedGlobalPath(moved.path);
        return;
      }

      if (!draft.projectId) return;
      const moved = await apiClient.moveEntry(draft.projectId, draft.entryPath, targetPath);
      setRenameEntryDraft(null);
      if (draft.workspaceScope === 'temporary') {
        await loadTemporaryEntries(draft.projectId, { keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedTemporaryProjectId(draft.projectId);
        setSelectedTemporaryPath(moved.path);
      } else {
        await loadEntries(draft.projectId, { keepSelectedPath: moved.path, revealPath: moved.path });
        setSelectedProjectPath(moved.path);
      }
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  async function deleteSelectedEntry() {
    if (!selectedPath) return;
    setQuickActionError(null);
    try {
      if (activeWorkspaceScope === 'global') {
        await apiClient.deleteGlobalEntry(selectedPath);
        setSelectedGlobalPath(null);
        await loadGlobalEntries({ selectFirstTextFile: true });
        return;
      }

      if (!activeProjectWorkspaceId) return;
      await apiClient.deleteEntry(activeProjectWorkspaceId, selectedPath);
      if (activeWorkspaceScope === 'temporary') {
        setSelectedTemporaryPath(null);
        await loadTemporaryEntries(activeProjectWorkspaceId);
      } else {
        setSelectedProjectPath(null);
        await loadEntries(activeProjectWorkspaceId, { selectFirstTextFile: true });
      }
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  function resolveUploadTarget(context: SidebarContextMenu | null = null) {
    const workspaceScope = context?.workspaceScope ?? activeWorkspaceScope;
    const projectId = workspaceScope === 'global'
      ? null
      : context?.projectId ?? (workspaceScope === 'temporary' ? selectedTemporaryProjectId : selectedProjectId);
    const contextPath = context?.entryPath ?? selectedPath;
    const contextType = context?.entryPath ? context.entryType : selectedEntry?.type ?? null;
    const parentPath = contextType === 'directory'
      ? contextPath ?? ''
      : contextPath
        ? parentDirectory(contextPath)
        : '';
    return { workspaceScope, projectId, parentPath };
  }

  function startUpload(context: SidebarContextMenu | null = null, mode: 'files' | 'folder' = 'files') {
    const target = resolveUploadTarget(context);
    flushSync(() => {
      setUploadTarget(target);
      setUploadMode(mode);
      setQuickActionError(null);
      setActiveWorkspaceScope(target.workspaceScope);
      if (target.workspaceScope === 'project' && target.projectId) {
        setSelectedProjectId(target.projectId);
      }
      if (target.workspaceScope === 'temporary' && target.projectId) {
        setSelectedTemporaryProjectId(target.projectId);
      }
    });
    const ref = mode === 'folder' ? folderUploadRef.current : fileUploadRef.current;
    ref?.click();
  }

  async function uploadAssets(files: File[]) {
    if (files.length === 0) {
      setUploadTarget(null);
      setUploadMode('files');
      return;
    }
    setUploadState('uploading');
    setQuickActionError(null);
    const target = uploadTarget ?? resolveUploadTarget();
    let lastPath: string | null = null;
    try {
      for (const file of files) {
        const contentBase64 = await fileToBase64(file);
        const assetPath = joinWorkspacePath(target.parentPath, uploadRelativePath(file));
        if (target.workspaceScope === 'global') {
          const asset = await apiClient.createGlobalAsset({
            path: assetPath,
            contentBase64,
            mimeType: file.type || undefined,
          });
          lastPath = asset.path;
          continue;
        }

        if (!target.projectId) return;
        const asset = await apiClient.createAsset(target.projectId, {
          path: assetPath,
          contentBase64,
          mimeType: file.type || undefined,
        });
        lastPath = asset.path;
      }

      if (target.workspaceScope === 'global') {
        await loadGlobalEntries({ keepSelectedPath: lastPath, revealPath: lastPath });
        setSelectedGlobalPath(lastPath);
      } else if (target.projectId && target.workspaceScope === 'temporary') {
        await loadTemporaryEntries(target.projectId, { keepSelectedPath: lastPath, revealPath: lastPath });
        setSelectedTemporaryProjectId(target.projectId);
        setSelectedTemporaryPath(lastPath);
      } else {
        if (!target.projectId) return;
        await loadEntries(target.projectId, { keepSelectedPath: lastPath, revealPath: lastPath });
        setSelectedProjectPath(lastPath);
      }
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    } finally {
      setUploadTarget(null);
      setUploadMode('files');
      setUploadState('idle');
    }
  }

  async function loadWechatStatus() {
    setWechatState('loading');
    try {
      const status = await apiClient.getWechatStatus();
      setWechatStatus(status);
      setWechatSetup(status.state === 'connected' ? null : status.setupSession);
      setWechatState('idle');
    } catch {
      setWechatState('error');
    }
  }

  async function createWechatSetup() {
    const setup = await apiClient.createWechatSetupSession();
    setWechatSetup(setup);
    await loadWechatStatus();
  }

  async function loadBrowserStatus() {
    setBrowserLoading(true);
    try {
      const status = await apiClient.getBrowserConnectorStatus();
      setBrowserStatus(status);
    } catch {
      // keep previous status
    } finally {
      setBrowserLoading(false);
    }
  }

  function attachRunStream(binding: RunStreamBinding) {
    if (streamCloseByRunIdRef.current.has(binding.runId)) return;

    runStreamBindingsRef.current.set(binding.runId, binding);
    seedSeenStreamEvents(binding);
    setRunState((current) => current === 'running' ? current : 'queued');
    setRunError(null);

    void apiClient.getRunEventSnapshot(binding.runId)
      .then((snapshot) => {
        if (!runStreamBindingsRef.current.has(binding.runId)) return;
        replayMissingStreamEvents(binding, snapshot.events);
      })
      .catch(() => {
        // The live SSE stream remains authoritative; a missing snapshot only means there is nothing to replay.
      });

    const closeStream = apiClient.streamRunEvents(binding.runId, {
      onEvent: (event) => replayMissingStreamEvents(binding, [event]),
      onError: (error) => {
        if (!runStreamBindingsRef.current.has(binding.runId)) return;
        streamCloseByRunIdRef.current.delete(binding.runId);
        runStreamBindingsRef.current.delete(binding.runId);
        if (activeRunIdRef.current === binding.runId) activeRunIdRef.current = null;
        if (runStreamBindingRef.current?.runId === binding.runId) runStreamBindingRef.current = null;
        updateMessageInSession(binding.sessionId, binding.messageId, (message) => ({
          ...message,
          status: 'error',
          content: message.content || `运行失败：${userFacingRunError(error)}`,
        }));
      },
    });
    streamCloseByRunIdRef.current.set(binding.runId, closeStream);
  }

  function replayMissingStreamEvents(binding: RunStreamBinding, events: StreamEvent[]) {
    if (events.length === 0) return;
    const existingEventKeys = seenRunStreamEventsRef.current.get(binding.runId) ?? seedSeenStreamEvents(binding);

    for (const event of events) {
      if (existingEventKeys.has(streamEventKey(event))) continue;
      existingEventKeys.add(streamEventKey(event));
      handleRunStreamEvent(binding.sessionId, binding.messageId, binding.projectId, event);
    }
  }

  function seedSeenStreamEvents(binding: RunStreamBinding): Set<string> {
    const existingEventKeys = new Set<string>();
    const session = chatSessionsRef.current.find((item) => item.id === binding.sessionId);
    const message = session?.messages.find((item) => item.id === binding.messageId);
    for (const event of message?.streamEvents ?? []) {
      existingEventKeys.add(streamEventKey(event));
    }
    seenRunStreamEventsRef.current.set(binding.runId, existingEventKeys);
    return existingEventKeys;
  }

  async function completeWechatSetup() {
    if (!wechatSetup) return;
    const status = await apiClient.completeWechatSetupSession(wechatSetup.sessionId, {
      displayName: '编剧微信',
      externalUserId: 'local-writer',
    });
    setWechatStatus(status);
    setWechatSetup(status.setupSession);
  }

  function closeReferenceMenu() {
    setReferenceQuery(null);
    setReferenceSuggestions([]);
    setActiveReferenceIndex(0);
  }

  function updateReferenceMenu(nextPrompt: string, caret: number) {
    if (chatScope !== 'project' || !selectedProjectId) {
      closeReferenceMenu();
      return;
    }

    const match = getActiveReferenceQuery(nextPrompt, caret);
    if (!match) {
      closeReferenceMenu();
      return;
    }

    const suggestions = buildReferenceSuggestions(selectedProjectFiles, match.query, referencedFiles);
    if (suggestions.length === 0) {
      closeReferenceMenu();
      return;
    }

    setReferenceQuery(match);
    setReferenceSuggestions(suggestions);
    setActiveReferenceIndex(0);
  }

  function selectReferencedFile(reference: FileReference) {
    const textarea = composerRef.current;
    const caret = textarea?.selectionStart ?? prompt.length;
    const inserted = insertReference(prompt, caret, reference);

    setPrompt(inserted.nextText);
    setReferencedFiles((current) =>
      current.some((item) => item.path === reference.path) ? current : [...current, reference],
    );
    closeReferenceMenu();

    window.requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(inserted.nextCaret, inserted.nextCaret);
    });
  }

  function removeReferencedFile(path: string) {
    setReferencedFiles((current) => current.filter((item) => item.path !== path));
  }

  function removeReferencedSnippet(id: string) {
    setReferencedSnippets((current) => current.filter((item) => item.id !== id));
  }

  async function handleImageReferenceFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }

    const imageFiles = Array.from(files).filter((file) => /^image\/(png|jpe?g|webp)$/i.test(file.type));
    const drafts = await Promise.all(imageFiles.map(readImageReferenceDraft));
    setImageReferenceDrafts((current) => [...current, ...drafts].slice(0, 6));
    if (imageReferenceInputRef.current) {
      imageReferenceInputRef.current.value = '';
    }
  }

  function removeImageReferenceDraft(id: string) {
    setImageReferenceDrafts((current) => current.filter((draft) => draft.id !== id));
  }

  async function submitPrompt() {
    const messageText = prompt.trim();
    if (!messageText) {
      return;
    }
    if (activeChatSessionQueuedCount >= 3) {
      showToast('当前会话已有 3 条消息排队，请等待前面的任务开始后再发送。', 'info');
      return;
    }
    await submitPromptWith(messageText);
  }

  async function submitPromptWith(messageText: string) {
    if (!messageText) {
      return;
    }

    const session = await ensureAssistantChatSession();
    if (!session) {
      return;
    }
    if (countQueuedAssistantMessages(session) >= 3) {
      showToast('当前会话已有 3 条消息排队，请等待前面的任务开始后再发送。', 'info');
      return;
    }

    if (chatMode === 'image' && isImageGenerationPrompt(messageText)) {
      await submitAssistantImagePrompt(session, messageText);
      return;
    }

    const runProjectId = session.projectId;
    const sessionModelConfig = {
      chatModel: chatModel || undefined,
      imageModel: imageModel || undefined,
      imageAspectRatio,
      imageThinkingLevel: imageThinkingLevel === 'default' ? undefined : imageThinkingLevel,
      imageCount,
    };

    const attachedReferences = chatScope === 'project' ? [...referencedFiles] : [];
    const attachedSnippets = [...referencedSnippets];
    const userMessage = createChatMessage('user', messageText, { referencedFiles: attachedReferences, referencedSnippets: attachedSnippets });
    appendMessageToSession(session.id, userMessage);
    setPrompt('');
    setReferencedFiles([]);
    setReferencedSnippets([]);
    closeReferenceMenu();
    setRunState(activeChatSessionRunning ? 'queued' : 'running');
    setRunError(null);
    setCurrentRun(null);

    try {
      const response = await apiClient.createRun({
        projectId: runProjectId,
        sessionId: session.id,
        prompt: messageText,
        model: sessionModelConfig.chatModel,
        imageGeneration: {
          model: sessionModelConfig.imageModel,
        },
        referencedFiles: attachedReferences,
        referencedSnippets: attachedSnippets,
      });
      void apiClient.updateChatSession(session.id, { modelConfig: sessionModelConfig }).catch((error) => {
        setRunError(errorToMessage(error));
      });
      setCurrentRun(response.run);

      if (response.events) {
        const endEvent = response.events.find((event): event is Extract<RunEvent, { type: 'run.end' }> => event.type === 'run.end');
        const messageStatus = endEvent?.status === 'error' || response.run.status === 'error' ? 'error' : 'success';
        setRunState(messageStatus);
        notifyRunComplete(messageStatus);
        appendMessageToSession(
          session.id,
          createChatMessage('assistant', assistantMessageFromEvents(response.events), {
            events: response.events,
            referencedFiles: response.run.referencedFiles,
            referencedSnippets: response.run.referencedSnippets ?? [],
            streamEvents: streamEventsFromRunEvents(response.events),
            status: messageStatus,
          }),
        );
        if (isTemporaryProjectId(runProjectId)) {
          await loadTemporaryEntries(runProjectId, {
            keepSelectedPath: selectedTemporaryProjectId === runProjectId ? selectedTemporaryPath : null,
            revealPath: selectedTemporaryProjectId === runProjectId ? selectedTemporaryPath : null,
          });
        } else if (selectedProjectId === runProjectId) {
          await refreshWorkspaceAfterRun(runProjectId);
        }
      } else {
        const assistantStatus = response.run.status === 'pending' ? 'queued' : 'running';
        const assistantMessage = createChatMessage('assistant', assistantStatus === 'queued' ? QUEUED_ASSISTANT_MESSAGE : '', {
          referencedFiles: response.run.referencedFiles,
          referencedSnippets: response.run.referencedSnippets ?? [],
          status: assistantStatus,
          runId: response.run.id,
        });
        appendMessageToSession(session.id, assistantMessage);
        setRunState(assistantStatus);
        attachRunStream({
          runId: response.run.id,
          sessionId: session.id,
          messageId: assistantMessage.id,
          projectId: runProjectId,
        });
      }
    } catch (error) {
      setRunState('error');
      setRunError(errorToMessage(error));
      appendMessageToSession(
        session.id,
        createChatMessage('assistant', `运行失败：${errorToMessage(error)}`, {
          referencedFiles: attachedReferences,
          referencedSnippets: attachedSnippets,
        }),
      );
    }
  }

  async function loadScheduledTasks(sessionId: string) {
    setScheduledTaskState('loading');
    try {
      const tasks = await apiClient.listSessionScheduledTasks(sessionId);
      setScheduledTasksBySession((current) => ({ ...current, [sessionId]: tasks }));
      setScheduledTaskState('idle');
    } catch (error) {
      setScheduledTaskState('error');
      setRunError(errorToMessage(error));
    }
  }

  async function loadProjectScheduledTasks(projectId: string) {
    setScheduledTaskState('loading');
    try {
      const tasks = await apiClient.listProjectScheduledTasks(projectId);
      setScheduledTasksBySession((current) => {
        const next = { ...current };
        const sessionIds = new Set(tasks.map((task) => task.sessionId));
        for (const task of tasks) {
          next[task.sessionId] = upsertScheduledTask(next[task.sessionId] ?? [], task);
        }
        for (const session of chatSessionsRef.current.filter((item) => item.projectId === projectId)) {
          if (!sessionIds.has(session.id)) next[session.id] = [];
        }
        return next;
      });
      setScheduledTaskState('idle');
    } catch (error) {
      setScheduledTaskState('error');
      setRunError(errorToMessage(error));
    }
  }

  async function openScheduleOverview() {
    setScheduleOverviewOpen(true);
    if (selectedProjectId) {
      await loadProjectScheduledTasks(selectedProjectId);
      return;
    }
    const sessionId = activeChatSession?.id;
    if (sessionId) await loadScheduledTasks(sessionId);
  }

  async function runScheduledTaskNow(taskId: string, sessionId = activeChatSession?.id) {
    if (!sessionId) return;
    setScheduledTaskBusyId(taskId);
    showToast('正在执行定时任务', 'info');
    try {
      const response = await apiClient.runScheduledTaskNow(taskId);
      setScheduledTasksBySession((current) => ({
        ...current,
        [sessionId]: upsertScheduledTask(current[sessionId] ?? [], response.task),
      }));
      if (response.userMessage && response.assistantMessage) {
        appendServerMessagesToSession(sessionId, [response.userMessage, response.assistantMessage]);
      }
      if (response.run && response.assistantMessage) {
        attachRunStream({
          runId: response.run.id,
          sessionId,
          messageId: response.assistantMessage.id,
          projectId: response.task.projectId,
        });
      }
      const session = chatSessionsRef.current.find((item) => item.id === sessionId);
      if (session) {
        if (isTemporaryProjectId(session.projectId)) {
          await loadTemporaryChatSessions();
        } else {
          await loadProjectChatSessions(session.projectId);
        }
      }
      showToast('定时任务已立即执行', 'success');
    } catch (error) {
      showToast(`立即执行失败：${errorToMessage(error)}`, 'error');
    } finally {
      setScheduledTaskBusyId(null);
    }
  }

  async function pauseScheduledTask(taskId: string, sessionId = activeChatSession?.id) {
    if (!sessionId) return;
    setScheduledTaskBusyId(taskId);
    try {
      await apiClient.pauseScheduledTask(taskId);
      await loadScheduledTasks(sessionId);
      showToast('定时任务已停止', 'success');
    } catch (error) {
      showToast(`停止任务失败：${errorToMessage(error)}`, 'error');
    } finally {
      setScheduledTaskBusyId(null);
    }
  }

  async function resumeScheduledTask(taskId: string, sessionId = activeChatSession?.id) {
    if (!sessionId) return;
    setScheduledTaskBusyId(taskId);
    try {
      await apiClient.resumeScheduledTask(taskId);
      await loadScheduledTasks(sessionId);
      showToast('定时任务已恢复', 'success');
    } catch (error) {
      showToast(`恢复任务失败：${errorToMessage(error)}`, 'error');
    } finally {
      setScheduledTaskBusyId(null);
    }
  }

  async function deleteScheduledTask(taskId: string, sessionId = activeChatSession?.id) {
    if (!sessionId) return;
    const confirmed = await showConfirm({ title: '删除定时任务', message: '删除后无法恢复。', danger: true, confirmLabel: '删除' });
    if (!confirmed) return;
    setScheduledTaskBusyId(taskId);
    try {
      await apiClient.deleteScheduledTask(taskId);
      await loadScheduledTasks(sessionId);
      showToast('定时任务已删除', 'success');
    } catch (error) {
      showToast(`删除任务失败：${errorToMessage(error)}`, 'error');
    } finally {
      setScheduledTaskBusyId(null);
    }
  }

  async function stopRun() {
    const runId = activeRunIdRef.current;
    const closeStream = runId ? streamCloseByRunIdRef.current.get(runId) : null;
    activeRunIdRef.current = null;
    runStreamBindingRef.current = null;
    if (runId) seenRunStreamEventsRef.current.delete(runId);
    if (runId) streamCloseByRunIdRef.current.delete(runId);
    if (runId) runStreamBindingsRef.current.delete(runId);
    closeStream?.();
    if (runId) {
      try {
        await apiClient.cancelRun(runId);
      } catch {
        // cancel request may fail if run already ended; safe to ignore
      }
    }
    setRunState(streamCloseByRunIdRef.current.size > 0 ? 'queued' : 'idle');
  }

  async function submitAssistantImagePrompt(session: ChatSession, messageText: string) {
    const pendingUserMessage = createChatMessage('user', messageText, {
      referencedFiles: chatScope === 'project' ? [...referencedFiles] : [],
      referencedSnippets: [...referencedSnippets],
    });
    const pendingAssistantMessage = createChatMessage('assistant', '正在生成图片...', { status: 'running' });
    appendDraftMessagesToSession(session.id, [pendingUserMessage, pendingAssistantMessage]);
    setPrompt('');
    setReferencedFiles([]);
    setReferencedSnippets([]);
    closeReferenceMenu();
    setRunState('running');
    setRunError(null);
    setCurrentRun(null);

    try {
      const response = await apiClient.createImageGeneration({
        sessionId: session.id,
        productId: ACTIVE_PRODUCT_PROFILE.id,
        prompt: messageText,
        model: imageModel || undefined,
        aspectRatio: imageAspectRatio,
        thinkingLevel: imageThinkingLevel === 'default' ? undefined : imageThinkingLevel,
        count: imageCount,
        referenceImages: imageReferenceDrafts.map(({ name, mimeType, contentBase64 }) => ({ name, mimeType, contentBase64 })),
      });
      void apiClient.updateChatSession(session.id, {
        modelConfig: {
          imageModel: imageModel || undefined,
          imageAspectRatio,
          imageThinkingLevel: imageThinkingLevel === 'default' ? undefined : imageThinkingLevel,
          imageCount,
        },
      }).catch((error) => {
        setRunError(errorToMessage(error));
      });
      setImageReferenceDrafts([]);

      setChatSessions((currentSessions) => [response.session, ...currentSessions.filter((current) => current.id !== response.session.id)]);
      setActiveChatSessionId(response.session.id);
      setRunState('success');
      setRunError(null);

      const generatedPath = response.assistantMessage.attachments?.[0]?.path ?? null;
      if (isTemporaryProjectId(response.session.projectId)) {
        setTemporaryProjectId(response.session.projectId);
        setSelectedTemporaryProjectId(response.session.projectId);
        writeStoredTemporaryChatSession({ projectId: response.session.projectId, sessionId: response.session.id });
        await loadTemporaryEntries(response.session.projectId, {
          keepSelectedPath: selectedTemporaryProjectId === response.session.projectId ? selectedTemporaryPath : null,
          revealPath: generatedPath,
        });
      } else if (selectedProjectId === response.session.projectId) {
        await loadEntries(response.session.projectId, {
          keepSelectedPath: selectedProjectPath,
          revealPath: generatedPath,
        });
      }
    } catch (error) {
      const message = errorToMessage(error);
      setRunState('error');
      setRunError(message);
      markLatestRunningAssistantMessage(session.id, `图片生成失败：${message}`);
    }
  }

  async function ensureAssistantChatSession(): Promise<ChatSession | null> {
    if (activeChatSession && isSessionInActiveChatScope(activeChatSession, chatScope, selectedProjectId) && getSessionKind(activeChatSession) === 'assistant') {
      return activeChatSession;
    }

    try {
      const session = chatScope === 'project' && selectedProjectId
        ? await apiClient.createChatSession(selectedProjectId)
        : await apiClient.createTemporaryChatSession({ productId: ACTIVE_PRODUCT_PROFILE.id });

      if (chatScope === 'temporary') {
        setTemporaryProjectId(session.projectId);
        setSelectedTemporaryProjectId(session.projectId);
        setChatSessionsProjectId(TEMPORARY_CHAT_SCOPE_ID);
        writeStoredTemporaryChatSession({ projectId: session.projectId, sessionId: session.id });
        setCollapsedTemporarySessionIds((current) => current.includes(session.id) ? current : [session.id, ...current]);
      }

      setChatSessions((currentSessions) => [session, ...currentSessions.filter((current) => current.id !== session.id)]);
      setActiveChatSessionId(session.id);
      return session;
    } catch (error) {
      setRunState('error');
      setRunError(errorToMessage(error));
      return null;
    }
  }

  async function refreshWorkspaceAfterRun(projectId: string) {
    const currentSelectedPath = selectedProjectPathRef.current;
    await loadEntries(projectId, { keepSelectedPath: currentSelectedPath, selectFirstTextFile: true });
    if (currentSelectedPath && isSupportedTextFile(currentSelectedPath)) {
      await loadFile(projectId, currentSelectedPath);
    }
  }

  function handleRunStreamEvent(sessionId: string, messageId: string, runProjectId: string, event: StreamEvent) {
    autoScrollRef.current = true;

    if (event.type === 'run.start') {
      const binding = runStreamBindingsRef.current.get(event.runId) ?? null;
      activeRunIdRef.current = event.runId;
      runStreamBindingRef.current = binding;
      activeStreamCloseRef.current = streamCloseByRunIdRef.current.get(event.runId) ?? null;
      setRunState('running');
    }

    if (event.type === 'file.changed' || event.type === 'image.generated') {
      const revealPath = event.type === 'image.generated' ? event.attachment.path : event.path;
      if (isTemporaryProjectId(runProjectId)) {
        void loadTemporaryEntries(runProjectId, {
          keepSelectedPath: selectedTemporaryProjectIdRef.current === runProjectId ? selectedTemporaryPathRef.current : null,
          revealPath,
        });
      } else if (selectedProjectIdRef.current === runProjectId) {
        void loadEntries(runProjectId, {
          keepSelectedPath: selectedProjectPathRef.current,
          revealPath,
        });
      }
    }

    const batchKey = `${sessionId}:${messageId}`;
    const existing = streamBatchRef.current.get(batchKey);
    if (existing) {
      existing.events.push(event);
    } else {
      streamBatchRef.current.set(batchKey, { sessionId, messageId, runProjectId, events: [event] });
    }

    if (!streamFlushTimerRef.current) {
      streamFlushTimerRef.current = setTimeout(flushStreamBatch, 100);
    }

    if (event.type === 'run.end') {
      streamCloseByRunIdRef.current.get(event.runId)?.();
      streamCloseByRunIdRef.current.delete(event.runId);
      runStreamBindingsRef.current.delete(event.runId);
      if (activeRunIdRef.current === event.runId) activeRunIdRef.current = null;
      if (runStreamBindingRef.current?.runId === event.runId) runStreamBindingRef.current = null;
      seenRunStreamEventsRef.current.delete(event.runId);
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBatch();
      const streamEndStatus = event.status === 'cancelled' ? 'idle' as const : event.status === 'success' ? 'success' as const : 'error' as const;
      setRunState(streamCloseByRunIdRef.current.size > 0 ? 'queued' : streamEndStatus);
      if (streamEndStatus !== 'idle') notifyRunComplete(streamEndStatus);
      if (event.errorMessage) {
        setRunError(userFacingRunError(event.errorMessage));
      }
      if (isTemporaryProjectId(runProjectId)) {
        void loadTemporaryEntries(runProjectId, {
          keepSelectedPath: selectedTemporaryProjectIdRef.current === runProjectId ? selectedTemporaryPathRef.current : null,
          revealPath: selectedTemporaryProjectIdRef.current === runProjectId ? selectedTemporaryPathRef.current : null,
        });
      } else if (selectedProjectIdRef.current === runProjectId) {
        void refreshWorkspaceAfterRun(runProjectId);
      }
    }
  }

  const runNotifyModeRef = useRef(runNotifyMode);
  runNotifyModeRef.current = runNotifyMode;

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  function notifyRunComplete(status: 'success' | 'error'): void {
    const mode = runNotifyModeRef.current;
    if (mode === 'off') return;
    const label = status === 'error' ? '运行失败' : '运行完成';
    if (mode === 'sound' || mode === 'both') {
      playNotificationSound();
    }
    if (mode === 'wechat' || mode === 'both') {
      void apiClient.sendWechatNotify(status).then((res) => {
        if (!res.sent) showToastRef.current(`微信通知未发送：${res.reason ?? '未知'}`, 'error');
      }).catch((err) => {
        console.error('[notify] wechat notify failed', err);
        showToastRef.current(`微信通知失败：${err instanceof Error ? err.message : '网络错误'}`, 'error');
      });
    }
    showToastRef.current(`${label}（通知：${mode}）`, status === 'error' ? 'error' : 'success');
  }

  function flushStreamBatch() {
    streamFlushTimerRef.current = null;
    const pending = streamBatchRef.current;
    streamBatchRef.current = new Map();

    if (pending.size === 0) return;

    const sessionUpdates = new Map<string, Array<{ messageId: string; events: StreamEvent[] }>>();
    for (const { sessionId, messageId, events } of pending.values()) {
      if (!sessionUpdates.has(sessionId)) sessionUpdates.set(sessionId, []);
      sessionUpdates.get(sessionId)!.push({ messageId, events });
    }

    setChatSessions((currentSessions) =>
      currentSessions.map((session) => {
        const updates = sessionUpdates.get(session.id);
        if (!updates) return session;

        return {
          ...session,
          updatedAt: new Date().toISOString(),
          messages: session.messages.map((message) => {
            const update = updates.find((u) => u.messageId === message.id);
            if (!update) return message;

            let content = message.content;
            let finalStatus = message.status;
            const attachments = [...(message.attachments ?? [])];
            for (const event of update.events) {
              if (event.type === 'text.delta') {
                content += event.delta;
              } else if (event.type === 'run.start') {
                content = content === QUEUED_ASSISTANT_MESSAGE ? '' : content;
                finalStatus = 'running';
              } else if (event.type === 'image.generated') {
                if (!attachments.some((attachment) => attachment.id === event.attachment.id || attachment.path === event.attachment.path)) {
                  attachments.push(event.attachment);
                }
              } else if (event.type === 'run.end' && event.status === 'error' && !content) {
                content = `运行失败：${userFacingRunError(event.errorMessage)}`;
              }
              if (event.type === 'tool_use.end') {
                const task = scheduledTaskFromToolEvent(event);
                if (task) {
                  setScheduledTasksBySession((current) => ({
                    ...current,
                    [session.id]: upsertScheduledTask(current[session.id] ?? [], task),
                  }));
                }
              }
              if (event.type === 'run.end') {
                finalStatus = event.status === 'error' ? 'error' : 'success';
              }
            }

            const updated = {
              ...message,
              content,
              attachments,
              streamEvents: [...message.streamEvents, ...update.events],
              status: finalStatus,
            };
            persistChatMessageUpdate(session.id, message.id, updated);
            return updated;
          }),
        };
      }),
    );
  }

  function openSidebarContextMenu(
    event: React.MouseEvent,
    payload: { workspaceScope?: WorkspaceScope; projectId?: string | null; entry?: WorkspaceEntry | null } = {},
  ) {
    event.preventDefault();
    event.stopPropagation();
    closeChatSessionContextMenu();
    closePreviewTabContextMenu();
    closeSelectedTextContextMenu();
    const workspaceScope = payload.workspaceScope ?? 'project';
    setActiveWorkspaceScope(workspaceScope);
    if (workspaceScope === 'project' && payload.projectId) {
      setSelectedProjectId(payload.projectId);
    }
    if (workspaceScope === 'temporary' && payload.projectId) {
      setSelectedTemporaryProjectId(payload.projectId);
    }
    if (payload.entry) {
      if (workspaceScope === 'global') {
        setSelectedGlobalPath(payload.entry.path);
      } else if (workspaceScope === 'temporary') {
        setSelectedTemporaryPath(payload.entry.path);
      } else {
        setSelectedProjectPath(payload.entry.path);
      }
    }
    const menuX = Math.min(event.clientX, window.innerWidth - SIDEBAR_CONTEXT_MENU_WIDTH - VIEWPORT_EDGE_GAP);
    const menuY = Math.min(event.clientY, window.innerHeight - SIDEBAR_CONTEXT_MENU_MAX_HEIGHT - VIEWPORT_EDGE_GAP);
    setSidebarContextMenu({
      x: Math.max(VIEWPORT_EDGE_GAP, menuX),
      workspaceScope,
      y: Math.max(VIEWPORT_EDGE_GAP, menuY),
      projectId: payload.projectId ?? (workspaceScope === 'temporary' ? selectedTemporaryProjectId : selectedProjectId),
      entryPath: payload.entry?.path ?? null,
      entryType: payload.entry?.type ?? null,
    });
  }

  function closeSidebarContextMenu() {
    setSidebarContextMenu(null);
  }

  function openChatSessionContextMenu(event: React.MouseEvent, sessionId: string, title?: string) {
    event.preventDefault();
    event.stopPropagation();
    suppressNextShellClickRef.current = true;
    closeSidebarContextMenu();
    closePreviewTabContextMenu();
    closeSelectedTextContextMenu();
    const menuX = Math.min(event.clientX, window.innerWidth - SIDEBAR_CONTEXT_MENU_WIDTH - VIEWPORT_EDGE_GAP);
    const menuY = Math.min(event.clientY, window.innerHeight - 90 - VIEWPORT_EDGE_GAP);
    setChatSessionContextMenu({
      x: Math.max(VIEWPORT_EDGE_GAP, menuX),
      y: Math.max(VIEWPORT_EDGE_GAP, menuY),
      sessionId,
      title,
    });
  }

  function closeChatSessionContextMenu() {
    setChatSessionContextMenu(null);
  }

  function openPreviewTabContextMenu(event: React.MouseEvent, tabId: string) {
    event.preventDefault();
    event.stopPropagation();
    closeSidebarContextMenu();
    closeChatSessionContextMenu();
    closeSelectedTextContextMenu();
    const menuX = Math.min(event.clientX, window.innerWidth - SIDEBAR_CONTEXT_MENU_WIDTH - VIEWPORT_EDGE_GAP);
    const menuY = Math.min(event.clientY, window.innerHeight - SIDEBAR_CONTEXT_MENU_MAX_HEIGHT - VIEWPORT_EDGE_GAP);
    previewTabs.setContextMenu({
      x: Math.max(VIEWPORT_EDGE_GAP, menuX),
      y: Math.max(VIEWPORT_EDGE_GAP, menuY),
      tabId,
    });
  }

  function closePreviewTabContextMenu() {
    previewTabs.closeContextMenu();
  }

  function openSelectedTextContextMenu(event: React.MouseEvent) {
    const selectedText = getSelectedTextFromEvent(event).trim();
    if (!selectedText || !selectedPath) {
      closeSelectedTextContextMenu();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeSidebarContextMenu();
    closeChatSessionContextMenu();
    closePreviewTabContextMenu();
    const menuX = Math.min(event.clientX, window.innerWidth - SIDEBAR_CONTEXT_MENU_WIDTH - VIEWPORT_EDGE_GAP);
    const menuY = Math.min(event.clientY, window.innerHeight - 90 - VIEWPORT_EDGE_GAP);
    setSelectedTextContextMenu({
      x: Math.max(VIEWPORT_EDGE_GAP, menuX),
      y: Math.max(VIEWPORT_EDGE_GAP, menuY),
      text: selectedText.slice(0, 4000),
      source: 'file',
      sourcePath: selectedPath,
    });
  }

  function closeSelectedTextContextMenu() {
    setSelectedTextContextMenu(null);
  }

  function quoteSelectedTextToComposer() {
    if (!selectedTextContextMenu) return;

    const ctx = selectedTextContextMenu;
    const snippet: ReferencedChatSnippet = ctx.source === 'file'
      ? {
          id: `snippet-file-${ctx.sourcePath}-${Math.abs(hashCode(`${ctx.sourcePath}:${ctx.text}`)).toString(36)}`,
          messageId: ctx.sourcePath,
          role: 'user',
          label: basename(ctx.sourcePath),
          text: ctx.text,
          createdAt: new Date().toISOString(),
        }
      : {
          id: createSnippetReferenceId(ctx),
          messageId: ctx.messageId,
          role: ctx.role,
          label: ctx.label,
          text: ctx.text,
          createdAt: ctx.createdAt,
        };

    setReferencedSnippets((current) =>
      current.some((item) => item.id === snippet.id) ? current : [...current, snippet],
    );

    if (ctx.source === 'file') {
      setReferencedFiles((current) =>
        current.some((item) => item.path === ctx.sourcePath)
          ? current
          : [...current, { path: ctx.sourcePath, label: basename(ctx.sourcePath) }],
      );
    }

    closeSelectedTextContextMenu();
    closeReferenceMenu();
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      const end = composerRef.current?.value.length ?? 0;
      composerRef.current?.setSelectionRange(end, end);
    });
  }

  async function copySelectedText() {
    if (!selectedTextContextMenu) return;

    try {
      await copyTextToClipboard(selectedTextContextMenu.text);
      closeSelectedTextContextMenu();
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  function toggleDirectory(projectId: string, entryPath: string) {
    setCollapsedDirectoriesByProject((current) => {
      const collapsed = new Set(current[projectId] ?? []);
      if (collapsed.has(entryPath)) {
        collapsed.delete(entryPath);
      } else {
        collapsed.add(entryPath);
      }
      return { ...current, [projectId]: [...collapsed] };
    });
  }

  function toggleGlobalDirectory(entryPath: string) {
    setCollapsedGlobalPaths((current) => toggleCollapsedPath(current, entryPath));
  }

  function toggleTemporarySession(session: ChatSession) {
    setSelectedTemporaryProjectId(session.projectId);
    setCollapsedTemporarySessionIds((current) => toggleCollapsedPath(current, session.id));
    if (!temporaryEntriesByProject[session.projectId]) {
      void loadTemporaryEntries(session.projectId);
    }
  }

  function toggleTemporaryDirectory(projectId: string, entryPath: string) {
    setCollapsedDirectoriesByTemporaryProject((current) => {
      const collapsed = new Set(current[projectId] ?? []);
      if (collapsed.has(entryPath)) {
        collapsed.delete(entryPath);
      } else {
        collapsed.add(entryPath);
      }
      return { ...current, [projectId]: [...collapsed] };
    });
  }

  function dragTargetKey(workspaceScope: WorkspaceScope, projectId: string | null, parentPath: string): string {
    return `${workspaceScope}:${projectId ?? ''}:${parentPath}`;
  }

  function canDropEntry(target: WorkspaceTarget): boolean {
    if (!dragEntry) return false;
    if (dragEntry.workspaceScope !== target.workspaceScope || dragEntry.projectId !== target.projectId) return false;
    if (dragEntry.entryType === 'directory' && (target.parentPath === dragEntry.entryPath || target.parentPath.startsWith(`${dragEntry.entryPath}/`))) return false;
    return joinWorkspacePath(target.parentPath, basename(dragEntry.entryPath)) !== dragEntry.entryPath;
  }

  function handleEntryDragStart(event: ReactDragEvent, workspaceScope: WorkspaceScope, projectId: string | null, entry: WorkspaceEntry) {
    const dragged: DragEntryDraft = { workspaceScope, projectId, entryPath: entry.path, entryType: entry.type };
    setDragEntry(dragged);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-viforge-entry', JSON.stringify(dragged));
  }

  function handleDropTargetDragOver(event: ReactDragEvent, target: WorkspaceTarget) {
    if (!canDropEntry(target)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverTargetKey(dragTargetKey(target.workspaceScope, target.projectId, target.parentPath));
  }

  async function handleDropOnDirectory(event: ReactDragEvent, target: WorkspaceTarget) {
    event.preventDefault();
    const droppedEntry = dragEntry;
    setDragEntry(null);
    setDragOverTargetKey(null);
    if (!droppedEntry) return;
    await moveEntryToDirectory(droppedEntry, target);
  }

  function dropTargetClass(workspaceScope: WorkspaceScope, projectId: string | null, parentPath: string): string {
    return dragOverTargetKey === dragTargetKey(workspaceScope, projectId, parentPath) ? ' drag-over' : '';
  }

  function startPanelResize(event: ReactPointerEvent, targetPanel: 'workspace' | 'chat') {
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = { ...panelWidths };
    const chatMaxWidth = typeof window === 'undefined'
      ? CHAT_PANEL_FALLBACK_MAX_WIDTH
      : Math.max(CHAT_PANEL_MIN_WIDTH, window.innerWidth - 96);

    function handlePointerMove(moveEvent: PointerEvent) {
      const deltaX = moveEvent.clientX - startX;
      setPanelWidths((current) => {
        if (targetPanel === 'workspace') {
          return {
            ...current,
            workspace: clamp(startWidths.workspace + deltaX, WORKSPACE_PANEL_MIN_WIDTH, WORKSPACE_PANEL_MAX_WIDTH),
          };
        }

        return {
          ...current,
          chat: clamp(startWidths.chat - deltaX, CHAT_PANEL_MIN_WIDTH, chatMaxWidth),
        };
      });
    }

    function handlePointerUp() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.classList.remove('is-resizing-panels');
    }

    document.body.classList.add('is-resizing-panels');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  function contentAreaColumns(): string {
    const sidebarCol = sidebarOpen ? `${panelWidths.workspace}px ` : '';
    if (editorPanelOpen && chatPanelOpen) {
      return `${sidebarCol}minmax(0, 1fr) 6px minmax(${CHAT_PANEL_MIN_WIDTH}px, ${panelWidths.chat}px)`;
    }
    if (editorPanelOpen) {
      return `${sidebarCol}1fr`;
    }
    if (chatPanelOpen) {
      return `${sidebarCol}1fr`;
    }
    return `${sidebarCol}1fr`;
  }

  function workspaceGridColumns() {
    return [
      collapsedPanels.workspace ? '0' : `${panelWidths.workspace}px`,
      collapsedPanels.workspace || collapsedPanels.editor ? '0' : '8px',
      collapsedPanels.editor ? '0' : 'minmax(420px, 1fr)',
      collapsedPanels.editor || collapsedPanels.chat ? '0' : '8px',
      collapsedPanels.chat ? '0' : collapsedPanels.editor ? 'minmax(320px, 1fr)' : `${panelWidths.chat}px`,
    ].join(' ');
  }

  function openDirectoryForDraft(draft: CreateEntryDraft) {
    if (!draft.parentPath) return;

    if (draft.workspaceScope === 'global') {
      setCollapsedGlobalPaths((current) => current.filter((path) => path !== draft.parentPath));
      return;
    }

    const projectId = draft.projectId;
    if (!projectId) return;
    if (draft.workspaceScope === 'temporary') {
      setCollapsedDirectoriesByTemporaryProject((current) => ({
        ...current,
        [projectId]: (current[projectId] ?? []).filter((directoryPath) => directoryPath !== draft.parentPath),
      }));
      return;
    }

    setCollapsedDirectoriesByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).filter((directoryPath) => directoryPath !== draft.parentPath),
    }));
  }

  function startCreateEntry(kind: CreateEntryDraft['kind'], context: SidebarContextMenu | null) {
    const workspaceScope = context?.workspaceScope ?? 'project';
    const projectId = workspaceScope === 'global'
      ? null
      : context?.projectId ?? (workspaceScope === 'temporary' ? selectedTemporaryProjectId : selectedProjectId);
    const parentPath = context?.entryType === 'directory'
      ? context.entryPath ?? ''
      : context?.entryPath
        ? parentDirectory(context.entryPath)
        : '';
    const draft: CreateEntryDraft = {
      workspaceScope,
      projectId,
      parentPath,
      kind,
      name: kind === 'folder' ? '新文件夹' : '新文档.md',
    };

    setActiveWorkspaceScope(workspaceScope);
    if (workspaceScope === 'project' && projectId) {
      setSelectedProjectId(projectId);
    }
    if (workspaceScope === 'temporary' && projectId) {
      setSelectedTemporaryProjectId(projectId);
    }
    setCreateEntryDraft(draft);
    setRenameEntryDraft(null);
    openDirectoryForDraft(draft);
  }

  function startRenameEntry(context: SidebarContextMenu | null) {
    if (!context?.entryPath) return;
    const workspaceScope = context.workspaceScope;
    const projectId = workspaceScope === 'global'
      ? null
      : context.projectId ?? (workspaceScope === 'temporary' ? selectedTemporaryProjectId : selectedProjectId);
    setActiveWorkspaceScope(workspaceScope);
    if (workspaceScope === 'project' && projectId) {
      setSelectedProjectId(projectId);
    }
    if (workspaceScope === 'temporary' && projectId) {
      setSelectedTemporaryProjectId(projectId);
    }
    if (workspaceScope === 'global') {
      setSelectedGlobalPath(context.entryPath);
    } else if (workspaceScope === 'temporary') {
      setSelectedTemporaryPath(context.entryPath);
    } else {
      setSelectedProjectPath(context.entryPath);
    }
    setCreateEntryDraft(null);
    setRenameEntryDraft({
      workspaceScope,
      projectId,
      entryPath: context.entryPath,
      originalName: basename(context.entryPath),
      name: basename(context.entryPath),
    });
  }

  async function runSidebarAction(
    action:
      | 'new-project'
      | 'new-folder'
      | 'new-file'
      | 'upload'
      | 'upload-folder'
      | 'rename'
      | 'rename-project'
      | 'delete-project'
      | 'move'
      | 'delete',
  ) {
    const context = sidebarContextMenu;
    closeSidebarContextMenu();

    if (action === 'new-project') {
      await createProjectFromContext();
      return;
    }

    if (context?.workspaceScope === 'project' && context.projectId && context.projectId !== selectedProjectId) {
      setSelectedProjectId(context.projectId);
    }
    if (context?.workspaceScope === 'temporary' && context.projectId && context.projectId !== selectedTemporaryProjectId) {
      setSelectedTemporaryProjectId(context.projectId);
    }
    setActiveWorkspaceScope(context?.workspaceScope ?? 'project');

    if (action === 'new-folder') {
      startCreateEntry('folder', context);
      return;
    }

    if (action === 'new-file') {
      startCreateEntry('file', context);
      return;
    }

    if (action === 'upload') {
      startUpload(context);
      return;
    }

    if (action === 'upload-folder') {
      startUpload(context, 'folder');
      return;
    }

    if (action === 'rename') {
      startRenameEntry(context);
      return;
    }

    if (action === 'rename-project') {
      await renameProjectFromContext(context);
      return;
    }

    if (action === 'delete-project') {
      await deleteProjectFromContext(context);
      return;
    }

    if (action === 'move' && context?.entryPath) {
      if (context.workspaceScope === 'global') {
        setSelectedGlobalPath(context.entryPath);
      } else if (context.workspaceScope === 'temporary') {
        setSelectedTemporaryProjectId(context.projectId);
        setSelectedTemporaryPath(context.entryPath);
      } else {
        setSelectedProjectPath(context.entryPath);
      }
      const targetPath = await showPrompt({ title: '移动文件', placeholder: context.entryPath, initialValue: context.entryPath, confirmLabel: '移动' });
      if (targetPath && targetPath !== context.entryPath) {
        await moveSelectedEntry(targetPath);
      }
      return;
    }

    if (action === 'delete' && context?.entryPath) {
      if (context.workspaceScope === 'global') {
        setSelectedGlobalPath(context.entryPath);
      } else if (context.workspaceScope === 'temporary') {
        setSelectedTemporaryProjectId(context.projectId);
        setSelectedTemporaryPath(context.entryPath);
      } else {
        setSelectedProjectPath(context.entryPath);
      }
      const confirmed = await showConfirm({ title: '删除文件', message: `确定要删除 ${context.entryPath} 吗？`, danger: true, confirmLabel: '删除' });
      if (confirmed) {
        await deleteSelectedEntry();
      }
    }
  }

  function renderCreateEntryDraft(workspaceScope: WorkspaceScope, projectId: string | null, parentPath: string, depth: number) {
    const draft = createEntryDraft;
    if (!draft || draft.workspaceScope !== workspaceScope || draft.projectId !== projectId || draft.parentPath !== parentPath) {
      return null;
    }

    const icon = draft.kind === 'folder' ? <FolderOpen size={13} /> : <File size={12} />;
    return (
      <div
        className="file-node create-entry-draft"
        style={{ '--tree-depth': String(depth) } as React.CSSProperties}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="file-node-icon">{icon}</span>
        <input
          ref={createEntryInputRef}
          value={draft.name}
          aria-label={draft.kind === 'folder' ? '新文件夹名称' : '新文档名称'}
          onChange={(event) => setCreateEntryDraft((current) => current ? { ...current, name: event.target.value } : current)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              skipCreateEntryBlurRef.current = true;
              setCreateEntryDraft(null);
              event.currentTarget.blur();
            }
          }}
          onBlur={() => {
            if (skipCreateEntryBlurRef.current) {
              skipCreateEntryBlurRef.current = false;
              return;
            }
            if (createEntryDraft) {
              void createDraftEntry(createEntryDraft);
            }
          }}
        />
      </div>
    );
  }

  function renderRenameEntryDraft(entry: WorkspaceEntry, workspaceScope: WorkspaceScope, projectId: string | null) {
    const draft = renameEntryDraft;
    if (!draft || draft.workspaceScope !== workspaceScope || draft.projectId !== projectId || draft.entryPath !== entry.path) {
      return null;
    }

    return (
      <div
        className="file-node create-entry-draft rename-entry-draft"
        style={{ '--tree-depth': String(pathDepth(entry.path)) } as React.CSSProperties}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="file-node-icon">{entry.type === 'directory' ? <FolderOpen size={13} /> : fileIconForPath(entry.path)}</span>
        <input
          ref={renameEntryInputRef}
          value={draft.name}
          aria-label="重命名"
          onChange={(event) => setRenameEntryDraft((current) => current ? { ...current, name: event.target.value } : current)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              skipRenameEntryBlurRef.current = true;
              setRenameEntryDraft(null);
              event.currentTarget.blur();
            }
          }}
          onBlur={() => {
            if (skipRenameEntryBlurRef.current) {
              skipRenameEntryBlurRef.current = false;
              return;
            }
            if (renameEntryDraft) {
              void renameDraftEntry(renameEntryDraft);
            }
          }}
        />
      </div>
    );
  }

  async function createNewChatSession() {
    let session: ChatSession | null = null;
    if (chatScope === 'project' && selectedProjectId) {
      session = await createAndActivateChatSession(selectedProjectId);
    } else {
      try {
        const created = await apiClient.createTemporaryChatSession({ productId: ACTIVE_PRODUCT_PROFILE.id });
        session = created;
        setChatSessions((currentSessions) => [created, ...currentSessions.filter((current) => current.id !== created.id)]);
        setActiveChatSessionId(created.id);
      } catch (error) {
        setRunError(errorToMessage(error));
        return;
      }
    }

    if (!session) return;

    if (chatScope === 'temporary') {
      setTemporaryProjectId(session.projectId);
      setSelectedTemporaryProjectId(session.projectId);
      setChatSessionsProjectId(TEMPORARY_CHAT_SCOPE_ID);
      writeStoredTemporaryChatSession({ projectId: session.projectId, sessionId: session.id });
      setCollapsedTemporarySessionIds((current) => current.includes(session.id) ? current : [session.id, ...current]);
    }
    setPrompt('');
    setReferencedFiles([]);
    setReferencedSnippets([]);
    setImageReferenceDrafts([]);
    closeReferenceMenu();
    setRunError(null);
    setRunState('idle');
    setCurrentRun(null);
  }

  function openChatSession(sessionId: string) {
    closeChatSessionContextMenu();
    setActiveChatSessionId(sessionId);
    const session = chatSessions.find((item) => item.id === sessionId);
    if (chatScope === 'temporary' && session) {
      setSelectedTemporaryProjectId(session.projectId);
      writeStoredTemporaryChatSession({ projectId: session.projectId, sessionId: session.id });
    }
    if (session?.modelConfig) {
      const mc = session.modelConfig;
      if (mc.chatModel !== undefined) setChatModel(mc.chatModel);
      if (mc.imageModel !== undefined) setImageModel(mc.imageModel);
      if (mc.imageAspectRatio) setImageAspectRatio(mc.imageAspectRatio);
      if (mc.imageThinkingLevel) setImageThinkingLevel(mc.imageThinkingLevel);
      if (mc.imageCount) setImageCount(mc.imageCount);
    }
    setPrompt('');
    setReferencedFiles([]);
    setReferencedSnippets([]);
    closeReferenceMenu();
    setRunError(null);
    setRunState('idle');
    setCurrentRun(null);
  }

  async function archiveChatSession(sessionId: string) {
    const nextSession = projectChatSessions.find((session) => session.id !== sessionId) ?? null;
    closeChatSessionContextMenu();
    try {
      const archived = await apiClient.archiveChatSession(sessionId);
      setChatSessions((currentSessions) =>
        currentSessions.map((session) => (session.id === sessionId ? archived : session)),
      );
      if (activeChatSessionId === sessionId) {
        setActiveChatSessionId(nextSession?.id ?? null);
        setPrompt('');
        setReferencedFiles([]);
        setReferencedSnippets([]);
        closeReferenceMenu();
        setRunError(null);
        setRunState('idle');
        setCurrentRun(null);
      }
    } catch (error) {
      setRunError(errorToMessage(error));
    }
  }

  async function restoreChatSession(sessionId: string) {
    closeChatSessionContextMenu();
    try {
      const restored = await apiClient.restoreChatSession(sessionId);
      setChatSessions((currentSessions) =>
        currentSessions.map((session) => (session.id === sessionId ? restored : session)),
      );
      setChatSessionView('active');
      openChatSession(restored.id);
    } catch (error) {
      setRunError(errorToMessage(error));
    }
  }

  async function renameChatSession(context: ChatSessionContextMenu) {
    closeChatSessionContextMenu();
    const current = chatSessions.find((session) => session.id === context.sessionId);
    const currentTitle = current?.title ?? context.title ?? '';
    const nextTitle = await showPrompt({ title: '重命名会话', placeholder: currentTitle, initialValue: currentTitle, confirmLabel: '保存' });
    if (!nextTitle?.trim() || nextTitle.trim() === currentTitle) return;
    setRunError(null);
    try {
      const updated = await apiClient.updateChatSession(context.sessionId, { title: nextTitle.trim() });
      setChatSessions((currentSessions) =>
        currentSessions.map((session) => (session.id === updated.id ? updated : session)),
      );
    } catch (error) {
      setRunError(errorToMessage(error));
    }
  }

  async function deleteChatSession(context: ChatSessionContextMenu) {
    closeChatSessionContextMenu();
    const current = chatSessions.find((session) => session.id === context.sessionId);
    if (!current) return;
    const firstConfirm = await showConfirm({
      title: `删除会话「${current.title}」`,
      message: '该会话的所有聊天记录都将被永久删除，且无法恢复。',
      danger: true,
      confirmLabel: '继续删除',
    });
    if (!firstConfirm) return;
    const typed = await showPrompt({ title: '二次确认', message: `请输入会话标题「${current.title}」以完成删除`, requireMatch: current.title, confirmLabel: '确认删除' });
    if (typed === null) return;
    if (typed !== current.title) {
      setRunError('会话标题不匹配，已取消删除。');
      return;
    }
    setRunError(null);
    try {
      await apiClient.deleteChatSession(context.sessionId);
      setChatSessions((currentSessions) => currentSessions.filter((session) => session.id !== context.sessionId));
      if (activeChatSessionId === context.sessionId) {
        setActiveChatSessionId(null);
        setPrompt('');
        setReferencedFiles([]);
        setReferencedSnippets([]);
        closeReferenceMenu();
        setRunError(null);
        setRunState('idle');
        setCurrentRun(null);
      }
    } catch (error) {
      setRunError(errorToMessage(error));
    }
  }

  function appendMessageToSession(sessionId: string, message: ChatMessage) {
    setChatSessions((currentSessions) =>
      currentSessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        const title = session.messages.length === 0 && message.role === 'user' ? message.content.slice(0, 24) : session.title;
        return {
          ...session,
          title: title || session.title,
          updatedAt: message.createdAt,
          messages: [...session.messages, message],
        };
      }),
    );
    persistChatMessageAppend(sessionId, message);
  }

  function appendDraftMessagesToSession(sessionId: string, messages: ChatMessage[]) {
    setChatSessions((currentSessions) =>
      currentSessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        const firstUserMessage = messages.find((message) => message.role === 'user');
        const title = session.messages.length === 0 && firstUserMessage ? firstUserMessage.content.slice(0, 24) : session.title;
        return {
          ...session,
          title: title || session.title,
          updatedAt: messages[messages.length - 1]?.createdAt ?? new Date().toISOString(),
          messages: [...session.messages, ...messages],
        };
      }),
    );
  }

  function appendServerMessagesToSession(sessionId: string, messages: ChatMessage[]) {
    setChatSessions((currentSessions) =>
      currentSessions.map((session) => {
        if (session.id !== sessionId) return session;
        const existingIds = new Set(session.messages.map((message) => message.id));
        const nextMessages = messages.filter((message) => !existingIds.has(message.id));
        if (nextMessages.length === 0) return session;
        return {
          ...session,
          updatedAt: nextMessages[nextMessages.length - 1]?.createdAt ?? new Date().toISOString(),
          messages: [...session.messages, ...nextMessages],
        };
      }),
    );
  }

  function markLatestRunningAssistantMessage(sessionId: string, content: string) {
    setChatSessions((currentSessions) =>
      currentSessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        const messages = [...session.messages];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message.role === 'assistant' && message.status === 'running') {
            messages[index] = { ...message, content, status: 'error' };
            break;
          }
        }
        return {
          ...session,
          updatedAt: new Date().toISOString(),
          messages,
        };
      }),
    );
  }

  function updateMessageInSession(sessionId: string, messageId: string, update: (message: ChatMessage) => ChatMessage) {
    let updatedMessage: ChatMessage | null = null;
    setChatSessions((currentSessions) =>
      currentSessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        return {
          ...session,
          updatedAt: new Date().toISOString(),
          messages: session.messages.map((message) => {
            if (message.id !== messageId) {
              return message;
            }
            updatedMessage = update(message);
            return updatedMessage;
          }),
        };
      }),
    );
    if (updatedMessage) {
      persistChatMessageUpdate(sessionId, messageId, updatedMessage);
    }
  }

  function persistChatMessageAppend(sessionId: string, message: ChatMessage) {
    chatMessagePersistQueueRef.current = chatMessagePersistQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await apiClient.appendChatMessage(sessionId, message);
      })
      .catch((error) => {
        setRunError(errorToMessage(error));
      });
  }

  function persistChatMessageUpdate(sessionId: string, messageId: string, message: ChatMessage) {
    pendingChatMessageUpdatesRef.current.set(`${sessionId}:${messageId}`, { sessionId, messageId, message });
    scheduleChatMessageUpdateFlush();
  }

  function scheduleChatMessageUpdateFlush() {
    if (chatMessageUpdateFlushScheduledRef.current) {
      return;
    }

    chatMessageUpdateFlushScheduledRef.current = true;
    chatMessagePersistQueueRef.current = chatMessagePersistQueueRef.current
      .catch(() => undefined)
      .then(flushPendingChatMessageUpdates)
      .catch((error) => {
        setRunError(errorToMessage(error));
      })
      .finally(() => {
        chatMessageUpdateFlushScheduledRef.current = false;
        if (pendingChatMessageUpdatesRef.current.size > 0) {
          scheduleChatMessageUpdateFlush();
        }
      });
  }

  async function flushPendingChatMessageUpdates() {
    while (pendingChatMessageUpdatesRef.current.size > 0) {
      const updates = [...pendingChatMessageUpdatesRef.current.values()];
      pendingChatMessageUpdatesRef.current.clear();

      for (const update of updates) {
        try {
          await apiClient.updateChatMessage(update.sessionId, update.messageId, update.message);
        } catch (error) {
          setRunError(errorToMessage(error));
        }
      }
    }
  }

  function handleComposerChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const nextPrompt = event.target.value;
    setPrompt(nextPrompt);
    updateReferenceMenu(nextPrompt, event.target.selectionStart ?? nextPrompt.length);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (referenceSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveReferenceIndex((current) => (current + 1) % referenceSuggestions.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveReferenceIndex((current) => (current - 1 + referenceSuggestions.length) % referenceSuggestions.length);
        return;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const nextReference = referenceSuggestions[activeReferenceIndex];
        if (nextReference) {
          selectReferencedFile(nextReference);
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeReferenceMenu();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitPrompt();
    }
  }

  return (
    <div
      className="workspace-shell"
      onClick={() => {
        if (suppressNextShellClickRef.current) {
          suppressNextShellClickRef.current = false;
          return;
        }
        closeSidebarContextMenu();
        closeChatSessionContextMenu();
        closePreviewTabContextMenu();
        closeSelectedTextContextMenu();
      }}
    >
      <ActivityRail
        sidebarOpen={sidebarOpen}
        editorOpen={editorPanelOpen}
        chatOpen={chatPanelOpen}
        themeMode={themeMode as RailThemeMode}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleEditor={() => setEditorPanelOpen((v) => !v)}
        onToggleChat={() => setChatPanelOpen((v) => !v)}
        onToggleTheme={() => setThemeMode(nextThemeMode(themeMode))}
        onOpenConnectors={() => setActiveToolPanel('connectors')}
        onOpenGitSync={() => setActiveToolPanel('git')}
        onOpenHarness={openHarnessStandalone}
        onOpenSchedules={() => void openScheduleOverview()}
        onOpenSettings={() => setActiveToolPanel('settings')}
      />

      <div className="content-area" style={{ gridTemplateColumns: contentAreaColumns() }}>

      {sidebarOpen ? (
        <aside className="sidebar-panel">
          <div className="sidebar-header">
            <h2>工作区</h2>
            <div className="sidebar-header-actions">
              <button type="button" className="sidebar-icon-button" onClick={() => void loadProjects()} aria-label="刷新项目" title="刷新项目">
                <RefreshCw size={14} />
              </button>
              <button type="button" className="sidebar-icon-button" onClick={() => void loadGlobalEntries()} aria-label="刷新全局" title="刷新全局">
                <Globe size={14} />
              </button>
              <button type="button" className="sidebar-icon-button" onClick={() => startUpload()} aria-label="上传素材" title="上传素材">
                <Upload size={14} />
              </button>
              <button type="button" className="sidebar-icon-button" onClick={() => startUpload(null, 'folder')} aria-label="上传文件夹" title="上传文件夹">
                <FolderUp size={14} />
              </button>
            </div>
          </div>
          <div className="sidebar-schedule-entry">
            <button type="button" onClick={() => void openScheduleOverview()}>
              <span>
                <strong>定时任务</strong>
                <small>{allScheduledTasks.length} 个任务</small>
              </span>
              <span className="scheduled-task-count">{scheduledTaskState === 'loading' ? '...' : allScheduledTasks.length}</span>
            </button>
          </div>
          <div className="sidebar-scroll">

      {projectLoadState === 'error' ? (
        <section className="notice error-notice">
          <h2>项目加载失败</h2>
          <p>{projectLoadError}</p>
          <button type="button" onClick={() => void loadProjects()}>
            重试
          </button>
        </section>
      ) : null}

      {projectLoadState === 'loading' ? <section className="notice">正在加载项目...</section> : null}

      {projectLoadState !== 'loading' ? (
        <>
              <input
                ref={fileUploadRef}
                type="file"
                className="visually-hidden"
                multiple
                onChange={(event) => {
                  const fileArray = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
                  event.currentTarget.value = '';
                  if (fileArray.length === 0) return;
                  void uploadAssets(fileArray);
                }}
              />
              <input
                ref={folderUploadRef}
                type="file"
                className="visually-hidden"
                multiple
                // @ts-expect-error -- webkitdirectory is a non-standard but widely supported attribute for folder pickers.
                webkitdirectory=""
                directory=""
                onChange={(event) => {
                  const fileArray = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
                  event.currentTarget.value = '';
                  if (fileArray.length === 0) return;
                  void uploadAssets(fileArray);
                }}
              />

              {createProjectError ? <p className="inline-error">{createProjectError}</p> : null}

              <div className="workspace-tree">
                <div className="workspace-section">
                  <button
                    type="button"
                    className="workspace-section-root"
                    title={WORKSPACE_SECTIONS[1].title}
                    onContextMenu={(event) => openSidebarContextMenu(event, { projectId: null })}
                  >
                    <span className="node-icon"><FolderOpen size={14} /></span>
                    <span className="node-main">
                      <strong>{WORKSPACE_SECTIONS[1].title}</strong>
                    </span>
                  </button>
                  <div className="project-list">
                    {projects.map((project) => {
                      const isSelectedProject = project.id === selectedProjectId;
                      const isProjectCollapsed = collapsedProjectIds.has(project.id);
                      const showTree = isSelectedProject && !isProjectCollapsed;
                      return (
                        <div key={project.id} className={`project-node ${isSelectedProject ? 'selected' : ''}`}>
                          <button
                            type="button"
                            className={`project-root${dropTargetClass('project', project.id, '')}`}
                            onClick={() => {
                              setActiveWorkspaceScope('project');
                              if (isSelectedProject) {
                                setCollapsedProjectIds((current) => {
                                  const next = new Set(current);
                                  if (next.has(project.id)) {
                                    next.delete(project.id);
                                  } else {
                                    next.add(project.id);
                                  }
                                  return next;
                                });
                              } else {
                                setSelectedProjectId(project.id);
                                setChatScope('project');
                                setCollapsedProjectIds((current) => {
                                  const next = new Set(current);
                                  next.delete(project.id);
                                  return next;
                                });
                              }
                            }}
                            onDragOver={(event) => handleDropTargetDragOver(event, { workspaceScope: 'project', projectId: project.id, parentPath: '' })}
                            onDragLeave={() => setDragOverTargetKey(null)}
                            onDrop={(event) => void handleDropOnDirectory(event, { workspaceScope: 'project', projectId: project.id, parentPath: '' })}
                            onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'project', projectId: project.id })}
                          >
                            <span className={`file-node-chevron project-root-chevron ${isSelectedProject ? '' : 'placeholder'}`}>
                              {isSelectedProject
                                ? isProjectCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />
                                : <ChevronRight size={10} />}
                            </span>
                            <span className="node-icon">{showTree ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
                            <span className="node-main">
                              <strong>{project.name}</strong>
                            </span>
                          </button>
                          {showTree ? (
                            <div className="file-tree nested-tree project-tree">
                              {entriesState === 'error' ? <p className="inline-error">{entriesError}</p> : null}
                              {entriesState === 'loading' ? <p className="muted">正在加载文件...</p> : null}
                              {renderCreateEntryDraft('project', project.id, '', 0)}
                              {visibleEntries.map((entry) => (
                                <Fragment key={entry.path}>
                                  {renderRenameEntryDraft(entry, 'project', project.id) ?? (
                                    <button
                                      type="button"
                                      className={`file-node ${entry.type === 'directory' ? `directory-node${dropTargetClass('project', project.id, entry.path)}` : 'document-node'} ${activeWorkspaceScope === 'project' && entry.path === selectedPath ? 'selected' : ''}`}
                                      draggable
                                      style={{ '--tree-depth': String(pathDepth(entry.path)) } as React.CSSProperties}
                                      onDragStart={(event) => handleEntryDragStart(event, 'project', project.id, entry)}
                                      onDragEnd={() => {
                                        setDragEntry(null);
                                        setDragOverTargetKey(null);
                                      }}
                                      onDragOver={entry.type === 'directory' ? (event) => handleDropTargetDragOver(event, { workspaceScope: 'project', projectId: project.id, parentPath: entry.path }) : undefined}
                                      onDragLeave={entry.type === 'directory' ? () => setDragOverTargetKey(null) : undefined}
                                      onDrop={entry.type === 'directory' ? (event) => void handleDropOnDirectory(event, { workspaceScope: 'project', projectId: project.id, parentPath: entry.path }) : undefined}
                                      onClick={() => {
                                        selectEntryForPreview('project', project.id, entry);
                                        if (entry.type === 'file') {
                                          setEditorPanelOpen(true);
                                        }
                                        if (entry.type === 'directory') {
                                          toggleDirectory(project.id, entry.path);
                                        }
                                      }}
                                      onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'project', projectId: project.id, entry })}
                                      title={entry.path}
                                    >
                                      <span className="file-node-label">
                                        {entry.type === 'directory' ? (
                                          <span className="file-node-chevron">
                                            {(collapsedDirectoriesByProject[project.id] ?? []).includes(entry.path) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                          </span>
                                        ) : null}
                                        <span className="file-node-icon">
                                          {entry.type === 'directory'
                                            ? (collapsedDirectoriesByProject[project.id] ?? []).includes(entry.path) ? <Folder size={13} /> : <FolderOpen size={13} />
                                            : fileIconForPath(entry.path)}
                                        </span>
                                        <span>{entry.name}</span>
                                      </span>
                                      {entry.type === 'file' ? <small>{formatFileSize(entry.size)}</small> : null}
                                    </button>
                                  )}
                                  {entry.type === 'directory' ? renderCreateEntryDraft('project', project.id, entry.path, pathDepth(entry.path) + 1) : null}
                                </Fragment>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="workspace-section temporary-workspace-section">
                  <button
                    type="button"
                    className="workspace-section-root temporary-workspace-root"
                    title="临时会话对应的后台工作目录，默认折叠但始终可见"
                    onClick={() => setTemporaryWorkspaceCollapsed((current) => !current)}
                    onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'temporary', projectId: selectedTemporaryProjectId })}
                  >
                    <span className="node-icon">{temporaryWorkspaceCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                    <span className="node-main">
                      <strong>临时会话工作目录</strong>
                      <small>{temporaryChatSessions.length} 个临时会话</small>
                    </span>
                  </button>
                  {!temporaryWorkspaceCollapsed ? (
                    <div className="project-list temporary-session-list">
                      {temporaryChatSessions.length === 0 ? <p className="muted">暂无临时会话。</p> : null}
                      {temporaryChatSessions.map((session) => {
                        const isCollapsed = collapsedTemporarySessionIds.includes(session.id);
                        const isSelectedTemporaryProject = activeWorkspaceScope === 'temporary' && selectedTemporaryProjectId === session.projectId;
                        const sessionEntries = temporaryEntriesByProject[session.projectId] ?? [];
                        const visibleTemporaryEntries = filterVisibleWorkspaceEntries(
                          sessionEntries,
                          collapsedDirectoriesByTemporaryProject[session.projectId] ?? [],
                        );
                        const entriesState = temporaryEntriesStateByProject[session.projectId] ?? 'idle';
                        const entriesError = temporaryEntriesErrorByProject[session.projectId] ?? null;
                        return (
                          <div key={session.id} className={`project-node temporary-session-node ${isSelectedTemporaryProject ? 'selected' : ''}`}>
                            <button
                              type="button"
                              className={`project-root temporary-session-root${dropTargetClass('temporary', session.projectId, '')}`}
                              onClick={() => {
                                setActiveWorkspaceScope('temporary');
                                setSelectedTemporaryProjectId(session.projectId);
                                toggleTemporarySession(session);
                              }}
                              onDragOver={(event) => handleDropTargetDragOver(event, { workspaceScope: 'temporary', projectId: session.projectId, parentPath: '' })}
                              onDragLeave={() => setDragOverTargetKey(null)}
                              onDrop={(event) => void handleDropOnDirectory(event, { workspaceScope: 'temporary', projectId: session.projectId, parentPath: '' })}
                              onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'temporary', projectId: session.projectId })}
                              title={session.title}
                            >
                              <span className="node-icon">{isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                              <span className="node-main">
                                <strong>{session.title}</strong>
                                <small>{session.archivedAt ? '已归档' : `${session.messages.length} 条消息 · ${formatChatTime(session.updatedAt)}`}</small>
                              </span>
                            </button>
                            {!isCollapsed ? (
                              <div className="file-tree nested-tree">
                                {entriesState === 'error' ? <p className="inline-error">{entriesError}</p> : null}
                                {entriesState === 'loading' ? <p className="muted">正在加载临时文件...</p> : null}
                                {renderCreateEntryDraft('temporary', session.projectId, '', 0)}
                                {visibleTemporaryEntries.map((entry) => (
                                  <Fragment key={entry.path}>
                                    {renderRenameEntryDraft(entry, 'temporary', session.projectId) ?? (
                                      <button
                                        type="button"
                                        className={`file-node ${entry.type === 'directory' ? `directory-node${dropTargetClass('temporary', session.projectId, entry.path)}` : 'document-node'} ${isSelectedTemporaryProject && entry.path === selectedPath ? 'selected' : ''}`}
                                        draggable
                                        style={{ '--tree-depth': String(pathDepth(entry.path)) } as React.CSSProperties}
                                        onDragStart={(event) => handleEntryDragStart(event, 'temporary', session.projectId, entry)}
                                        onDragEnd={() => {
                                          setDragEntry(null);
                                          setDragOverTargetKey(null);
                                        }}
                                        onDragOver={entry.type === 'directory' ? (event) => handleDropTargetDragOver(event, { workspaceScope: 'temporary', projectId: session.projectId, parentPath: entry.path }) : undefined}
                                        onDragLeave={entry.type === 'directory' ? () => setDragOverTargetKey(null) : undefined}
                                        onDrop={entry.type === 'directory' ? (event) => void handleDropOnDirectory(event, { workspaceScope: 'temporary', projectId: session.projectId, parentPath: entry.path }) : undefined}
                                        onClick={() => {
                                          selectEntryForPreview('temporary', session.projectId, entry);
                                          if (entry.type === 'file') {
                                            setEditorPanelOpen(true);
                                          }
                                          if (entry.type === 'directory') {
                                            toggleTemporaryDirectory(session.projectId, entry.path);
                                          }
                                        }}
                                        onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'temporary', projectId: session.projectId, entry })}
                                        title={entry.path}
                                      >
                                        <span className="file-node-label">
                                          {entry.type === 'directory' ? (
                                            <span className="file-node-chevron">
                                              {(collapsedDirectoriesByTemporaryProject[session.projectId] ?? []).includes(entry.path) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                            </span>
                                          ) : null}
                                          <span className="file-node-icon">
                                            {entry.type === 'directory'
                                              ? (collapsedDirectoriesByTemporaryProject[session.projectId] ?? []).includes(entry.path) ? <Folder size={13} /> : <FolderOpen size={13} />
                                              : fileIconForPath(entry.path)}
                                          </span>
                                          <span>{entry.name}</span>
                                        </span>
                                        {entry.type === 'file' ? <small>{formatFileSize(entry.size)}</small> : null}
                                      </button>
                                    )}
                                    {entry.type === 'directory' ? renderCreateEntryDraft('temporary', session.projectId, entry.path, pathDepth(entry.path) + 1) : null}
                                  </Fragment>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
              {quickActionError ? <p className="inline-error">{quickActionError}</p> : null}
            </>
          ) : null}
            </div>
        </aside>
      ) : null}

      {editorPanelOpen ? (
      <section className="editor-panel">
        <EditorHeader
          tabs={previewTabs.visibleTabs}
          selectedTabId={previewTabs.selectedTabId}
          selectedMarkdownMode={previewTabs.selectedMarkdownMode}
          showMarkdownModeSwitch={selectedEntry?.type === 'file' && /\.(md|markdown)$/i.test(selectedEntry.path)}
          onSelectTab={previewTabs.selectTab}
          onCloseTab={previewTabs.closeTab}
          onOpenTabContextMenu={openPreviewTabContextMenu}
          onSetMarkdownMode={previewTabs.setSelectedMarkdownMode}
        />

        <div className="editor-scroll" onContextMenu={openSelectedTextContextMenu}>
              {!selectedEntry ? (
                <div className="editor-empty">
                  <div className="editor-empty__icon"><File size={48} /></div>
                  <h3 className="editor-empty__title">选择文件开始编辑</h3>
                  <p className="editor-empty__hint">从左侧工作区选择一个 Markdown 或文本文件</p>
                  <p className="editor-empty__shortcut">
                    <kbd>Ctrl</kbd>+<kbd>B</kbd> 切换工作区 &nbsp;
                    <kbd>Ctrl</kbd>+<kbd>J</kbd> 切换创作助手
                  </p>
                </div>
              ) : null}
              {selectedEntry?.type === 'directory' ? (
                <div className="editor-empty">
                  <div className="editor-empty__icon"><Folder size={48} /></div>
                  <h3 className="editor-empty__title">这是一个目录</h3>
                  <p className="editor-empty__hint">请选择其中的文本文件进行编辑</p>
                </div>
              ) : null}
              {selectedEntry?.type === 'file' ? (
                <>
                  {fileState === 'error' ? (
                    <div className="notice error-notice compact">
                      <h3>文件读取失败</h3>
                      <p>{fileError}</p>
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedPath) return;
                          if (activeWorkspaceScope === 'global') {
                            void loadGlobalFile(selectedPath);
                          } else if (activeProjectWorkspaceId) {
                            void loadFile(activeProjectWorkspaceId, selectedPath);
                          }
                        }}
                      >
                        重试读取
                      </button>
                    </div>
                  ) : null}
                  {renderEditorViewer({
                    entry: selectedEntry,
                    selectedProjectId: activeProjectWorkspaceId ?? 'global',
                    fileContent,
                    savedContent: lastSavedContent,
                    fileState,
                    fileError,
                    rawPreviewUrl,
                    workspaceEntries: activeEntries,
                    markdownMode: previewTabs.selectedMarkdownMode,
                    onChange: (content: string) => {
                      setFileContent(content);
                      setSaveState('idle');
                      setSaveError(null);
                    },
                    onNavigateToPath: navigateToMarkdownReference,
                  })}
                  {saveState === 'saved' ? <p className="success-text">已保存。</p> : null}
                  {saveState === 'error' ? <p className="inline-error">保存失败：{saveError}</p> : null}
                </>
              ) : null}
            </div>
      </section>
      ) : null}

      {editorPanelOpen && chatPanelOpen ? (
        <div
          className="panel-resizer"
          role="separator"
          aria-label="调整创作助手宽度"
          aria-orientation="vertical"
          onPointerDown={(event) => startPanelResize(event, 'chat')}
        />
      ) : null}

      {chatPanelOpen ? (
        <aside className={`chat-panel ${chatReadingMode ? 'chat-panel--reading' : ''}`}>
          <div className="chat-panel__header">
            <div className="chat-panel__mini-bar">
              <span className="mini-bar__title" title={activeChatSession?.title ?? '创作助手'}>
                {activeChatSession?.title ?? '创作助手'}
              </span>
              <span className={`status-pill ${runState}`} title={runError ? `运行失败：${runError}` : undefined}>
                {runStatusLabel(runState, currentRun)}
              </span>
            </div>
            <div className="chat-panel__heading">
              <div className="session-title-stack">
                <div className="session-title-line">
                  <h2>创作助手</h2>
                  <span className={`status-pill ${runState}`} title={runError ? `运行失败：${runError}` : undefined}>
                    {runStatusLabel(runState, currentRun)}
                  </span>
                </div>
                <span className="session-scope-line" title={activeChatScopeName}>
                  {activeChatScopeName} · {displayedChatSessions.length} 个会话
                </span>
              </div>
              <div className="session-heading-actions">
                <button
                  type="button"
                  className={`toolbar-button text-mode-button ${chatReadingMode ? 'active' : ''}`}
                  onClick={() => setChatReadingMode((current) => !current)}
                  aria-label={chatReadingMode ? '切换为紧凑字号' : '切换为阅读字号'}
                  title={chatReadingMode ? '紧凑字号' : '阅读字号'}
                >
                  <Type size={18} />
                </button>
                <button type="button" className="toolbar-button" onClick={createNewChatSession} aria-label="新建会话" title="新建会话">
                  <Plus size={18} />
                </button>
                <select
                  className="notify-mode-select"
                  value={runNotifyMode}
                  onChange={(event) => setRunNotifyMode(event.target.value as RunNotifyMode)}
                  title="运行完成通知方式"
                  aria-label="运行完成通知方式"
                >
                  <option value="off">通知：关</option>
                  <option value="sound">通知：声音</option>
                  <option value="wechat">通知：微信</option>
                  <option value="both">通知：声音+微信</option>
                </select>
              </div>
            </div>

            <div className="chat-session-rail">
              <div className="chat-session-view-toggle" aria-label="会话视图">
                <button
                  type="button"
                  className={chatSessionView === 'active' ? 'active' : ''}
                  onClick={() => {
                    setChatSessionView('active');
                    setActiveChatSessionId(projectChatSessions[0]?.id ?? null);
                  }}
                >
                  最近
                </button>
                <button
                  type="button"
                  className={chatSessionView === 'archived' ? 'active' : ''}
                  onClick={() => {
                    setChatSessionView('archived');
                    setActiveChatSessionId(archivedChatSessions[0]?.id ?? null);
                  }}
                >
                  归档
                </button>
              </div>
              <section className="chat-session-list" aria-label="历史会话">
                {displayedChatSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`chat-session-tab ${session.id === activeChatSession?.id ? 'active' : ''}`}
                    onClick={() => openChatSession(session.id)}
                    onContextMenu={(event) => openChatSessionContextMenu(event, session.id, session.title)}
                    title={`${session.title} · ${session.messages.length} 条 · ${formatChatTime(session.updatedAt)}`}
                  >
                    <span className="chat-session-tab__title">{session.title}</span>
                    <span className="chat-session-tab__meta">
                      {session.messages.length} · {formatChatTime(session.updatedAt)}
                    </span>
                  </button>
                ))}
                {displayedChatSessions.length === 0 ? (
                  <span className="chat-session-empty">{chatSessionView === 'archived' ? '暂无归档会话' : '暂无最近会话'}</span>
                ) : null}
              </section>
              <div className="chat-context-compact">
                {chatMode === 'assistant' && selectedProjectId ? (
                  <button
                    type="button"
                    className="chat-scope-switch"
                    onClick={() => switchChatScope(chatScope === 'project' ? 'temporary' : 'project')}
                    aria-label={chatScope === 'project' ? '切换到临时工作目录' : '切换到当前项目会话'}
                    title={chatScope === 'project' ? '切换到临时工作目录' : '切换到当前项目会话'}
                  >
                    {chatScope === 'project' ? '临时' : '项目'}
                  </button>
                ) : null}
              </div>
            </div>
          </div>

            <section className="chat-thread" ref={chatThreadRef}>
              {activeChatSession?.messages.length ? (
                activeChatSession.messages.map((message) => (
                  <ChatMessageItem
                    key={message.id}
                    message={message}
                    scheduledTasks={scheduledTasksBySession[activeChatSession.id] ?? []}
                    busyTaskId={scheduledTaskBusyId}
                    onTextSelection={handleChatTextSelection}
                    onOpenAttachment={handleOpenChatAttachment}
                    onRunScheduledTask={(taskId) => void runScheduledTaskNow(taskId, activeChatSession.id)}
                    onPauseScheduledTask={(taskId) => void pauseScheduledTask(taskId, activeChatSession.id)}
                    onResumeScheduledTask={(taskId) => void resumeScheduledTask(taskId, activeChatSession.id)}
                    onDeleteScheduledTask={(taskId) => void deleteScheduledTask(taskId, activeChatSession.id)}
                    onChoiceSelect={(option) => { setPrompt((prev) => prev.trim() ? `${prev}\n${option}` : option); }}
                  />
                ))
              ) : (
                <div className="chat-empty">
                  <p>从右侧直接开始和创作助手对话。</p>
                  <p className="muted">
                    {chatScope === 'project' && selectedProjectId
                      ? '输入 `@` 可以引用当前项目里的剧本、人物设定、分镜或制作文档。'
                      : '当前使用后台临时工作目录，不会出现在项目列表中。'}
                  </p>
                </div>
              )}
              <button
                type="button"
                className={`chat-scroll-bottom ${showScrollBottom ? 'visible' : ''}`}
                onClick={() => {
                  const thread = chatThreadRef.current;
                  if (thread) {
                    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
                    autoScrollRef.current = true;
                  }
                }}
                aria-label="滚动到底部"
                title="滚动到底部"
              >
                <ArrowDown size={16} />
              </button>
            </section>

            <section className="composer">
              {referencedFiles.length > 0 || referencedSnippets.length > 0 || imageReferenceDrafts.length > 0 ? (
                <div className="composer__ctx-row" role="list">
                  {referencedFiles.map((reference) => (
                    <span key={reference.path} className="ctx-chip" title={reference.path}>
                      <span className="ctx-chip__label">@{reference.label}</span>
                      <button type="button" className="ctx-chip__remove" onClick={() => removeReferencedFile(reference.path)} aria-label={`移除 ${reference.label}`}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  {referencedSnippets.map((snippet, snippetIndex) => (
                    <span key={snippet.id} className="ctx-chip ctx-chip--snippet" title={snippet.text}>
                      <span className="ctx-chip__number">{snippetIndex + 1}</span>
                      <span className="ctx-chip__label">{snippet.label}{'"'}{snippet.text.slice(0, 18)}{snippet.text.length > 18 ? '...' : ''}{'"'}</span>
                      <button type="button" className="ctx-chip__remove" onClick={() => removeReferencedSnippet(snippet.id)} aria-label={`移除 ${snippet.label}`}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  {imageReferenceDrafts.map((draft) => (
                    <span key={draft.id} className="ctx-chip ctx-chip--image" title={draft.name}>
                      <span className="ctx-chip__label">图：{draft.name}</span>
                      <button type="button" className="ctx-chip__remove" onClick={() => removeImageReferenceDraft(draft.id)} aria-label={`移除 ${draft.name}`}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="image-composer-options">
                <label>
                  <span>文本</span>
                  <select value={chatModel} onChange={(event) => setChatModel(event.target.value)} title={aigcHubModelError ?? '文本模型'}>
                    {modelOptionsWithSelected(chatModelOptions, chatModel, '').map((model) => (
                      <option key={model.id || '__default_chat__'} value={model.id}>{modelOptionLabel(model)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>图片</span>
                  <select value={imageModel} onChange={(event) => setImageModel(event.target.value)} title={aigcHubModelError ?? '图片模型'}>
                    {modelOptionsWithSelected(imageModelOptions, imageModel, '').map((model) => (
                      <option key={model.id || '__default_image__'} value={model.id}>{modelOptionLabel(model)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>比例</span>
                  <select value={imageAspectRatio} onChange={(event) => setImageAspectRatio(event.target.value as GeminiImageAspectRatio)}>
                    <option value="1:1">1:1</option>
                    <option value="16:9">16:9</option>
                    <option value="9:16">9:16</option>
                    <option value="4:3">4:3</option>
                    <option value="3:4">3:4</option>
                  </select>
                </label>
                <label>
                  <span>思考</span>
                  <select value={imageThinkingLevel} onChange={(event) => setImageThinkingLevel(event.target.value as ImageThinkingLevelOption)}>
                    <option value="default">默认</option>
                    <option value="minimal">最小</option>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                  </select>
                </label>
                <label>
                  <span>数量</span>
                  <select value={imageCount} onChange={(event) => setImageCount(Number(event.target.value))}>
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                  </select>
                </label>
                <button type="button" className="image-reference-button" onClick={() => imageReferenceInputRef.current?.click()}>
                  参考图
                </button>
                <input
                  ref={imageReferenceInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  className="visually-hidden"
                  onChange={(event) => void handleImageReferenceFiles(event.currentTarget.files)}
                />
              </div>
              <div className="composer__main">
                {referenceSuggestions.length > 0 && referenceQuery ? (
                  <div className="composer__menu" role="listbox" aria-label="引用文件">
                    {referenceSuggestions.map((suggestion, index) => (
                      <button
                        key={suggestion.path}
                        type="button"
                        className="composer__menu-item"
                        data-active={index === activeReferenceIndex || undefined}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          selectReferencedFile(suggestion);
                        }}
                      >
                        <span className="composer__menu-item__name">@{suggestion.label}</span>
                        <span className="composer__menu-item__desc">{suggestion.path}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  id="ai-prompt"
                  ref={composerRef}
                  className="composer__textarea"
                  value={prompt}
                  placeholder={activeChatSessionArchived ? '归档会话只读，恢复后可继续对话' : activeChatSessionQueuedCount >= 3 ? '当前会话已有 3 条消息排队，请稍后再发送' : activeChatSessionRunning ? '当前会话正在运行，继续发送将进入后台队列' : chatScope === 'project' && selectedProjectId ? '描述这一场戏、角色动机、对白要求或图片需求，输入 @ 引用项目文件' : '继续临时会话，可直接对话或生成图片'}
                  disabled={activeChatSessionArchived || activeChatSessionQueuedCount >= 3}
                  onChange={handleComposerChange}
                  onClick={(event) => updateReferenceMenu(prompt, event.currentTarget.selectionStart ?? prompt.length)}
                  onKeyDown={handleComposerKeyDown}
                />
                {runState === 'running' ? (
                  <button
                    type="button"
                    className="composer__stop"
                    onClick={() => { void stopRun(); }}
                    aria-label="停止"
                    title="停止运行"
                  >
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="composer__send"
                    disabled={activeChatSessionArchived || activeChatSessionQueuedCount >= 3 || !prompt.trim()}
                    onClick={() => void submitPrompt()}
                    aria-label="发送"
                    title={activeChatSessionQueuedCount >= 3 ? '当前会话排队已满' : activeChatSessionRunning ? '发送并排队' : '发送'}
                  >
                    <Send size={16} />
                  </button>
                )}
              </div>
            </section>
        </aside>
      ) : null}
      </div>

      {activeToolPanel ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setActiveToolPanel(null)}>
          <section className="modal-panel" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{toolPanelEyebrow(activeToolPanel)}</p>
                <h2>{toolPanelTitle(activeToolPanel)}</h2>
              </div>
              <button type="button" onClick={() => setActiveToolPanel(null)}>关闭</button>
            </div>

            {activeToolPanel === 'connectors' ? (
              <ConnectorsPanel
                browserStatus={browserStatus}
                browserLoading={browserLoading}
                onRefreshBrowser={() => void loadBrowserStatus()}
                wechatStatus={wechatStatus}
                wechatSetup={wechatSetup}
                wechatLoading={wechatState === 'loading'}
                onCreateWechatSetup={() => void createWechatSetup()}
                onDisconnectWechat={async () => { await apiClient.disconnectWechat(); await loadWechatStatus(); }}
              />
            ) : null}

            {activeToolPanel === 'git' ? (
              <GitSyncPanel
                apiClient={apiClient}
                projects={projects}
                selectedProjectId={selectedProjectId}
              />
            ) : null}

            {activeToolPanel === 'settings' ? (
              <RuntimeSettingsPanel
                config={runtimeConfig}
                releaseInfo={releaseInfo}
                state={runtimeConfigState}
                chatModelOptions={chatModelOptions}
                imageModelOptions={imageModelOptions}
                embeddingModelOptions={embeddingModelOptions}
                onReload={() => void loadRuntimeConfig()}
                onSave={(input) => void saveRuntimeConfig(input)}
                onConfirmEmbeddingChange={() => showConfirm({
                  title: '确认修改 Embedding 配置',
                  message: '修改 Embedding 模型、接口或向量维度后，已有长期记忆向量索引需要重建。保存后系统会暂停旧索引检索和新语义记忆写入，直到完成重建。',
                  danger: true,
                  confirmLabel: '确认修改',
                })}
              />
            ) : null}

          </section>
        </div>
      ) : null}

      {scheduleOverviewOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setScheduleOverviewOpen(false)}>
          <section className="schedule-overview-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-overview-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="schedule-overview-heading">
              <div>
                <p className="eyebrow">Scheduled Work</p>
                <h2 id="schedule-overview-title">定时任务</h2>
                <span>{selectedProjectId ? projectName(projects, selectedProjectId) : '当前工作区'} · {allScheduledTasks.length} 个任务</span>
              </div>
              <div className="schedule-overview-actions">
                <button type="button" className="confirm-dialog__btn" onClick={() => selectedProjectId ? void loadProjectScheduledTasks(selectedProjectId) : activeChatSession ? void loadScheduledTasks(activeChatSession.id) : undefined}>刷新</button>
                <button type="button" className="confirm-dialog__btn" onClick={() => setScheduleOverviewOpen(false)}>关闭</button>
              </div>
            </div>

            <ScheduleOverviewBody
              tasks={allScheduledTasks}
              sessions={chatSessions}
              projects={projects}
              busyTaskId={scheduledTaskBusyId}
              onRunNow={(task) => void runScheduledTaskNow(task.id, task.sessionId)}
              onPause={(task) => void pauseScheduledTask(task.id, task.sessionId)}
              onResume={(task) => void resumeScheduledTask(task.id, task.sessionId)}
              onDelete={(task) => void deleteScheduledTask(task.id, task.sessionId)}
              onOpenSession={(task) => {
                const session = chatSessions.find((item) => item.id === task.sessionId);
                if (session) {
                  setChatScope(isTemporaryProjectId(session.projectId) ? 'temporary' : 'project');
                  if (!isTemporaryProjectId(session.projectId)) setSelectedProjectId(session.projectId);
                  openChatSession(session.id);
                }
                setScheduleOverviewOpen(false);
              }}
            />
          </section>
        </div>
      ) : null}

      {createProjectDialogOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !isCreatingProject && setCreateProjectDialogOpen(false)}>
          <section className="create-project-dialog" role="dialog" aria-modal="true" aria-labelledby="create-project-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="create-project-dialog__heading">
              <div>
                <p className="eyebrow">New Workspace</p>
                <h2 id="create-project-title">新建项目</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setCreateProjectDialogOpen(false)} disabled={isCreatingProject} aria-label="关闭" title="关闭">
                <X size={16} />
              </button>
            </div>

            <div className="create-project-dialog__field">
              <span>项目类型</span>
              <div className="product-type-grid">
                {SELECTABLE_PRODUCT_PROFILES.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={`product-type-option${createProjectDraft.productId === profile.id ? ' is-selected' : ''}`}
                    onClick={() => setCreateProjectDraft({
                      productId: profile.id,
                      name: profile.defaultProjectName,
                      description: profile.defaultProjectDescription,
                    })}
                  >
                    <strong>{productTypeLabel(profile.id)}</strong>
                    <small>{profile.defaultProjectDescription}</small>
                  </button>
                ))}
              </div>
            </div>

            <label className="create-project-dialog__field">
              <span>项目名称</span>
              <input
                value={createProjectDraft.name}
                onChange={(event) => setCreateProjectDraft((draft) => ({ ...draft, name: event.target.value }))}
                placeholder="输入项目名称"
                autoFocus
              />
            </label>

            <label className="create-project-dialog__field">
              <span>项目描述</span>
              <textarea
                value={createProjectDraft.description}
                onChange={(event) => setCreateProjectDraft((draft) => ({ ...draft, description: event.target.value }))}
                placeholder="一句话描述题材"
              />
            </label>

            {createProjectError ? <p className="inline-error">{createProjectError}</p> : null}

            <div className="create-project-dialog__actions">
              <button type="button" className="confirm-dialog__btn" onClick={() => setCreateProjectDialogOpen(false)} disabled={isCreatingProject}>取消</button>
              <button
                type="button"
                className="confirm-dialog__btn confirm-dialog__btn--primary"
                onClick={() => void submitCreateProjectDialog()}
                disabled={isCreatingProject || !createProjectDraft.name.trim()}
              >
                {isCreatingProject ? '创建中...' : '创建'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {sidebarContextMenu ? (
        <div
          className="sidebar-context-menu"
          style={{ left: sidebarContextMenu.x, top: sidebarContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => void runSidebarAction('new-project')}>新建项目</button>
          {sidebarContextMenu.workspaceScope === 'global' || sidebarContextMenu.projectId ? (
            <>
              <button type="button" onClick={() => void runSidebarAction('new-folder')}>新建目录</button>
              <button type="button" onClick={() => void runSidebarAction('new-file')}>新建文档</button>
              <button type="button" onClick={() => void runSidebarAction('upload')}>上传素材</button>
              <button type="button" onClick={() => void runSidebarAction('upload-folder')}>上传文件夹</button>
            </>
          ) : null}
          {sidebarContextMenu.workspaceScope === 'project' && sidebarContextMenu.projectId && !sidebarContextMenu.entryPath ? (
            <>
              <div className="context-menu-separator" />
              <button type="button" onClick={() => void runSidebarAction('rename-project')}>重命名项目</button>
              <button type="button" className="danger-item" onClick={() => void runSidebarAction('delete-project')}>
                删除项目
              </button>
            </>
          ) : null}
          {sidebarContextMenu.entryPath ? (
            <>
              <div className="context-menu-separator" />
              <button type="button" onClick={() => void runSidebarAction('rename')}>重命名</button>
              <button type="button" onClick={() => void runSidebarAction('move')}>移动</button>
              <button type="button" className="danger-item" onClick={() => void runSidebarAction('delete')}>删除</button>
            </>
          ) : null}
        </div>
      ) : null}
      {chatSessionContextMenu ? (
        <div
          className="sidebar-context-menu"
          style={{ left: chatSessionContextMenu.x, top: chatSessionContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => void renameChatSession(chatSessionContextMenu)}>重命名</button>
          {chatSessions.find((session) => session.id === chatSessionContextMenu.sessionId)?.archivedAt ? (
            <button type="button" onClick={() => void restoreChatSession(chatSessionContextMenu.sessionId)}>恢复会话</button>
          ) : (
            <button type="button" onClick={() => void archiveChatSession(chatSessionContextMenu.sessionId)}>归档会话</button>
          )}
          <div className="context-menu-separator" />
          <button type="button" className="danger-item" onClick={() => void deleteChatSession(chatSessionContextMenu)}>
            删除
          </button>
        </div>
      ) : null}
      {previewTabs.contextMenu ? (
        <ContextMenu
          x={previewTabs.contextMenu.x}
          y={previewTabs.contextMenu.y}
          onClose={previewTabs.closeContextMenu}
          items={buildPreviewTabContextMenuItems(previewTabs)}
        />
      ) : null}
      {selectedTextContextMenu ? (
        <div
          className="sidebar-context-menu"
          style={{ left: selectedTextContextMenu.x, top: selectedTextContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" onClick={quoteSelectedTextToComposer}>引入到会话</button>
          <button type="button" onClick={() => void copySelectedText()}>复制文字</button>
        </div>
      ) : null}

      {toasts.length > 0 ? (
        <div className="toast-container">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`toast toast--${toast.type}`}
              onClick={() => dismissToast(toast.id)}
              role="status"
            >
              <span className="toast__message">{toast.message}</span>
              <button type="button" className="toast__dismiss" onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); }}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDialogState !== null}
        title={confirmDialogState?.title ?? ''}
        message={confirmDialogState?.message}
        confirmLabel={confirmDialogState?.confirmLabel}
        cancelLabel={confirmDialogState?.cancelLabel}
        danger={confirmDialogState?.danger}
        promptMode={confirmDialogState?.promptMode}
        promptPlaceholder={confirmDialogState?.promptPlaceholder}
        promptInitialValue={confirmDialogState?.promptInitialValue}
        requireMatch={confirmDialogState?.requireMatch}
        onConfirm={confirmDialogState?.onConfirm ?? (() => {})}
        onCancel={confirmDialogState?.onCancel ?? (() => {})}
      />
    </div>
  );
}

function HarnessStandalonePage(): JSX.Element {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    writeStoredThemeMode(themeMode);
  }, [themeMode]);

  return (
    <div className="harness-standalone-shell">
      <header className="harness-standalone-header">
        <div>
          <p className="eyebrow">Agent Harness</p>
          <h1>Agent 优化闭环</h1>
        </div>
        <button type="button" onClick={() => setThemeMode(nextThemeMode(themeMode))}>切换主题</button>
      </header>
      <HarnessPanel apiClient={apiClient} standalone />
    </div>
  );
}

function isSupportedTextFile(path: string): boolean {
  return TEXT_FILE_PATTERN.test(path);
}

function buildPreviewTabContextMenuItems(previewTabs: ReturnType<typeof usePreviewTabs>): ContextMenuItem[] {
  const tabId = previewTabs.contextMenu?.tabId;
  if (!tabId) return [];

  const availability = previewTabs.getCloseAvailability(tabId);
  const items: ContextMenuItem[] = [];
  if (availability.canCloseLeft) {
    items.push({ label: '关闭左侧', onClick: () => previewTabs.closeTabsByMode(tabId, 'left') });
  }
  if (availability.canCloseRight) {
    items.push({ label: '关闭右侧', onClick: () => previewTabs.closeTabsByMode(tabId, 'right') });
  }
  if (availability.canCloseOthers) {
    items.push({ label: '关闭其它', onClick: () => previewTabs.closeTabsByMode(tabId, 'others') });
  }
  if (availability.canCloseAll) {
    if (items.length > 0) items.push({ separator: true });
    items.push({ label: '关闭全部', danger: true, onClick: () => previewTabs.closeTabsByMode(tabId, 'all') });
  }
  return items;
}

function encodeWorkspacePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
}

function parentDirectory(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function imageThinkingLevelLabel(level: ImageThinkingLevelOption): string {
  switch (level) {
    case 'minimal':
      return '最小';
    case 'low':
      return '低';
    case 'medium':
      return '中';
    case 'high':
      return '高';
    case 'default':
    default:
      return '默认';
  }
}

const SNIPPET_PREVIEW_LENGTH = 48;

function CollapsibleSnippet({ snippet, index }: { snippet: ReferencedChatSnippet; index: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const preview = snippet.text.length > SNIPPET_PREVIEW_LENGTH
    ? `${snippet.text.slice(0, SNIPPET_PREVIEW_LENGTH)}...`
    : snippet.text;
  const isFileSource = snippet.messageId.startsWith('/') || snippet.messageId.includes('.');
  const displayLabel = isFileSource ? snippet.label || '文件' : snippet.label || '引用';

  return (
    <div className={`chat-ref-snippet ${open ? 'open' : ''}`}>
      <div
        className="chat-ref-snippet__head"
        onClick={() => setOpen((prev) => !prev)}
        role="button"
        aria-expanded={open}
        title={open ? '收起' : '展开查看完整内容'}
      >
        <span className="chat-ref-snippet__number">{index}</span>
        <span className="chat-ref-snippet__icon">
          {isFileSource ? <File size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="chat-ref-snippet__label">{displayLabel}</span>
        <span className="chat-ref-snippet__preview">
          {preview}
        </span>
      </div>
      {open ? (
        <div className="chat-ref-snippet__body">{snippet.text}</div>
      ) : null}
    </div>
  );
}

const ChatMessageItem = memo(function ChatMessageItem({
  message,
  scheduledTasks,
  busyTaskId,
  onTextSelection,
  onOpenAttachment,
  onRunScheduledTask,
  onPauseScheduledTask,
  onResumeScheduledTask,
  onDeleteScheduledTask,
  onChoiceSelect,
}: {
  message: ChatMessage;
  scheduledTasks: ScheduledTask[];
  busyTaskId: string | null;
  onTextSelection: ChatMessageTextSelectionHandler;
  onOpenAttachment: (attachment: ChatMessageAttachment) => void;
  onRunScheduledTask: (taskId: string) => void;
  onPauseScheduledTask: (taskId: string) => void;
  onResumeScheduledTask: (taskId: string) => void;
  onDeleteScheduledTask: (taskId: string) => void;
  onChoiceSelect?: (option: string) => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const canCopy = message.content.trim().length > 0;
  const messageScheduledTasks = useMemo(() => scheduledTasksFromMessage(message, scheduledTasks), [message, scheduledTasks]);

  async function copyMessageContent() {
    if (!canCopy) {
      return;
    }
    await copyTextToClipboard(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <div className="chat-avatar">{message.role === 'user' ? '我' : 'AI'}</div>
      <div className="chat-bubble-wrap">
        <div className="chat-meta">
          <span>{message.role === 'user' ? '你' : '创作助手'}</span>
          <time dateTime={message.createdAt}>{formatChatTime(message.createdAt)}</time>
        </div>
        {message.referencedFiles.length > 0 || (message.referencedSnippets?.length ?? 0) > 0 ? (
          <div className="chat-reference-row">
            {message.referencedFiles.map((reference) => (
              <span key={`${message.id}-${reference.path}`} className="ctx-chip" title={reference.path}>
                @{reference.label}
              </span>
            ))}
            {message.referencedSnippets?.map((snippet, snippetIndex) => (
              <CollapsibleSnippet key={`${message.id}-${snippet.id}`} snippet={snippet} index={snippetIndex + 1} />
            ))}
          </div>
        ) : null}
        <div
          className={`chat-bubble ${message.role === 'assistant' ? 'chat-bubble--assistant' : 'chat-bubble--user'}`}
          onMouseUp={(event) => onTextSelection(event, message)}
          onContextMenu={(event) => onTextSelection(event, message)}
        >
          <button
            type="button"
            className="chat-copy-button"
            data-copied={copied || undefined}
            disabled={!canCopy}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              void copyMessageContent();
            }}
            aria-label={copied ? '已复制' : '复制消息'}
            title={copied ? '已复制' : '复制'}
          />
          {message.role === 'assistant' ? (
            <AssistantStreamBody message={message} onChoiceSelect={onChoiceSelect} />
          ) : (
            <p>{message.content}</p>
          )}
          {message.attachments?.length ? (
            <div className="chat-image-grid">
              {message.attachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  className={`chat-image-card chat-image-card--${attachment.kind}`}
                  onClick={() => onOpenAttachment(attachment)}
                  title={`${attachment.name} · ${attachment.path}`}
                >
                  <img
                    src={resolveApiUrl(`/api/projects/${encodeURIComponent(attachment.projectId)}/raw/${encodeWorkspacePath(attachment.path)}`)}
                    alt={attachment.name}
                  />
                  <span>{attachment.kind === 'reference-image' ? '参考' : '生成'} · {attachment.aspectRatio ?? ''}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {messageScheduledTasks.length > 0 ? (
          <div className="chat-schedule-card-list">
            {messageScheduledTasks.map((task) => (
              <ScheduledTaskCard
                key={`${message.id}-${task.id}`}
                task={task}
                busy={busyTaskId === task.id}
                variant="message"
                onRunNow={onRunScheduledTask}
                onPause={onPauseScheduledTask}
                onResume={onResumeScheduledTask}
                onDelete={onDeleteScheduledTask}
              />
            ))}
          </div>
        ) : null}
        {message.role === 'assistant' && message.events && message.events.length > 0 ? (
          <details className="chat-events">
            <summary>执行详情</summary>
            <div className="chat-event-list">
              {message.events.map((event, index) => (
                <div key={`${message.id}-${event.type}-${index}`} className="chat-event-item">
                  <strong>{event.type}</strong>
                  <span>{eventSummary(event)}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
});

function timestampFromIso(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function pickPreferredChatSession(sessions: ChatSession[], preferredSessionId: string | null, view: ChatSessionView): ChatSession | null {
  const sortedSessions = [...sessions].sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt));
  const preferredSession = preferredSessionId
    ? sortedSessions.find((session) => session.id === preferredSessionId) ?? null
    : null;

  return preferredSession
    ?? sortedSessions.find((session) => sessionMatchesView(session, view))
    ?? sortedSessions.find((session) => !session.archivedAt)
    ?? sortedSessions[0]
    ?? null;
}

function sessionMatchesView(session: ChatSession, view: ChatSessionView): boolean {
  return view === 'archived' ? Boolean(session.archivedAt) : !session.archivedAt;
}

function hashCode(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index);
  }
  return hash;
}

function createSnippetReferenceId(input: Extract<SelectedTextContextMenu, { source: 'chat' }>): string {
  return `snippet-${input.messageId}-${Math.abs(hashCode(`${input.messageId}:${input.text}`)).toString(36)}`;
}

function getSelectedTextFromEvent(event: React.MouseEvent): string {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return start === end ? '' : target.value.slice(start, end);
  }

  return window.getSelection()?.toString() ?? '';
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to a hidden textarea for browsers that deny Clipboard API in local dev.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();

  if (!copied) {
    throw new Error('复制失败');
  }
}

function readStoredChatReadingMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(CHAT_READING_MODE_STORAGE_KEY) === 'true';
}

function writeStoredChatReadingMode(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(CHAT_READING_MODE_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage failures; the toggle still works for the current session.
  }
}

function readStoredModel(storageKey: string): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(storageKey) || '';
}

function writeStoredModel(storageKey: string, model: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (model) {
      window.localStorage.setItem(storageKey, model);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Ignore storage failures; the selected model still works for this page session.
  }
}

function readStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }

  const themeMode = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
  return themeMode === 'dark' || themeMode === 'soft' ? themeMode : 'light';
}

function writeStoredThemeMode(themeMode: ThemeMode): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
  } catch {
    // Ignore storage failures; theme switching still works for the current session.
  }
}

function nextThemeMode(themeMode: ThemeMode): ThemeMode {
  if (themeMode === 'light') {
    return 'dark';
  }
  if (themeMode === 'dark') {
    return 'soft';
  }
  return 'light';
}

function themeModeLabel(themeMode: ThemeMode): string {
  if (themeMode === 'light') {
    return '明亮';
  }
  if (themeMode === 'dark') {
    return '黑暗';
  }
  return '柔和';
}

function themeModeIcon(themeMode: ThemeMode): string {
  if (themeMode === 'light') {
    return '☼';
  }
  if (themeMode === 'dark') {
    return '◐';
  }
  return '◌';
}

function readStoredSelectedProjectId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY) || null;
}

function writeStoredSelectedProjectId(projectId: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (projectId) {
      window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
    } else {
      window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures; selection still works for the current session.
  }
}

function readStoredChatScope(): ChatScope | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const scope = window.localStorage.getItem(CHAT_SCOPE_STORAGE_KEY);
  return scope === 'project' || scope === 'temporary' ? scope : null;
}

function writeStoredChatScope(scope: ChatScope): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(CHAT_SCOPE_STORAGE_KEY, scope);
  } catch {
    // Ignore storage failures; scope still works for the current session.
  }
}

function readStoredWorkspaceSelection(): StoredWorkspaceSelection | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY) ?? 'null') as Partial<StoredWorkspaceSelection> | null;
    if (!parsed) {
      return null;
    }

    return {
      activeWorkspaceScope: isWorkspaceScope(parsed.activeWorkspaceScope) ? parsed.activeWorkspaceScope : 'global',
      selectedProjectPath: typeof parsed.selectedProjectPath === 'string' ? parsed.selectedProjectPath : null,
      selectedGlobalPath: typeof parsed.selectedGlobalPath === 'string' ? parsed.selectedGlobalPath : null,
      selectedTemporaryProjectId: typeof parsed.selectedTemporaryProjectId === 'string' ? parsed.selectedTemporaryProjectId : null,
      selectedTemporaryPath: typeof parsed.selectedTemporaryPath === 'string' ? parsed.selectedTemporaryPath : null,
    };
  } catch {
    return null;
  }
}

function writeStoredWorkspaceSelection(selection: StoredWorkspaceSelection): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Ignore storage failures; selection still works for the current session.
  }
}

function isWorkspaceScope(value: unknown): value is WorkspaceScope {
  return value === 'global' || value === 'project' || value === 'temporary';
}

function readInitialActiveChatSessionId(): string | null {
  const chatScope = readStoredChatScope() ?? (readStoredSelectedProjectId() ? 'project' : 'temporary');
  const stored = readStoredActiveChatSession();

  if (chatScope === 'project') {
    const projectId = readStoredSelectedProjectId();
    return projectId ? stored.projectSessionIds[projectId] ?? null : null;
  }

  return stored.temporarySessionId ?? readStoredTemporaryChatSession()?.sessionId ?? null;
}

function readStoredActiveChatSession(): StoredActiveChatSession {
  const fallback: StoredActiveChatSession = {
    projectSessionIds: {},
    temporarySessionId: null,
    chatSessionView: 'active',
  };

  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(ACTIVE_CHAT_SESSION_STORAGE_KEY) ?? 'null') as Partial<StoredActiveChatSession> | null;
    if (!parsed) {
      return fallback;
    }

    const projectSessionIds = parsed.projectSessionIds && typeof parsed.projectSessionIds === 'object' && !Array.isArray(parsed.projectSessionIds)
      ? Object.fromEntries(
        Object.entries(parsed.projectSessionIds).filter((entry): entry is [string, string] => (
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
        )),
      )
      : {};

    return {
      projectSessionIds,
      temporarySessionId: typeof parsed.temporarySessionId === 'string' ? parsed.temporarySessionId : null,
      chatSessionView: parsed.chatSessionView === 'archived' ? 'archived' : 'active',
    };
  } catch {
    return fallback;
  }
}

function writeStoredActiveChatSession(value: StoredActiveChatSession): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(ACTIVE_CHAT_SESSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage failures; the backend session still exists for the current page lifetime.
  }
}

function readStoredPanelVisibility(): { sidebarOpen: boolean; editorPanelOpen: boolean; chatPanelOpen: boolean } {
  const fallback = { sidebarOpen: false, editorPanelOpen: true, chatPanelOpen: true };
  if (typeof window === 'undefined') return fallback;

  try {
    const parsed = JSON.parse(window.localStorage.getItem(PANEL_VISIBILITY_STORAGE_KEY) ?? 'null') as Partial<typeof fallback> | null;
    if (!parsed) return fallback;
    return {
      sidebarOpen: typeof parsed.sidebarOpen === 'boolean' ? parsed.sidebarOpen : fallback.sidebarOpen,
      editorPanelOpen: typeof parsed.editorPanelOpen === 'boolean' ? parsed.editorPanelOpen : fallback.editorPanelOpen,
      chatPanelOpen: typeof parsed.chatPanelOpen === 'boolean' ? parsed.chatPanelOpen : fallback.chatPanelOpen,
    };
  } catch {
    return fallback;
  }
}

function initialPanelWidths(): { workspace: number; chat: number } {
  const visibility = readStoredPanelVisibility();
  if (typeof window === 'undefined') {
    return { workspace: DEFAULT_WORKSPACE_PANEL_WIDTH, chat: 520 };
  }

  const railWidth = 52;
  const availableWidth = window.innerWidth
    - railWidth
    - (visibility.sidebarOpen ? DEFAULT_WORKSPACE_PANEL_WIDTH : 0)
    - (visibility.editorPanelOpen && visibility.chatPanelOpen ? 6 : 0);
  const matchedEditorWidth = Math.floor(availableWidth / 2);
  const maxWidth = Math.max(CHAT_PANEL_MIN_WIDTH, window.innerWidth - 96);
  return {
    workspace: DEFAULT_WORKSPACE_PANEL_WIDTH,
    chat: clamp(matchedEditorWidth, CHAT_PANEL_MIN_WIDTH, maxWidth),
  };
}

function writeStoredPanelVisibility(value: { sidebarOpen: boolean; editorPanelOpen: boolean; chatPanelOpen: boolean }): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(PANEL_VISIBILITY_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage failures; panel toggles still work for the current session.
  }
}

function writeStoredProjectActiveChatSession(projectId: string, sessionId: string): void {
  const stored = readStoredActiveChatSession();
  writeStoredActiveChatSession({
    ...stored,
    projectSessionIds: { ...stored.projectSessionIds, [projectId]: sessionId },
  });
}

function writeStoredTemporaryActiveChatSession(sessionId: string): void {
  const stored = readStoredActiveChatSession();
  writeStoredActiveChatSession({
    ...stored,
    temporarySessionId: sessionId,
  });
}

function writeStoredActiveChatSessionView(chatSessionView: ChatSessionView): void {
  const stored = readStoredActiveChatSession();
  writeStoredActiveChatSession({
    ...stored,
    chatSessionView,
  });
}

function isSessionInActiveChatScope(session: ChatSession, chatScope: ChatScope, selectedProjectId: string | null): boolean {
  return chatScope === 'temporary'
    ? isTemporaryProjectId(session.projectId)
    : Boolean(selectedProjectId && session.projectId === selectedProjectId);
}

function isSessionInActiveChatMode(session: ChatSession, chatMode: ChatMode, chatScope: ChatScope, selectedProjectId: string | null): boolean {
  return isSessionInActiveChatScope(session, chatScope, selectedProjectId) && getSessionKind(session) === 'assistant';
}

function getSessionKind(session: ChatSession): ChatMode {
  return session.kind === 'image' ? 'image' : 'assistant';
}

function isTemporaryProjectId(projectId: string): boolean {
  return projectId.startsWith('temp-');
}

function productTypeLabel(productId: string): string {
  if (productId === 'novel-adaptation') return '剧本改编';
  if (productId === 'sitcom') return '情景剧创作';
  if (productId === 'study') return '日常学习';
  return '创作项目';
}

function readStoredTemporaryChatSession(): { projectId: string; sessionId: string | null } | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(TEMPORARY_CHAT_SESSION_STORAGE_KEY) ?? 'null') as Partial<{ projectId: unknown; sessionId: unknown }> | null;
    if (!parsed || typeof parsed.projectId !== 'string') {
      return null;
    }
    return {
      projectId: parsed.projectId,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    };
  } catch {
    return null;
  }
}

function writeStoredTemporaryChatSession(value: { projectId: string; sessionId: string | null }): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(TEMPORARY_CHAT_SESSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage failures; the backend session still exists for the current page lifetime.
  }
}

function clearStoredTemporaryChatSession(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.removeItem(TEMPORARY_CHAT_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

const FILE_ICON_MAP: Record<string, (props: { size?: number }) => JSX.Element> = {
  md: FileText,
  markdown: FileText,
  txt: FileText,
  pug: FileText,
  html: FileCode,
  htm: FileCode,
  css: FileCode,
  js: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  json: Braces,
  yaml: Braces,
  yml: Braces,
  toml: Braces,
  csv: Hash,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  mp4: FileVideo,
  webm: FileVideo,
  mov: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
};

function fileIconForPath(path: string, size = 12): JSX.Element {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const Icon = FILE_ICON_MAP[ext];
  return Icon ? <Icon size={size} /> : <File size={size} />;
}

function joinWorkspacePath(base: string | null, leaf: string): string {
  return [base, leaf].filter(Boolean).join('/');
}


function uploadRelativePath(file: File): string {
  const path = 'webkitRelativePath' in file && typeof file.webkitRelativePath === 'string'
    ? file.webkitRelativePath
    : '';
  return path || file.name;
}

function entryTitleFromPath(path: string): string {
  return path.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') || '新文档';
}

function pathDepth(path: string): number {
  return Math.max(0, path.split('/').filter(Boolean).length - 1);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^;]+;base64,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(size?: number): string {
  if (typeof size !== 'number') {
    return '';
  }

  if (size < 1024) {
    return `${size} B`;
  }

  return `${(size / 1024).toFixed(1)} KB`;
}

function runStatusLabel(runState: RunState, run: AgentRun | null): string {
  if (runState === 'idle') {
    return '未运行';
  }

  if (runState === 'queued') {
    return '排队中';
  }

  if (runState === 'running') {
    return '运行中';
  }

  return run?.status ?? runState;
}

function hasRunningAssistantMessage(session: ChatSession): boolean {
  return session.messages.some((message) => message.role === 'assistant' && message.status === 'running');
}

function countQueuedAssistantMessages(session: ChatSession): number {
  return session.messages.filter((message) => message.role === 'assistant' && message.status === 'queued').length;
}

function eventSummary(event: RunEvent): string {
  switch (event.type) {
    case 'run.start':
      return `Run ${event.runId} started.`;
    case 'text.delta':
    case 'text.message':
      return event.text;
    case 'tool.use':
      return `${event.name}${event.input ? ` ${JSON.stringify(event.input)}` : ''}`;
    case 'tool.input':
      return `${event.name} ${event.inputText}`;
    case 'tool.result':
      return `${event.name}${event.output ? ` ${JSON.stringify(event.output)}` : ''}`;
    case 'file.changed':
      return `${event.path} ${event.change}`;
    case 'memory.read':
      return `读取项目记忆 ${event.bytes} bytes`;
    case 'memory.write':
      return `写入项目记忆 ${event.memoryType}: ${event.content.slice(0, 80)}`;
    case 'memory.recall':
      return `召回项目记忆 ${event.matches.length} 条：${event.query}`;
    case 'knowledge.retrieve':
      return `检索知识卡 ${event.matches.length} 条：${event.query}`;
    case 'agent.step.start':
      return `${event.phase} ${event.agentId} 第 ${event.iteration} 轮开始`;
    case 'agent.step.end':
      return `${event.phase} ${event.agentId} 第 ${event.iteration} 轮 ${event.status}`;
    case 'agent.review.reject':
      return `${event.targetAgentId} 第 ${event.iteration} 轮打回：${event.reasons.join('；')}`;
    case 'agent.workflow.end':
      return event.outputPath ? `${event.status}: ${event.outputPath}` : event.status;
    case 'run.end':
      return event.error ? `${event.status}: ${event.error}` : event.status;
  }
}

function createChatMessage(
  role: ChatMessage['role'],
  content: string,
  options: {
    events?: RunEvent[];
    referencedFiles?: ReferencedFile[];
    referencedSnippets?: ReferencedChatSnippet[];
    streamEvents?: StreamEvent[];
    attachments?: ChatMessageAttachment[];
    status?: RunState;
    runId?: string;
  } = {},
): ChatMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: options.runId,
    role,
    content,
    createdAt: new Date().toISOString(),
    attachments: options.attachments ?? [],
    events: options.events,
    referencedFiles: options.referencedFiles ?? [],
    referencedSnippets: options.referencedSnippets ?? [],
    streamEvents: options.streamEvents ?? [],
    status: options.status,
  };
}

function readImageReferenceDraft(file: File): Promise<ImageReferenceDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const [, contentBase64 = ''] = result.split(',', 2);
      resolve({
        id: `image-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mimeType: file.type || 'image/png',
        contentBase64,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('参考图读取失败'));
    reader.readAsDataURL(file);
  });
}

function assistantMessageFromEvents(events: RunEvent[]): string {
  const text = events
    .filter((event): event is Extract<RunEvent, { type: 'text.delta' | 'text.message' }> =>
      event.type === 'text.delta' || event.type === 'text.message',
    )
    .map((event) => event.text)
    .join('\n\n');

  return text || '已完成。';
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function userFacingRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message || '未知错误';
}

function isImageGenerationPrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || /(不要|无需|不用|别).{0,8}(生成|创建|画|绘制|出图|生图|图片|图像)/.test(normalized)) {
    return false;
  }

  return /(?:生成|创建|制作|画|绘制|出|生)(?:一张|张|个|幅|套|组)?[^，。！？\n]{0,24}(?:图片|图像|插画|海报|封面|剧照|分镜图|角色图|场景图|概念图|视觉图|表情包)/.test(normalized)
    || /(?:图片|图像|插画|海报|封面|剧照|分镜图|角色图|场景图|概念图|视觉图|表情包)[^，。！？\n]{0,24}(?:生成|创建|制作|画|绘制|出图|生图)/.test(normalized)
    || /(?:出图|生图|画一张|画个|画幅|draw an image|generate an image|create an image|make an image)/.test(normalized);
}

function modelsForCapability(models: AigcHubModelMetadata[], capability: 'chat' | 'image' | 'embedding'): AigcHubModelMetadata[] {
  const filtered = models.filter((model) => modelSupportsCapability(model, capability));
  return filtered.length > 0 ? filtered : models;
}

function modelSupportsCapability(model: AigcHubModelMetadata, capability: 'chat' | 'image' | 'embedding'): boolean {
  const id = model.id.toLowerCase();
  const caps = model.capabilities.join(' ').toLowerCase();

  if (capability === 'chat') {
    if (caps) return /chat|text|response|responses|completion|completions|tool/.test(caps);
    return !/image|dall[-_]?e|flux|sdxl|stable[-_]?diffusion|midjourney|embedding|embed/.test(id);
  }
  if (capability === 'embedding') {
    if (caps) return /embed|embedding|vector/.test(caps);
    return /embed|embedding|bge|e5|text-embedding/.test(id);
  }
  if (caps) return /image[-_]?generation|text[-_]?to[-_]?image/.test(caps);
  return /image|dall[-_]?e|flux|sdxl|stable[-_]?diffusion|midjourney/.test(id) && !/embedding|embed/.test(id);
}

function preferredModelId(models: AigcHubModelMetadata[], capability: 'chat' | 'image' | 'embedding'): string {
  return modelsForCapability(models, capability)[0]?.id ?? '';
}

function modelOptionsWithSelected(models: AigcHubModelMetadata[], selected: string, fallback: string): AigcHubModelMetadata[] {
  const options = [...models];
  const selectedModel = selected || fallback;
  if (selectedModel && !options.some((model) => model.id === selectedModel)) {
    options.unshift({ id: selectedModel, label: selectedModel, capabilities: [] });
  }
  if (options.length === 0) {
    options.push({ id: fallback, label: fallback || '默认模型', capabilities: [] });
  }
  return options;
}

function modelOptionLabel(model: AigcHubModelMetadata): string {
  const capabilityLabel = model.capabilities.length > 0 ? ` · ${model.capabilities.join('/')}` : '';
  return `${model.label || model.id}${capabilityLabel}`;
}
function ModelIdInput({
  id,
  value,
  onChange,
  options,
  fallback,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: AigcHubModelMetadata[];
  fallback: string;
  placeholder: string;
}): JSX.Element {
  return (
    <div className="runtime-model-picker">
      <input
        list={`${id}-options`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <datalist id={`${id}-options`}>
        {modelOptionsWithSelected(options, value, fallback).map((model) => (
          <option key={model.id} value={model.id} label={modelOptionLabel(model)} />
        ))}
      </datalist>
    </div>
  );
}

function formatChatTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}


function readInitialStoredState(): {
  selectedProjectId: string | null;
  selectedTemporaryProjectId: string | null;
  activeWorkspaceScope: WorkspaceScope;
  selectedProjectPath: string | null;
  selectedGlobalPath: string | null;
  selectedTemporaryPath: string | null;
  chatReadingMode: boolean;
  chatModel: string;
  imageModel: string;
  chatScope: ChatScope;
  activeChatSessionId: string | null;
  chatSessionView: ChatSessionView;
  sidebarOpen: boolean;
  editorPanelOpen: boolean;
  chatPanelOpen: boolean;
  themeMode: ThemeMode;
} {
  // Read all localStorage in one shot to avoid ~16 sync getItem calls during mount
  const workspaceSelection = readStoredWorkspaceSelection();
  const temporarySession = readStoredTemporaryChatSession();
  const activeChatSession = readStoredActiveChatSession();
  const selectedProjectId = readStoredSelectedProjectId();
  const chatScope = readStoredChatScope() ?? (selectedProjectId ? 'project' : 'temporary');

  return {
    selectedProjectId,
    selectedTemporaryProjectId: temporarySession?.projectId ?? workspaceSelection?.selectedTemporaryProjectId ?? null,
    activeWorkspaceScope: workspaceSelection?.activeWorkspaceScope ?? 'global',
    selectedProjectPath: workspaceSelection?.selectedProjectPath ?? null,
    selectedGlobalPath: workspaceSelection?.selectedGlobalPath ?? null,
    selectedTemporaryPath: workspaceSelection?.selectedTemporaryPath ?? null,
    chatReadingMode: readStoredChatReadingMode(),
    chatModel: readStoredModel(CHAT_MODEL_STORAGE_KEY),
    imageModel: readStoredModel(IMAGE_MODEL_STORAGE_KEY),
    chatScope: chatScope,
    activeChatSessionId: chatScope === 'project'
      ? (selectedProjectId ? activeChatSession.projectSessionIds[selectedProjectId] ?? null : null)
      : activeChatSession.temporarySessionId ?? temporarySession?.sessionId ?? null,
    chatSessionView: activeChatSession.chatSessionView,
    ...readStoredPanelVisibility(),
    themeMode: readStoredThemeMode(),
  };
}

const ScheduleOverviewBody = memo(function ScheduleOverviewBody({
  tasks,
  sessions,
  projects,
  busyTaskId,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  onOpenSession,
}: {
  tasks: ScheduledTask[];
  sessions: ChatSession[];
  projects: Project[];
  busyTaskId: string | null;
  onRunNow: (task: ScheduledTask) => void;
  onPause: (task: ScheduledTask) => void;
  onResume: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onOpenSession: (task: ScheduledTask) => void;
}): JSX.Element {
  const groups = useMemo(() => groupScheduledTasks(tasks, sessions, projects), [projects, sessions, tasks]);
  if (tasks.length === 0) return <p className="scheduled-task-empty schedule-overview-empty">暂无定时任务</p>;

  return (
    <div className="schedule-overview-body">
      {groups.map((project) => (
        <details key={project.projectId} className="schedule-project-group">
          <summary className="schedule-group-heading">
            <strong>{project.projectName}</strong>
            <span>{project.tasks.length} 个任务</span>
          </summary>
          {project.sessions.map((session) => (
            <details key={session.sessionId} className="schedule-session-group">
              <summary className="schedule-session-heading">
                <span>{session.sessionTitle}</span>
                <small>{session.tasks.length} 个任务</small>
              </summary>
              <button type="button" className="schedule-open-session" onClick={() => onOpenSession(session.tasks[0])}>打开会话</button>
              <div className="schedule-overview-card-grid">
                {session.tasks.map((task) => (
                  <ScheduledTaskCard
                    key={task.id}
                    task={task}
                    busy={busyTaskId === task.id}
                    variant="overview"
                    onRunNow={() => onRunNow(task)}
                    onPause={() => onPause(task)}
                    onResume={() => onResume(task)}
                    onDelete={() => onDelete(task)}
                  />
                ))}
              </div>
            </details>
          ))}
        </details>
      ))}
    </div>
  );
});

const ScheduledTaskBoard = memo(function ScheduledTaskBoard({
  tasks,
  state,
  busyTaskId,
  onRefresh,
  onRunNow,
  onPause,
  onResume,
  onDelete,
}: {
  tasks: ScheduledTask[];
  state: LoadState;
  busyTaskId: string | null;
  onRefresh: () => void;
  onRunNow: (taskId: string) => void;
  onPause: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`scheduled-task-board ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="scheduled-task-board__trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label="展开定时任务看板"
      >
        <span>定时任务</span>
        <span className="scheduled-task-count">{state === 'loading' ? '...' : tasks.length}</span>
      </button>
      {open ? (
        <div className="scheduled-task-board__body">
          <div className="scheduled-task-toolbar">
            <button type="button" className="scheduled-task-icon" onClick={onRefresh} title="刷新" aria-label="刷新定时任务">
              <RefreshCw size={14} />
            </button>
          </div>
          {tasks.length > 0 ? tasks.map((task) => {
            return (
              <ScheduledTaskCard
                key={task.id}
                task={task}
                busy={busyTaskId === task.id}
                onRunNow={onRunNow}
                onPause={onPause}
                onResume={onResume}
                onDelete={onDelete}
              />
            );
          }) : (
            <p className="scheduled-task-empty">当前会话暂无定时任务</p>
          )}
        </div>
      ) : null}
    </div>
  );
});

const ScheduledTaskCard = memo(function ScheduledTaskCard({
  task,
  busy,
  variant = 'compact',
  onRunNow,
  onPause,
  onResume,
  onDelete,
}: {
  task: ScheduledTask;
  busy: boolean;
  variant?: 'compact' | 'message' | 'overview';
  onRunNow: (taskId: string) => void;
  onPause: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}): JSX.Element {
  const paused = task.status === 'paused' || task.status === 'cancelled';
  const prompt = scheduledTaskPrompt(task);
  const showLabels = variant === 'message' || variant === 'overview';
  return (
    <article className={`scheduled-task-card scheduled-task-card--${variant} ${task.status}`}>
      <div className="scheduled-task-card__main">
        <span className="scheduled-task-title" title={task.title}>{task.title}</span>
        <span className="scheduled-task-meta">{scheduledTaskStatusLabel(task.status)} · {formatScheduleNextRun(task)}</span>
        <span className="scheduled-task-message" title={prompt}>{prompt}</span>
      </div>
      <div className="scheduled-task-actions">
        <button
          type="button"
          className="scheduled-task-icon"
          disabled={busy}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRunNow(task.id);
          }}
          title="立即执行"
          aria-label="立即执行定时任务"
        >
          <Send size={13} />
          {showLabels ? <span>{variant === 'overview' ? '执行' : '立即执行'}</span> : null}
        </button>
        <button
          type="button"
          className="scheduled-task-icon"
          disabled={busy || task.status === 'completed'}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            paused ? onResume(task.id) : onPause(task.id);
          }}
          title={paused ? '恢复' : '停止'}
          aria-label={paused ? '恢复定时任务' : '停止定时任务'}
        >
          {paused ? <RefreshCw size={13} /> : <Square size={13} />}
          {showLabels ? <span>{paused ? '恢复' : '停止'}</span> : null}
        </button>
        <button
          type="button"
          className="scheduled-task-icon danger"
          disabled={busy}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDelete(task.id);
          }}
          title="删除"
          aria-label="删除定时任务"
        >
          <Trash2 size={13} />
          {showLabels ? <span>删除</span> : null}
        </button>
      </div>
      {busy ? <div className="scheduled-task-busy">处理中...</div> : null}
    </article>
  );
});

function projectName(projects: Project[], projectId: string): string {
  return projects.find((project) => project.id === projectId)?.name ?? (isTemporaryProjectId(projectId) ? '临时工作区' : projectId);
}

function groupScheduledTasks(tasks: ScheduledTask[], sessions: ChatSession[], projects: Project[]): Array<{
  projectId: string;
  projectName: string;
  tasks: ScheduledTask[];
  sessions: Array<{ sessionId: string; sessionTitle: string; tasks: ScheduledTask[] }>;
}> {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const projectGroups = new Map<string, { projectId: string; projectName: string; tasks: ScheduledTask[]; sessions: Map<string, { sessionId: string; sessionTitle: string; tasks: ScheduledTask[] }> }>();
  for (const task of tasks) {
    const session = sessionsById.get(task.sessionId);
    const projectId = session?.projectId ?? task.projectId;
    const projectGroup = projectGroups.get(projectId) ?? {
      projectId,
      projectName: projectName(projects, projectId),
      tasks: [] as ScheduledTask[],
      sessions: new Map(),
    };
    projectGroup.tasks.push(task);
    const sessionGroup = projectGroup.sessions.get(task.sessionId) ?? {
      sessionId: task.sessionId,
      sessionTitle: session?.title ?? task.sessionId,
      tasks: [] as ScheduledTask[],
    };
    sessionGroup.tasks.push(task);
    projectGroup.sessions.set(task.sessionId, sessionGroup);
    projectGroups.set(projectId, projectGroup);
  }
  return [...projectGroups.values()].map((group) => ({
    projectId: group.projectId,
    projectName: group.projectName,
    tasks: group.tasks.sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt)),
    sessions: [...group.sessions.values()].map((session) => ({
      ...session,
      tasks: session.tasks.sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt)),
    })),
  }));
}

function scheduledTaskStatusLabel(status: ScheduledTask['status']): string {
  switch (status) {
    case 'active': return '运行中';
    case 'paused': return '已停止';
    case 'completed': return '已完成';
    case 'cancelled': return '已取消';
    case 'error': return '异常';
    default: return status satisfies never;
  }
}

function scheduledTaskPrompt(task: ScheduledTask): string {
  return task.action.prompt ?? task.action.message ?? '执行时实时生成微信消息';
}

function scheduledTasksFromMessage(message: ChatMessage, sessionTasks: ScheduledTask[]): ScheduledTask[] {
  if (message.role !== 'assistant' || message.streamEvents.length === 0) return [];
  const byId = new Map(sessionTasks.map((task) => [task.id, task]));
  const tasks: ScheduledTask[] = [];
  for (const event of message.streamEvents) {
    if (event.type !== 'tool_use.end') continue;
    const task = scheduledTaskFromToolEvent(event);
    if (!task) continue;
    const latest = byId.get(task.id) ?? task;
    if (!tasks.some((item) => item.id === latest.id)) tasks.push(latest);
  }
  return tasks;
}

function streamEventKey(event: StreamEvent): string {
  const sequence = 'sequence' in event ? event.sequence ?? '' : '';
  const toolCallId = 'toolCallId' in event ? event.toolCallId ?? '' : '';
  const emittedAt = 'emittedAt' in event ? event.emittedAt ?? '' : '';
  return `${event.type}:${event.runId}:${sequence}:${toolCallId}:${emittedAt}:${JSON.stringify(event)}`;
}

function scheduledTaskFromToolEvent(event: Extract<StreamEvent, { type: 'tool_use.end' }>): ScheduledTask | null {
  if (event.status !== 'succeeded' || !event.outputText) return null;
  const parsed = parseJsonObject(event.outputText);
  const task = parsed?.task;
  return isScheduledTask(task) ? task : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<ScheduledTask>;
  return typeof task.id === 'string'
    && typeof task.projectId === 'string'
    && typeof task.sessionId === 'string'
    && typeof task.title === 'string'
    && typeof task.nextRunAt === 'string'
    && task.action?.type === 'wechat_message';
}

function upsertScheduledTask(tasks: ScheduledTask[], task: ScheduledTask): ScheduledTask[] {
  const next = tasks.some((item) => item.id === task.id)
    ? tasks.map((item) => item.id === task.id ? task : item)
    : [task, ...tasks];
  return next.sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
}

function formatScheduleNextRun(task: ScheduledTask): string {
  if (task.status === 'completed') return task.lastRunAt ? `完成于 ${formatChatTime(task.lastRunAt)}` : '已完成';
  return `下次 ${formatChatTime(task.nextRunAt)}`;
}

function toolPanelEyebrow(panel: 'connectors' | 'git' | 'harness' | 'settings' | null): string {
  if (panel === 'connectors') return 'Connectors';
  if (panel === 'git') return 'Version Control';
  if (panel === 'settings') return 'Runtime';
  return '';
}

function toolPanelTitle(panel: 'connectors' | 'git' | 'harness' | 'settings' | null): string {
  if (panel === 'connectors') return '连接器';
  if (panel === 'git') return '版本管理与安全备份';
  if (panel === 'settings') return '运行设置';
  return '';
}

function DesktopVersionLine(): JSX.Element | null {
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.viforgeDesktop?.getAppVersion().then((value: string) => {
      if (!cancelled) setAppVersion(value);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!appVersion) return null;
  return <p className="runtime-settings-status">桌面安装包版本 {appVersion}</p>;
}

function RuntimeSettingsPanel({
  config,
  releaseInfo,
  state,
  chatModelOptions,
  imageModelOptions,
  embeddingModelOptions,
  onReload,
  onSave,
  onConfirmEmbeddingChange,
}: {
  config: RuntimeConfig | null;
  releaseInfo: ReleaseInfo | null;
  state: LoadState;
  chatModelOptions: AigcHubModelMetadata[];
  imageModelOptions: AigcHubModelMetadata[];
  embeddingModelOptions: AigcHubModelMetadata[];
  onReload: () => void;
  onSave: (input: UpdateRuntimeConfigInput) => void;
  onConfirmEmbeddingChange: () => Promise<boolean>;
}): JSX.Element {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [chatUseGlobal, setChatUseGlobal] = useState(true);
  const [chatBaseUrl, setChatBaseUrl] = useState('');
  const [chatApiKey, setChatApiKey] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [imageUseGlobal, setImageUseGlobal] = useState(true);
  const [imageBaseUrl, setImageBaseUrl] = useState('');
  const [imageApiKey, setImageApiKey] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [embeddingUseGlobal, setEmbeddingUseGlobal] = useState(true);
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('');
  const [embeddingApiKey, setEmbeddingApiKey] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingDims, setEmbeddingDims] = useState('3072');
  const [embeddingAdvancedOpen, setEmbeddingAdvancedOpen] = useState(false);
  const [localDataRoot, setLocalDataRoot] = useState('');
  const [dataRootRestartRequired, setDataRootRestartRequired] = useState(false);
  const [modelTestState, setModelTestState] = useState<Record<'chat' | 'image' | 'embedding', LoadState>>({ chat: 'idle', image: 'idle', embedding: 'idle' });
  const [modelTestMessage, setModelTestMessage] = useState<Record<'chat' | 'image' | 'embedding', string>>({ chat: '', image: '', embedding: '' });
  const [memoryRebuildState, setMemoryRebuildState] = useState<LoadState>('idle');
  const [memoryRebuildMessage, setMemoryRebuildMessage] = useState('');

  useEffect(() => {
    if (!config) return;
    setBaseUrl(config.modelProvider.baseUrl ?? '');
    setChatUseGlobal(config.modelProvider.chatUsesGlobalConfig ?? true);
    setChatBaseUrl(config.modelProvider.chatBaseUrl ?? config.modelProvider.baseUrl ?? '');
    setChatModel(config.modelProvider.chatModel ?? '');
    setImageUseGlobal(config.modelProvider.imageUsesGlobalConfig ?? true);
    setImageBaseUrl(config.modelProvider.imageBaseUrl ?? config.modelProvider.baseUrl ?? '');
    setImageModel(config.modelProvider.imageModel ?? '');
    setEmbeddingUseGlobal(config.modelProvider.embeddingUsesGlobalConfig ?? true);
    setEmbeddingBaseUrl(config.modelProvider.embeddingBaseUrl ?? config.modelProvider.baseUrl ?? '');
    setEmbeddingModel(config.modelProvider.embeddingModel ?? '');
    setEmbeddingDims(String(config.modelProvider.embeddingDims ?? 3072));
    setEmbeddingAdvancedOpen(Boolean(config.modelProvider.embeddingModel || config.modelProvider.embeddingBaseUrl || config.modelProvider.embeddingApiKeyConfigured || config.memory.reindexRequired));
    setApiKey('');
    setChatApiKey('');
    setImageApiKey('');
    setEmbeddingApiKey('');
    setLocalDataRoot(config.desktop.dataRoot ?? '');
    setDataRootRestartRequired(false);
    setModelTestState({ chat: 'idle', image: 'idle', embedding: 'idle' });
    setModelTestMessage({ chat: '', image: '', embedding: '' });
    setMemoryRebuildState('idle');
    setMemoryRebuildMessage('');
  }, [config]);

  const busy = state === 'loading';
  const canSelectDesktopDataRoot = Boolean(config?.desktop.enabled && window.viforgeDesktop?.selectDataRoot);
  const modelInput = (): NonNullable<UpdateRuntimeConfigInput['modelProvider']> => ({
    baseUrl,
    ...(apiKey.trim() ? { apiKey } : {}),
    chatBaseUrl: chatUseGlobal ? '' : chatBaseUrl,
    ...(chatUseGlobal || chatApiKey.trim() ? { chatApiKey: chatUseGlobal ? '' : chatApiKey } : {}),
    chatModel,
    imageBaseUrl: imageUseGlobal ? '' : imageBaseUrl,
    ...(imageUseGlobal || imageApiKey.trim() ? { imageApiKey: imageUseGlobal ? '' : imageApiKey } : {}),
    imageModel,
    embeddingBaseUrl: embeddingUseGlobal ? '' : embeddingBaseUrl,
    ...(embeddingUseGlobal || embeddingApiKey.trim() ? { embeddingApiKey: embeddingUseGlobal ? '' : embeddingApiKey } : {}),
    embeddingModel,
    embeddingDims: Number(embeddingDims) || 3072,
  });



  const currentEmbeddingInput = () => ({
    baseUrl: embeddingUseGlobal ? '' : embeddingBaseUrl.trim(),
    model: embeddingModel.trim(),
    dims: Number(embeddingDims) || 3072,
  });

  const savedEmbeddingInput = () => ({
    baseUrl: config?.modelProvider.embeddingUsesGlobalConfig === false ? (config.modelProvider.embeddingBaseUrl ?? '').trim() : '',
    model: (config?.modelProvider.embeddingModel ?? '').trim(),
    dims: config?.modelProvider.embeddingDims ?? 3072,
  });

  const hasExistingEmbeddingIndex = () => Boolean(
    config?.memory.indexedEmbeddingProfile
      || config?.memory.lastReindexedAt
      || config?.memory.reindexRequired,
  );

  const embeddingConfigChanged = () => {
    const current = currentEmbeddingInput();
    const saved = savedEmbeddingInput();
    return current.baseUrl !== saved.baseUrl || current.model !== saved.model || current.dims !== saved.dims;
  };

  async function saveSettings() {
    if (hasExistingEmbeddingIndex() && embeddingConfigChanged()) {
      const confirmed = await onConfirmEmbeddingChange();
      if (!confirmed) return;
    }
    onSave({ modelProvider: modelInput() });
  }

  async function rebuildMemoryIndex() {
    setMemoryRebuildState('loading');
    setMemoryRebuildMessage('');
    try {
      const result = await apiClient.rebuildMemoryIndex();
      setMemoryRebuildState(result.ok ? 'idle' : 'error');
      setMemoryRebuildMessage(result.message);
      onReload();
    } catch (error) {
      setMemoryRebuildState('error');
      setMemoryRebuildMessage(error instanceof Error ? error.message : String(error));
    }
  }
  async function testRuntimeModel(target: 'chat' | 'image' | 'embedding') {
    setModelTestState((current) => ({ ...current, [target]: 'loading' }));
    setModelTestMessage((current) => ({ ...current, [target]: '' }));
    try {
      const result = await apiClient.testRuntimeModel({ ...modelInput(), testTarget: target });
      setModelTestState((current) => ({ ...current, [target]: result.ok ? 'idle' : 'error' }));
      setModelTestMessage((current) => ({ ...current, [target]: result.message }));
    } catch (error) {
      setModelTestState((current) => ({ ...current, [target]: 'error' }));
      setModelTestMessage((current) => ({ ...current, [target]: error instanceof Error ? error.message : String(error) }));
    }
  }

  return (
    <div className="runtime-settings-panel">
      <div className="runtime-settings-toolbar">
        <div>
          <strong>{config?.desktop.enabled ? '桌面单机模式' : '服务模式'}</strong>
          <span>{localDataRoot || '使用当前运行目录'}</span>
        </div>
        <button type="button" onClick={onReload} disabled={busy}>刷新</button>
      </div>

      {releaseInfo ? (
        <section className="runtime-settings-section">
          <h3>版本信息</h3>
          <p className="runtime-settings-status">{releaseInfo.productName} {releaseInfo.version} · {releaseInfo.channel} · {releaseInfo.tag}</p>
          <p className="runtime-settings-status">{releaseInfo.updateHeadline}</p>
          <p className="runtime-settings-status">发布日期 {releaseInfo.releaseDate}{releaseInfo.currentArtifact ? ` · 当前制品 ${releaseInfo.currentArtifact.fileName}` : ''}</p>
          <div className="runtime-release-notes">
            {releaseInfo.updateNotes.map((note) => <p key={note} className="runtime-settings-status">- {note}</p>)}
          </div>
          {config?.desktop.enabled && window.viforgeDesktop?.getAppVersion ? <DesktopVersionLine /> : null}
        </section>
      ) : null}

      {config?.desktop.enabled ? (
        <section className="runtime-settings-section">
          <h3>本地数据路径</h3>
          <div className="runtime-settings-grid">
            <label className="runtime-settings-wide"><span>数据路径</span><input value={localDataRoot} readOnly placeholder="首次启动时必须选择" /></label>
          </div>
          <div className="runtime-settings-actions runtime-settings-actions-inline">
            <button
              type="button"
              disabled={busy || !canSelectDesktopDataRoot}
              onClick={async () => {
                const result = await window.viforgeDesktop?.selectDataRoot();
                if (!result || result.canceled || !result.dataRoot) return;
                setLocalDataRoot(result.dataRoot);
                setDataRootRestartRequired(Boolean(result.restartRequired));
              }}
            >选择数据路径</button>
          </div>
          <p className="runtime-settings-status">
            {dataRootRestartRequired ? '数据路径已更新，重启 ViForge 后生效。' : '项目、配置、日志和内置 PostgreSQL 数据都会保存在此路径下。'}
          </p>
        </section>
      ) : null}

      <section className="runtime-settings-section">
        <h3>OpenAI 协议模型</h3>
        <p className="runtime-settings-status">ViForge 不内置模型服务。Base URL、API Key 和模型 ID 只保存在本机运行配置中；API Key 不会回显到前端。</p>
        <div className="runtime-settings-grid runtime-settings-grid-global">
          <label><span>全局 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" /></label>
          <label><span>全局 API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config?.modelProvider.apiKeyConfigured ? '已配置，留空则不修改' : 'sk-...'} /></label>
        </div>

        <div className="runtime-model-configs">
          <section className="runtime-model-config">
            <div className="runtime-model-config__header">
              <h4>文本模型</h4>
              <label className="runtime-model-config__mode"><input type="checkbox" checked={chatUseGlobal} onChange={(event) => setChatUseGlobal(event.target.checked)} /><span>使用全局配置</span></label>
            </div>
            <div className="runtime-settings-grid runtime-settings-grid-model">
              <label><span>Base URL</span><input value={chatBaseUrl} onChange={(event) => setChatBaseUrl(event.target.value)} placeholder={baseUrl || 'https://api.openai.com/v1'} disabled={chatUseGlobal} /></label>
              <label><span>API Key</span><input type="password" value={chatApiKey} onChange={(event) => setChatApiKey(event.target.value)} placeholder={chatUseGlobal ? '使用全局 API Key' : config?.modelProvider.chatApiKeyConfigured ? '已配置，留空则不修改' : 'sk-...'} disabled={chatUseGlobal} /></label>
              <label className="runtime-settings-wide"><span>模型 ID</span><ModelIdInput id="runtime-chat-model" value={chatModel} onChange={setChatModel} options={chatModelOptions} fallback="gpt-5.5" placeholder="选择或输入文本模型 ID" /></label>
            </div>
            <div className="runtime-settings-actions runtime-settings-actions-inline"><button type="button" disabled={busy || modelTestState.chat === 'loading'} onClick={() => void testRuntimeModel('chat')}>测试</button></div>
            {modelTestMessage.chat ? <p className={modelTestState.chat === 'error' ? 'runtime-settings-status runtime-settings-status-error' : 'runtime-settings-status'}>{modelTestMessage.chat}</p> : null}
          </section>

          <section className="runtime-model-config">
            <div className="runtime-model-config__header">
              <h4>图片模型</h4>
              <label className="runtime-model-config__mode"><input type="checkbox" checked={imageUseGlobal} onChange={(event) => setImageUseGlobal(event.target.checked)} /><span>使用全局配置</span></label>
            </div>
            <div className="runtime-settings-grid runtime-settings-grid-model">
              <label><span>Base URL</span><input value={imageBaseUrl} onChange={(event) => setImageBaseUrl(event.target.value)} placeholder={baseUrl || 'https://api.openai.com/v1'} disabled={imageUseGlobal} /></label>
              <label><span>API Key</span><input type="password" value={imageApiKey} onChange={(event) => setImageApiKey(event.target.value)} placeholder={imageUseGlobal ? '使用全局 API Key' : config?.modelProvider.imageApiKeyConfigured ? '已配置，留空则不修改' : 'sk-...'} disabled={imageUseGlobal} /></label>
              <label className="runtime-settings-wide"><span>模型 ID</span><ModelIdInput id="runtime-image-model" value={imageModel} onChange={setImageModel} options={imageModelOptions} fallback="gpt-image-2" placeholder="选择或输入图片模型 ID" /></label>
            </div>
            <div className="runtime-settings-actions runtime-settings-actions-inline"><button type="button" disabled={busy || modelTestState.image === 'loading'} onClick={() => void testRuntimeModel('image')}>测试</button></div>
            {modelTestMessage.image ? <p className={modelTestState.image === 'error' ? 'runtime-settings-status runtime-settings-status-error' : 'runtime-settings-status'}>{modelTestMessage.image}</p> : null}
          </section>

        </div>
        <section className="runtime-advanced-config">
          <button type="button" className="runtime-advanced-config__toggle" onClick={() => setEmbeddingAdvancedOpen((open) => !open)} aria-expanded={embeddingAdvancedOpen}>
            <span>Embedding 高级配置</span>
            <span>{embeddingAdvancedOpen ? '收起' : '展开'}</span>
          </button>
          {embeddingAdvancedOpen ? (
            <div className="runtime-advanced-config__body">
              <div className="runtime-model-config__header">
                <h4>Embedding 模型</h4>
                <label className="runtime-model-config__mode"><input type="checkbox" checked={embeddingUseGlobal} onChange={(event) => setEmbeddingUseGlobal(event.target.checked)} /><span>使用全局配置</span></label>
              </div>
              <div className="runtime-settings-grid runtime-settings-grid-advanced">
                <label><span>Base URL</span><input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} placeholder={baseUrl || 'https://api.openai.com/v1'} disabled={embeddingUseGlobal} /></label>
                <label><span>API Key</span><input type="password" value={embeddingApiKey} onChange={(event) => setEmbeddingApiKey(event.target.value)} placeholder={embeddingUseGlobal ? '使用全局 API Key' : config?.modelProvider.embeddingApiKeyConfigured ? '已配置，留空则不修改' : 'sk-...'} disabled={embeddingUseGlobal} /></label>
                <label><span>模型 ID</span><ModelIdInput id="runtime-embedding-model" value={embeddingModel} onChange={setEmbeddingModel} options={embeddingModelOptions} fallback="text-embedding-3-large" placeholder="选择或输入 Embedding 模型 ID" /></label>
                <label><span>向量维度</span><input inputMode="numeric" value={embeddingDims} onChange={(event) => setEmbeddingDims(event.target.value)} /></label>
              </div>
              <div className="runtime-settings-actions runtime-settings-actions-inline"><button type="button" disabled={busy || modelTestState.embedding === 'loading'} onClick={() => void testRuntimeModel('embedding')}>测试</button></div>
              {modelTestMessage.embedding ? <p className={modelTestState.embedding === 'error' ? 'runtime-settings-status runtime-settings-status-error' : 'runtime-settings-status'}>{modelTestMessage.embedding}</p> : null}
            </div>
          ) : null}
        </section>
        <div className={config?.memory.reindexRequired ? 'runtime-memory-alert runtime-memory-alert-warning' : 'runtime-memory-alert'}>
          <div>
            <strong>长期记忆索引</strong>
            <span>{config?.memory.statusMessage ?? '长期记忆索引状态未知。'}</span>
          </div>
          <button type="button" disabled={busy || memoryRebuildState === 'loading'} onClick={() => void rebuildMemoryIndex()}>重建</button>
        </div>
        {memoryRebuildMessage ? <p className={memoryRebuildState === 'error' ? 'runtime-settings-status runtime-settings-status-error' : 'runtime-settings-status'}>{memoryRebuildMessage}</p> : null}
      </section>

      <section className="runtime-settings-section">
        <h3>本地数据存储</h3>
        <p className="runtime-settings-status">工作区、聊天会话、Agent 记忆、Harness 产物和日志默认保存在本机数据目录。</p>
      </section>

      <div className="runtime-settings-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void saveSettings();
          }}
        >保存设置</button>
      </div>
    </div>
  );
}

function Root(): JSX.Element {
  return isHarnessStandaloneRoute() ? <HarnessStandalonePage /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
