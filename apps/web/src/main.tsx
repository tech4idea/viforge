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
  type BehaviorRule,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatSession,
  type GeminiImageAspectRatio,
  type GeminiImageThinkingLevel,
  type ImageGenerationReferenceImage,
  type Project,
  type ReferencedChatSnippet,
  type ReferencedFile,
  type RunEvent,
  type StreamEvent,
  type TheaterSkill,
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
  filterVisibleWorkspaceEntries,
  toggleCollapsedPath,
} from './workspace-tree';
import { ACTIVE_PRODUCT_PROFILE } from './product-profile';
import { ActivityRail, type ThemeMode as RailThemeMode } from './components/ActivityRail';
import { ConfirmDialog } from './components/ConfirmDialog';
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
  Save,
  Send,
  Square,
  Trash2,
  Type,
  Upload,
  X,
} from './components/icons';
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
const CHAT_PANEL_MAX_WIDTH = 560;
const CHAT_READING_MODE_STORAGE_KEY = 'viwork.chatReadingMode.v1';
const SELECTED_PROJECT_STORAGE_KEY = 'viwork.selectedProjectId.v1';
const TEMPORARY_CHAT_SESSION_STORAGE_KEY = 'viwork.temporaryChatSession.v1';
const CHAT_SCOPE_STORAGE_KEY = 'viwork.chatScope.v1';
const WORKSPACE_SELECTION_STORAGE_KEY = 'viwork.workspaceSelection.v1';
const ACTIVE_CHAT_SESSION_STORAGE_KEY = 'viwork.activeChatSession.v1';
const THEME_MODE_STORAGE_KEY = 'viwork.themeMode.v1';
const TEMPORARY_CHAT_SCOPE_ID = '__temporary__';
const CHAT_MODEL_STORAGE_KEY = 'viwork.chatModel.v1';
const IMAGE_MODEL_STORAGE_KEY = 'viwork.imageModel.v1';
const RUN_NOTIFY_STORAGE_KEY = 'viwork.runNotify.v1';

type RunNotifyMode = 'off' | 'sound' | 'wechat' | 'both';

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
type RunState = 'idle' | 'running' | 'success' | 'error';
type ChatMode = 'assistant' | 'image';
type ChatScope = 'project' | 'temporary';
type WorkspaceScope = 'global' | 'project' | 'temporary';
type ChatSessionView = 'active' | 'archived';
type ThemeMode = 'light' | 'dark' | 'soft';
type WorkspaceTarget = { workspaceScope: WorkspaceScope; projectId: string | null; parentPath: string };
type ChatSessionsUpdate = ChatSession[] | ((currentSessions: ChatSession[]) => ChatSession[]);
type PendingChatMessageUpdate = { sessionId: string; messageId: string; message: ChatMessage };
type ChatMessageTextSelectionHandler = (event: React.MouseEvent, message: ChatMessage) => void;

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
  const activeRunIdRef = useRef<string | null>(null);
  const initState = useMemo(() => readInitialStoredState(), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initState.selectedProjectId);
  const [temporaryProjectId, setTemporaryProjectId] = useState<string | null>(initState.selectedTemporaryProjectId);
  const [projectLoadState, setProjectLoadState] = useState<LoadState>('idle');
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);

  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
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
  const [chatScope, setChatScope] = useState<ChatScope>(initState.chatScope);
  const [chatSessionsProjectId, setChatSessionsProjectId] = useState<string | null>(null);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(initState.activeChatSessionId);
  const [chatSessionView, setChatSessionView] = useState<ChatSessionView>(initState.chatSessionView);
  const [collapsedPanels, setCollapsedPanels] = useState({ workspace: false, editor: false, chat: false });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(true);
  const [editorPanelOpen, setEditorPanelOpen] = useState(true);
  const [panelWidths, setPanelWidths] = useState({ workspace: 238, chat: 340 });
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
  const [activeToolPanel, setActiveToolPanel] = useState<'skills' | 'wechat' | 'settings' | null>(null);
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
  const [skills, setSkills] = useState<TheaterSkill[]>([]);
  const [skillsState, setSkillsState] = useState<LoadState>('idle');
  const [newSkill, setNewSkill] = useState({
    title: '原著分析助手',
    description: '根据原著片段提炼主题、人物关系和可改编场面。',
    prompt: '请分析这段原著，提炼主题、人物关系、关键场面和改编风险。',
  });
  const [wechatStatus, setWechatStatus] = useState<WechatStatus | null>(null);
  const [wechatSetup, setWechatSetup] = useState<WechatSetupSession | null>(null);
  const [wechatState, setWechatState] = useState<LoadState>('idle');
  const [behaviorRules, setBehaviorRules] = useState<BehaviorRule[]>([]);
  const [behaviorRulesState, setBehaviorRulesState] = useState<LoadState>('idle');

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
      : entries;
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
  const visibleEntries = useMemo(
    () => filterVisibleWorkspaceEntries(entries, collapsedDirectoriesByProject[selectedProjectId ?? ''] ?? []),
    [collapsedDirectoriesByProject, entries, selectedProjectId],
  );
  const visibleGlobalEntries = useMemo(
    () => filterVisibleWorkspaceEntries(globalEntries, collapsedGlobalPaths),
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
    () => activeWorkspaceScope === 'project' ? entries.filter((entry) => entry.type === 'file') : [],
    [activeWorkspaceScope, entries],
  );
  const activeChatScopeName = chatScope === 'project' && selectedProject ? selectedProject.name : '临时工作目录';
  const chatModelOptions = useMemo(() => modelsForCapability(aigcHubModels, 'chat'), [aigcHubModels]);
  const imageModelOptions = useMemo(() => modelsForCapability(aigcHubModels, 'image'), [aigcHubModels]);
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
  }, []);
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
        const target = event.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
        if (isInput) return;
        event.preventDefault();
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
      setActiveWorkspaceScope(selectedTemporaryProjectId ? 'temporary' : 'global');
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
    if (activeToolPanel === 'skills') {
      void loadSkills();
    }
    if (activeToolPanel === 'wechat') {
      void loadWechatStatus();
    }
    if (activeToolPanel === 'settings') {
      void loadBehaviorRules();
    }
  }, [activeToolPanel]);

  useEffect(() => {
    if (!selectedProjectId) {
      setEntries([]);
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
    setReferencedFiles([]);
    setReferencedSnippets([]);
    setPrompt('');
    closeReferenceMenu();
  }, [activeChatSessionId]);

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

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);
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
      const stored = readStoredActiveChatSession();
      const preferredSession = pickPreferredChatSession(sessions, stored.projectSessionIds[projectId] ?? null, chatSessionView);
      if (preferredSession) {
        setChatSessionView(preferredSession.archivedAt ? 'archived' : 'active');
      }
      setActiveChatSessionId((currentId) => {
        const currentSession = currentId ? sessions.find((session) => session.id === currentId) : null;
        if (currentSession && sessionMatchesView(currentSession, chatSessionView)) {
          return currentSession.id;
        }
        return preferredSession?.id ?? null;
      });
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
      const preferredSession = pickPreferredChatSession(modeSessions, chatMode === 'assistant' ? storedSessionId : null, chatSessionView);

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
    const name = await showPrompt({ title: `新建${WORKSPACE_SECTIONS[1].title.replace(/区域$/, '')}`, placeholder: DEFAULT_PROJECT_NAME, initialValue: DEFAULT_PROJECT_NAME, confirmLabel: '创建' });
    if (!name?.trim()) return;
    const description = await showPrompt({ title: '项目描述', message: '一句话描述题材', placeholder: DEFAULT_PROJECT_DESCRIPTION, initialValue: DEFAULT_PROJECT_DESCRIPTION, confirmLabel: '确认' }) ?? '';
    setIsCreatingProject(true);
    setCreateProjectError(null);
    try {
      const project = await apiClient.createProject({ name: name.trim(), description: description.trim() });
      setProjects((currentProjects) => [project, ...currentProjects.filter((item) => item.id !== project.id)]);
      setSelectedProjectId(project.id);
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

  async function loadSkills() {
    setSkillsState('loading');
    try {
      setSkills(await apiClient.listSkills());
      setSkillsState('idle');
    } catch {
      setSkillsState('error');
    }
  }

  async function toggleSkill(skill: TheaterSkill) {
    if (skill.mutable === false) {
      return;
    }
    const updated = await apiClient.updateSkill(skill.slug, { enabled: !skill.enabled });
    setSkills((current) => current.map((item) => item.slug === updated.slug ? updated : item));
  }

  async function createSkill() {
    const created = await apiClient.createSkill(newSkill);
    setSkills((current) => [...current, created]);
  }

  async function loadWechatStatus() {
    setWechatState('loading');
    try {
      const status = await apiClient.getWechatStatus();
      setWechatStatus(status);
      setWechatSetup(status.setupSession);
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

  async function completeWechatSetup() {
    if (!wechatSetup) return;
    const status = await apiClient.completeWechatSetupSession(wechatSetup.sessionId, {
      displayName: '编剧微信',
      externalUserId: 'local-writer',
    });
    setWechatStatus(status);
    setWechatSetup(status.setupSession);
  }

  async function loadBehaviorRules() {
    setBehaviorRulesState('loading');
    try {
      setBehaviorRules(await apiClient.getBehaviorRules());
      setBehaviorRulesState('idle');
    } catch {
      setBehaviorRulesState('error');
    }
  }

  async function saveBehaviorRules() {
    setBehaviorRulesState('loading');
    try {
      setBehaviorRules(await apiClient.saveBehaviorRules(behaviorRules));
      setBehaviorRulesState('idle');
    } catch {
      setBehaviorRulesState('error');
    }
  }

  function addBehaviorRule() {
    setBehaviorRules((current) => [
      ...current,
      { id: `custom-${Date.now()}`, label: '自定义规则', content: '', enabled: true, builtIn: false },
    ]);
  }

  function removeBehaviorRule(id: string) {
    setBehaviorRules((current) => current.filter((r) => r.id !== id));
  }

  function updateBehaviorRule(id: string, patch: Partial<BehaviorRule>) {
    setBehaviorRules((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
    setRunState('running');
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
        const assistantMessage = createChatMessage('assistant', '', {
          referencedFiles: response.run.referencedFiles,
          referencedSnippets: response.run.referencedSnippets ?? [],
          status: 'running',
        });
        appendMessageToSession(session.id, assistantMessage);
        activeRunIdRef.current = response.run.id;
        activeStreamCloseRef.current = apiClient.streamRunEvents(response.run.id, {
          onEvent: (event) => handleRunStreamEvent(session.id, assistantMessage.id, runProjectId, event),
          onError: (error) => {
            activeStreamCloseRef.current = null;
            activeRunIdRef.current = null;
            const message = userFacingRunError(error);
            setRunState('error');
            setRunError(message);
            updateMessageInSession(session.id, assistantMessage.id, (message) => ({
              ...message,
              status: 'error',
              content: message.content || `运行失败：${userFacingRunError(error)}`,
            }));
          },
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

  async function stopRun() {
    const runId = activeRunIdRef.current;
    const closeStream = activeStreamCloseRef.current;
    activeRunIdRef.current = null;
    activeStreamCloseRef.current = null;
    closeStream?.();
    if (runId) {
      try {
        await apiClient.cancelRun(runId);
      } catch {
        // cancel request may fail if run already ended; safe to ignore
      }
    }
    setRunState('idle');
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
        : await apiClient.createTemporaryChatSession();

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
      activeStreamCloseRef.current = null;
      activeRunIdRef.current = null;
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBatch();
      const streamEndStatus = event.status === 'cancelled' ? 'idle' as const : event.status === 'success' ? 'success' as const : 'error' as const;
      setRunState(streamEndStatus);
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
              } else if (event.type === 'image.generated') {
                if (!attachments.some((attachment) => attachment.id === event.attachment.id || attachment.path === event.attachment.path)) {
                  attachments.push(event.attachment);
                }
              } else if (event.type === 'run.end' && event.status === 'error' && !content) {
                content = `运行失败：${userFacingRunError(event.errorMessage)}`;
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
    event.dataTransfer.setData('application/x-viwork-entry', JSON.stringify(dragged));
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
          chat: clamp(startWidths.chat - deltaX, CHAT_PANEL_MIN_WIDTH, CHAT_PANEL_MAX_WIDTH),
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
      return `${sidebarCol}1fr 6px ${panelWidths.chat}px`;
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
        const created = await apiClient.createTemporaryChatSession();
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
        onOpenSettings={() => setActiveToolPanel('settings')}
        onOpenWechat={() => setActiveToolPanel('wechat')}
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
                    className={`workspace-section-root${dropTargetClass('global', null, '')}`}
                    title={WORKSPACE_SECTIONS[0].description}
                    onClick={() => {
                      setActiveWorkspaceScope('global');
                    }}
                    onDragOver={(event) => handleDropTargetDragOver(event, { workspaceScope: 'global', projectId: null, parentPath: '' })}
                    onDragLeave={() => setDragOverTargetKey(null)}
                    onDrop={(event) => void handleDropOnDirectory(event, { workspaceScope: 'global', projectId: null, parentPath: '' })}
                    onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'global', projectId: null })}
                  >
                    <span className="node-icon"><Diamond size={14} /></span>
                    <span className="node-main">
                      <strong>{WORKSPACE_SECTIONS[0].title}</strong>
                      <small>{WORKSPACE_SECTIONS[0].description}</small>
                    </span>
                  </button>
                  <div className="file-tree nested-tree global-tree">
                    {globalEntriesState === 'error' ? <p className="inline-error">{globalEntriesError}</p> : null}
                    {globalEntriesState === 'loading' ? <p className="muted">正在加载全局文件...</p> : null}
                    {renderCreateEntryDraft('global', null, '', 0)}
                    {visibleGlobalEntries.map((entry) => (
                      <Fragment key={entry.path}>
                        {renderRenameEntryDraft(entry, 'global', null) ?? (
                          <button
                            type="button"
                            className={`file-node global-file-node ${entry.type === 'directory' ? `directory-node${dropTargetClass('global', null, entry.path)}` : 'document-node'}`}
                            draggable
                            style={{ '--tree-depth': String(pathDepth(entry.path)) } as React.CSSProperties}
                            onDragStart={(event) => handleEntryDragStart(event, 'global', null, entry)}
                            onDragEnd={() => {
                              setDragEntry(null);
                              setDragOverTargetKey(null);
                            }}
                            onDragOver={entry.type === 'directory' ? (event) => handleDropTargetDragOver(event, { workspaceScope: 'global', projectId: null, parentPath: entry.path }) : undefined}
                            onDragLeave={entry.type === 'directory' ? () => setDragOverTargetKey(null) : undefined}
                            onDrop={entry.type === 'directory' ? (event) => void handleDropOnDirectory(event, { workspaceScope: 'global', projectId: null, parentPath: entry.path }) : undefined}
                            onClick={() => {
                              setActiveWorkspaceScope('global');
                              setSelectedGlobalPath(entry.path);
                              if (entry.type === 'file') {
                                setEditorPanelOpen(true);
                              }
                              if (entry.type === 'directory') {
                                toggleGlobalDirectory(entry.path);
                              }
                            }}
                            onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'global', entry })}
                            title={entry.path}
                          >
                            <span className="file-node-label">
                              {entry.type === 'directory' ? (
                                <span className="file-node-chevron">
                                  {collapsedGlobalPaths.includes(entry.path) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                </span>
                              ) : null}
                              <span className="file-node-icon">
                                {entry.type === 'directory'
                                  ? collapsedGlobalPaths.includes(entry.path) ? <Folder size={13} /> : <FolderOpen size={13} />
                                  : fileIconForPath(entry.path)}
                              </span>
                              <span>{entry.name}</span>
                            </span>
                          </button>
                        )}
                        {entry.type === 'directory' ? renderCreateEntryDraft('global', null, entry.path, pathDepth(entry.path) + 1) : null}
                      </Fragment>
                    ))}
                  </div>
                </div>

                <div className="workspace-section">
                  <button
                    type="button"
                    className="workspace-section-root"
                    title={WORKSPACE_SECTIONS[1].description}
                    onContextMenu={(event) => openSidebarContextMenu(event, { projectId: null })}
                  >
                    <span className="node-icon"><FolderOpen size={14} /></span>
                    <span className="node-main">
                      <strong>{WORKSPACE_SECTIONS[1].title}</strong>
                      <small>{WORKSPACE_SECTIONS[1].description}</small>
                    </span>
                  </button>
                  <div className="project-list">
                    {projects.length === 0 ? <p className="muted">{ACTIVE_PRODUCT_PROFILE.workspaceSections.project.emptyText}</p> : null}
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
                            {isSelectedProject ? (
                              <span className="file-node-chevron">
                                {isProjectCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                              </span>
                            ) : null}
                            <span className="node-icon">{showTree ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
                            <span className="node-main">
                              <strong>{project.name}</strong>
                            </span>
                          </button>
                          {showTree ? (
                            <div className="file-tree nested-tree">
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
                                        setActiveWorkspaceScope('project');
                                        setSelectedProjectPath(entry.path);
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
                                          setActiveWorkspaceScope('temporary');
                                          setSelectedTemporaryProjectId(session.projectId);
                                          setSelectedTemporaryPath(entry.path);
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
        <div className="editor-header">
          <div className="editor-mini-bar">
            <span className="mini-bar__title" title={selectedPath ?? ''}>
              {selectedPath ? basename(selectedPath) : '选择文件'}
            </span>
            {hasUnsavedChanges ? <span className="dirty-marker">未保存</span> : null}
          </div>
          <div className="editor-top-bar">
            <div className="editor-breadcrumb">
              <span className="editor-breadcrumb__item">{selectedPath ?? '选择文件'}</span>
            </div>
            <div className="editor-actions">
              {hasUnsavedChanges ? <span className="dirty-marker">未保存</span> : null}
              <button type="button" disabled={!hasUnsavedChanges || saveState === 'saving'} onClick={() => void saveFile()}>
                <Save size={14} />
                {saveState === 'saving' ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>

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
                    onChange: (content: string) => {
                      setFileContent(content);
                      setSaveState('idle');
                      setSaveError(null);
                    },
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
                    onTextSelection={handleChatTextSelection}
                    onOpenAttachment={handleOpenChatAttachment}
                    onChoiceSelect={(option) => { setPrompt(option); }}
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
                  placeholder={activeChatSessionArchived ? '归档会话只读，恢复后可继续对话' : chatScope === 'project' && selectedProjectId ? '描述这一场戏、角色动机、对白要求或图片需求，输入 @ 引用项目文件' : '继续临时会话，可直接对话或生成图片'}
                  disabled={activeChatSessionArchived}
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
                    disabled={activeChatSessionArchived || !prompt.trim()}
                    onClick={() => void submitPrompt()}
                    aria-label="发送"
                    title="发送"
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
                <p className="eyebrow">
                  {activeToolPanel === 'skills' ? 'Agent Skills' : activeToolPanel === 'settings' ? 'Agent Settings' : 'Remote WeChat'}
                </p>
                <h2>
                  {activeToolPanel === 'skills' ? 'Agent 技能' : activeToolPanel === 'settings' ? 'Agent 行为规则' : '远程微信接入'}
                </h2>
              </div>
              <button type="button" onClick={() => setActiveToolPanel(null)}>关闭</button>
            </div>

            {activeToolPanel === 'skills' ? (
              <div className="skills-plaza">
                {skillsState === 'loading' ? <p className="muted">正在加载技能...</p> : null}
                {skillsState === 'error' ? <p className="inline-error">技能加载失败</p> : null}
                <div className="skill-grid">
                  {skills.map((skill) => (
                    <article key={skill.slug} className="skill-card">
                      <div>
                        <strong>{skill.title}</strong>
                        <span>{skill.scope === 'system' ? '系统' : '自定义'}</span>
                      </div>
                      <p>{skill.description}</p>
                      {skill.location ? <p className="muted">{skill.location}</p> : null}
                      {skill.mutable === false ? (
                        <span className="status-pill success">文件技能</span>
                      ) : (
                        <button type="button" onClick={() => void toggleSkill(skill)}>
                          {skill.enabled ? '已启用' : '已停用'}
                        </button>
                      )}
                    </article>
                  ))}
                </div>
                <div className="create-skill-form">
                  <input value={newSkill.title} onChange={(event) => setNewSkill({ ...newSkill, title: event.target.value })} />
                  <input value={newSkill.description} onChange={(event) => setNewSkill({ ...newSkill, description: event.target.value })} />
                  <textarea value={newSkill.prompt} onChange={(event) => setNewSkill({ ...newSkill, prompt: event.target.value })} />
                  <button type="button" onClick={() => void createSkill()}>创建创作技能</button>
                </div>
              </div>
            ) : null}

            {activeToolPanel === 'wechat' ? (
              <div className="wechat-panel">
                {wechatState === 'loading' ? <p className="muted">正在读取微信接入状态...</p> : null}

                <WechatPanelBody
                  wechatStatus={wechatStatus}
                  wechatSetup={wechatSetup}
                  wechatState={wechatState}
                  onCreateSetup={() => void createWechatSetup()}
                  onDisconnect={async () => { await apiClient.disconnectWechat(); await loadWechatStatus(); }}
                />
              </div>
            ) : null}

            {activeToolPanel === 'settings' ? (
              <div className="settings-panel">
                {behaviorRulesState === 'loading' && behaviorRules.length === 0 ? (
                  <p className="muted">正在加载行为规则...</p>
                ) : null}
                {behaviorRulesState === 'error' ? <p className="inline-error">规则加载失败</p> : null}
                <p className="muted">以下规则会在每次对话时注入 Agent 指令。修改后立即生效，无需重启。</p>
                <div className="behavior-rules-list">
                  {behaviorRules.map((rule) => (
                    <div key={rule.id} className="behavior-rule-card">
                      <div className="rule-header">
                        <label className="rule-toggle">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(event) => updateBehaviorRule(rule.id, { enabled: event.target.checked })}
                          />
                          <span>{rule.enabled ? '已启用' : '已停用'}</span>
                        </label>
                        <input
                          className="rule-label-input"
                          value={rule.label}
                          onChange={(event) => updateBehaviorRule(rule.id, { label: event.target.value })}
                        />
                        {rule.builtIn ? (
                          <span className="status-pill success">内置</span>
                        ) : (
                          <button type="button" className="rule-remove-btn" onClick={() => removeBehaviorRule(rule.id)}>
                            删除
                          </button>
                        )}
                      </div>
                      <textarea
                        className="rule-content-input"
                        rows={4}
                        value={rule.content}
                        onChange={(event) => updateBehaviorRule(rule.id, { content: event.target.value })}
                        placeholder="输入规则内容，会在注入到 Agent 的系统指令中..."
                      />
                    </div>
                  ))}
                </div>
                <div className="settings-actions">
                  <button type="button" onClick={addBehaviorRule}>+ 添加自定义规则</button>
                  <button type="button" onClick={() => void saveBehaviorRules()}>
                    {behaviorRulesState === 'loading' ? '保存中...' : '保存规则'}
                  </button>
                </div>
              </div>
            ) : null}
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

function isSupportedTextFile(path: string): boolean {
  return TEXT_FILE_PATTERN.test(path);
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
  onTextSelection,
  onOpenAttachment,
  onChoiceSelect,
}: {
  message: ChatMessage;
  onTextSelection: ChatMessageTextSelectionHandler;
  onOpenAttachment: (attachment: ChatMessageAttachment) => void;
  onChoiceSelect?: (option: string) => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const canCopy = message.content.trim().length > 0;

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

  if (runState === 'running') {
    return '运行中';
  }

  return run?.status ?? runState;
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
    case 'tool.result':
      return `${event.name}${event.output ? ` ${JSON.stringify(event.output)}` : ''}`;
    case 'file.changed':
      return `${event.path} ${event.change}`;
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
  } = {},
): ChatMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function modelsForCapability(models: AigcHubModelMetadata[], capability: 'chat' | 'image'): AigcHubModelMetadata[] {
  const filtered = models.filter((model) => modelSupportsCapability(model, capability));
  return filtered.length > 0 ? filtered : models;
}

function modelSupportsCapability(model: AigcHubModelMetadata, capability: 'chat' | 'image'): boolean {
  const id = model.id.toLowerCase();
  const caps = model.capabilities.join(' ').toLowerCase();

  if (capability === 'chat') {
    if (caps) return /chat|text|response|responses|completion|completions|tool/.test(caps);
    return !/image|dall[-_]?e|flux|sdxl|stable[-_]?diffusion|midjourney|embedding/.test(id);
  }
  if (caps) return /image[-_]?generation|text[-_]?to[-_]?image/.test(caps);
  return /image|dall[-_]?e|flux|sdxl|stable[-_]?diffusion|midjourney/.test(id) && !/embedding/.test(id);
}

function preferredModelId(models: AigcHubModelMetadata[], capability: 'chat' | 'image'): string {
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
    themeMode: readStoredThemeMode(),
  };
}

const WechatPanelBody = memo(function WechatPanelBody({
  wechatStatus,
  wechatSetup,
  wechatState,
  onCreateSetup,
  onDisconnect,
}: {
  wechatStatus: WechatStatus | null;
  wechatSetup: WechatSetupSession | null;
  wechatState: LoadState;
  onCreateSetup: () => void;
  onDisconnect: () => Promise<unknown>;
}): JSX.Element {
  const isConnected = wechatStatus?.state === "connected";

  return (
    <>
      <p className={`status-pill ${isConnected ? "success" : "idle"}`}>
        {isConnected ? `已连接：${wechatStatus!.connection?.displayName}` : "未连接"}
      </p>

      {isConnected ? (
        <div className="wechat-card">
          <p className="muted">
            微信已连接 · 用户: {wechatStatus!.connection?.displayName}
            <br />
            连接时间: {wechatStatus!.connection?.connectedAt ? new Date(wechatStatus!.connection!.connectedAt).toLocaleString() : "-"}
          </p>
          <button type="button" className="wechat-small-btn" style={{ marginTop: 8 }} onClick={() => void onDisconnect()}>
            解绑微信
          </button>
        </div>
      ) : (
        <div className="wechat-card">
          <button type="button" onClick={() => void onCreateSetup()}>生成连接码</button>
          {wechatSetup ? (
            <div className="wechat-qr-wrap">
              <img
                src={resolveApiUrl(`/api/wechat/setup-sessions/${encodeURIComponent(wechatSetup.sessionId)}/qr`)}
                alt="微信扫码连接"
                width={200}
                height={200}
              />
              <p className="muted" style={{ fontSize: "0.7rem", marginTop: 6 }}>请用微信扫描二维码，等待自动连接</p>
            </div>
          ) : null}
        </div>
      )}
      <p className="muted">扫码后自动完成绑定。微信入站消息会自动通过创作助手处理。</p>
    </>
  );
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
