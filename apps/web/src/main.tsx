import {
  Fragment,
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createRoot } from 'react-dom/client';

import {
  apiClient,
  type AgentRun,
  type ChatMessage,
  type ChatSession,
  type Project,
  type ReferencedFile,
  type RunEvent,
  type StreamEvent,
  type TheaterSkill,
  type WechatSetupSession,
  type WechatStatus,
  type WorkspaceEntry,
} from './api';
import { buildReferenceSuggestions, getActiveReferenceQuery, insertReference, type FileReference, type ReferenceSuggestion } from './chat-references';
import { MarkdownReadPreview, renderEditorViewer } from './viewer-components';
import {
  WORKSPACE_SECTIONS,
  buildCollapsedDirectoryPaths,
  filterVisibleWorkspaceEntries,
  toggleCollapsedPath,
} from './workspace-tree';
import './styles.css';

const DEFAULT_PROJECT_NAME = '办公室奇遇记';
const DEFAULT_PROJECT_DESCRIPTION = '围绕办公室日常冲突展开的轻喜剧情景剧。';
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

type LoadState = 'idle' | 'loading' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type RunState = 'idle' | 'running' | 'success' | 'error';

type SidebarContextMenu = {
  x: number;
  y: number;
  workspaceScope: 'global' | 'project';
  projectId: string | null;
  entryPath: string | null;
  entryType: WorkspaceEntry['type'] | null;
};

type ChatSessionContextMenu = {
  x: number;
  y: number;
  sessionId: string;
};

type SelectedTextContextMenu = {
  x: number;
  y: number;
  text: string;
  sourcePath: string;
};

type CreateEntryDraft = {
  workspaceScope: 'global' | 'project';
  projectId: string | null;
  parentPath: string;
  kind: 'folder' | 'file';
  name: string;
};

type RenameEntryDraft = {
  workspaceScope: 'global' | 'project';
  projectId: string | null;
  entryPath: string;
  originalName: string;
  name: string;
};

type DragEntryDraft = {
  workspaceScope: 'global' | 'project';
  projectId: string | null;
  entryPath: string;
  entryType: WorkspaceEntry['type'];
};

function App() {
  const fileUploadRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const workspaceGridRef = useRef<HTMLElement | null>(null);
  const chatMessagePersistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const createEntryInputRef = useRef<HTMLInputElement | null>(null);
  const skipCreateEntryBlurRef = useRef(false);
  const renameEntryInputRef = useRef<HTMLInputElement | null>(null);
  const skipRenameEntryBlurRef = useRef(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
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

  const [activeWorkspaceScope, setActiveWorkspaceScope] = useState<'global' | 'project'>('global');
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [selectedGlobalPath, setSelectedGlobalPath] = useState<string | null>(null);
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
  const [referenceSuggestions, setReferenceSuggestions] = useState<ReferenceSuggestion[]>([]);
  const [referenceQuery, setReferenceQuery] = useState<{ start: number; end: number; query: string } | null>(null);
  const [activeReferenceIndex, setActiveReferenceIndex] = useState(0);
  const [chatReadingMode, setChatReadingMode] = useState(() => readStoredChatReadingMode());
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [chatSessionsProjectId, setChatSessionsProjectId] = useState<string | null>(null);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [chatSessionView, setChatSessionView] = useState<'active' | 'archived'>('active');
  const [collapsedPanels, setCollapsedPanels] = useState({ workspace: false, editor: false, chat: false });
  const [panelWidths, setPanelWidths] = useState({ workspace: 238, chat: 340 });
  const [collapsedGlobalPaths, setCollapsedGlobalPaths] = useState<string[]>([]);
  const [collapsedDirectoriesByProject, setCollapsedDirectoriesByProject] = useState<Record<string, string[]>>({});
  const [activeToolPanel, setActiveToolPanel] = useState<'skills' | 'wechat' | null>(null);
  const [sidebarContextMenu, setSidebarContextMenu] = useState<SidebarContextMenu | null>(null);
  const [chatSessionContextMenu, setChatSessionContextMenu] = useState<ChatSessionContextMenu | null>(null);
  const [selectedTextContextMenu, setSelectedTextContextMenu] = useState<SelectedTextContextMenu | null>(null);
  const [createEntryDraft, setCreateEntryDraft] = useState<CreateEntryDraft | null>(null);
  const [renameEntryDraft, setRenameEntryDraft] = useState<RenameEntryDraft | null>(null);
  const renameEntryFocusKey = renameEntryDraft
    ? `${renameEntryDraft.workspaceScope}:${renameEntryDraft.projectId ?? ''}:${renameEntryDraft.entryPath}`
    : null;
  const [quickActionError, setQuickActionError] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<{ workspaceScope: 'global' | 'project'; projectId: string | null; parentPath: string } | null>(null);
  const [dragEntry, setDragEntry] = useState<DragEntryDraft | null>(null);
  const [dragOverTargetKey, setDragOverTargetKey] = useState<string | null>(null);
  const [skills, setSkills] = useState<TheaterSkill[]>([]);
  const [skillsState, setSkillsState] = useState<LoadState>('idle');
  const [newSkill, setNewSkill] = useState({
    title: '冷开场生成器',
    description: '根据本集主题写一个 30 秒冷开场。',
    prompt: '请生成一个短促、有反转的情景剧冷开场。',
  });
  const [wechatStatus, setWechatStatus] = useState<WechatStatus | null>(null);
  const [wechatSetup, setWechatSetup] = useState<WechatSetupSession | null>(null);
  const [wechatState, setWechatState] = useState<LoadState>('idle');

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const activeEntries = activeWorkspaceScope === 'global' ? globalEntries : entries;
  const selectedPath = activeWorkspaceScope === 'global' ? selectedGlobalPath : selectedProjectPath;
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
      ? `/api/global/raw/${encodeWorkspacePath(selectedPath)}`
      : selectedProjectId
        ? `/api/projects/${encodeURIComponent(selectedProjectId)}/raw/${encodeWorkspacePath(selectedPath)}`
        : ''
    : '';
  const hasUnsavedChanges = isTextFile && fileContent !== lastSavedContent;
  const projectChatSessions = useMemo(
    () =>
      chatSessions
        .filter((session) => session.projectId === selectedProjectId && !session.archivedAt)
        .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt)),
    [chatSessions, selectedProjectId],
  );
  const archivedChatSessions = useMemo(
    () =>
      chatSessions
        .filter((session) => session.projectId === selectedProjectId && session.archivedAt)
        .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt)),
    [chatSessions, selectedProjectId],
  );
  const displayedChatSessions = chatSessionView === 'archived' ? archivedChatSessions : projectChatSessions;
  const activeChatSession = useMemo(
    () =>
      chatSessions.find((session) => session.projectId === selectedProjectId && session.id === activeChatSessionId) ??
      projectChatSessions[0] ??
      null,
    [activeChatSessionId, chatSessions, projectChatSessions, selectedProjectId],
  );
  const activeChatSessionArchived = Boolean(activeChatSession?.archivedAt);
  const visibleEntries = useMemo(
    () => filterVisibleWorkspaceEntries(entries, collapsedDirectoriesByProject[selectedProjectId ?? ''] ?? []),
    [collapsedDirectoriesByProject, entries, selectedProjectId],
  );
  const visibleGlobalEntries = useMemo(
    () => filterVisibleWorkspaceEntries(globalEntries, collapsedGlobalPaths),
    [collapsedGlobalPaths, globalEntries],
  );
  const selectedProjectFiles = useMemo(
    () => entries.filter((entry) => entry.type === 'file'),
    [entries],
  );

  useEffect(() => {
    void loadProjects();
    void loadGlobalEntries();
  }, []);

  useEffect(() => {
    writeStoredChatReadingMode(chatReadingMode);
  }, [chatReadingMode]);

  useEffect(() => {
    if (!createEntryDraft) return;
    requestAnimationFrame(() => {
      createEntryInputRef.current?.focus();
      createEntryInputRef.current?.select();
    });
  }, [createEntryDraft]);

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
  }, [activeToolPanel]);

  useEffect(() => {
    if (!selectedProjectId) {
      setEntries([]);
      setSelectedProjectPath(null);
      return;
    }

    void loadEntries(selectedProjectId, { selectFirstTextFile: true });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setActiveChatSessionId(null);
      setChatSessions([]);
      setChatSessionsProjectId(null);
      setReferencedFiles([]);
      setPrompt('');
      closeReferenceMenu();
      return;
    }

    void loadProjectChatSessions(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || chatSessionsProjectId !== selectedProjectId) {
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
  }, [chatSessionsProjectId, projectChatSessions, selectedProjectId]);

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

    if (selectedProjectId) {
      void loadFile(selectedProjectId, selectedEntry.path);
    }
  }, [activeWorkspaceScope, selectedProjectId, selectedEntry?.path, selectedEntry?.type]);

  useEffect(() => {
    setReferencedFiles([]);
    setPrompt('');
    closeReferenceMenu();
  }, [activeChatSessionId]);

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

        return loadedProjects[0]?.id ?? null;
      });
      setProjectLoadState('idle');
    } catch (error) {
      setProjectLoadState('error');
      setProjectLoadError(errorToMessage(error));
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

      setCollapsedGlobalPaths(buildCollapsedDirectoryPaths(loadedEntries, options.revealPath ?? null));
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
    } catch (error) {
      setRunError(errorToMessage(error));
      setChatSessionsProjectId(projectId);
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
    const name = window.prompt('新情景剧项目名称', DEFAULT_PROJECT_NAME)?.trim();
    if (!name) return;
    const description = window.prompt('一句话描述题材', DEFAULT_PROJECT_DESCRIPTION)?.trim() || '';
    setIsCreatingProject(true);
    setCreateProjectError(null);
    try {
      const project = await apiClient.createProject({ name, description });
      setProjects((currentProjects) => [project, ...currentProjects.filter((item) => item.id !== project.id)]);
      setSelectedProjectId(project.id);
    } catch (error) {
      setCreateProjectError(errorToMessage(error));
    } finally {
      setIsCreatingProject(false);
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
        [projectId]: buildCollapsedDirectoryPaths(loadedEntries, options.revealPath ?? null),
      }));
      setEntriesState('idle');
    } catch (error) {
      setEntriesState('error');
      setEntriesError(errorToMessage(error));
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

      if (!selectedProjectId) {
        return;
      }

      const savedFile = await apiClient.writeWorkspaceFile(selectedProjectId, selectedPath, fileContent);
      setLastSavedContent(savedFile.content);
      setSaveState('saved');
      await loadEntries(selectedProjectId, { keepSelectedPath: selectedPath, revealPath: selectedPath });
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
      await loadEntries(draft.projectId, { keepSelectedPath: entryPath, revealPath: entryPath });
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

      if (!selectedProjectId) return;
      const moved = await apiClient.moveEntry(selectedProjectId, selectedPath, targetPath.trim());
      await loadEntries(selectedProjectId, { keepSelectedPath: moved.path, revealPath: moved.path });
      setSelectedProjectPath(moved.path);
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  async function moveEntryToDirectory(entry: DragEntryDraft, target: { workspaceScope: 'global' | 'project'; projectId: string | null; parentPath: string }) {
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
      await loadEntries(entry.projectId, { keepSelectedPath: moved.path, revealPath: moved.path });
      setSelectedProjectPath(moved.path);
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
      await loadEntries(draft.projectId, { keepSelectedPath: moved.path, revealPath: moved.path });
      setSelectedProjectPath(moved.path);
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

      if (!selectedProjectId) return;
      await apiClient.deleteEntry(selectedProjectId, selectedPath);
      setSelectedProjectPath(null);
      await loadEntries(selectedProjectId, { selectFirstTextFile: true });
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    }
  }

  function resolveUploadTarget(context: SidebarContextMenu | null = null) {
    const workspaceScope = context?.workspaceScope ?? activeWorkspaceScope;
    const projectId = workspaceScope === 'global' ? null : context?.projectId ?? selectedProjectId;
    const contextPath = context?.entryPath ?? selectedPath;
    const contextType = context?.entryPath ? context.entryType : selectedEntry?.type ?? null;
    const parentPath = contextType === 'directory'
      ? contextPath ?? ''
      : contextPath
        ? parentDirectory(contextPath)
        : '';
    return { workspaceScope, projectId, parentPath };
  }

  function startUpload(context: SidebarContextMenu | null = null) {
    const target = resolveUploadTarget(context);
    setUploadTarget(target);
    setActiveWorkspaceScope(target.workspaceScope);
    if (target.projectId) {
      setSelectedProjectId(target.projectId);
    }
    fileUploadRef.current?.click();
  }

  async function uploadAsset(file: File) {
    setQuickActionError(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const target = uploadTarget ?? resolveUploadTarget();
      const assetPath = joinWorkspacePath(target.parentPath, file.name);
      if (target.workspaceScope === 'global') {
        const asset = await apiClient.createGlobalAsset({
          path: assetPath,
          contentBase64,
          mimeType: file.type || undefined,
        });
        await loadGlobalEntries({ keepSelectedPath: asset.path, revealPath: asset.path });
        setSelectedGlobalPath(asset.path);
        return;
      }

      if (!target.projectId) return;
      const asset = await apiClient.createAsset(target.projectId, {
        path: assetPath,
        contentBase64,
        mimeType: file.type || undefined,
      });
      await loadEntries(target.projectId, { keepSelectedPath: asset.path, revealPath: asset.path });
      setSelectedProjectPath(asset.path);
    } catch (error) {
      setQuickActionError(errorToMessage(error));
    } finally {
      setUploadTarget(null);
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

  function closeReferenceMenu() {
    setReferenceQuery(null);
    setReferenceSuggestions([]);
    setActiveReferenceIndex(0);
  }

  function updateReferenceMenu(nextPrompt: string, caret: number) {
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

  async function submitPrompt() {
    const messageText = prompt.trim();
    const session = activeChatSession;

    if (!selectedProjectId || !messageText || !session) {
      return;
    }

    const attachedReferences = [...referencedFiles];
    const userMessage = createChatMessage('user', messageText, { referencedFiles: attachedReferences });
    appendMessageToSession(session.id, userMessage);
    setPrompt('');
    setReferencedFiles([]);
    closeReferenceMenu();
    setRunState('running');
    setRunError(null);
    setCurrentRun(null);

    try {
      const response = await apiClient.createMockRun({
        projectId: selectedProjectId,
        sessionId: session.id,
        codexThreadId: session.codexThreadId ?? undefined,
        prompt: messageText,
        referencedFiles: attachedReferences,
      });
      setCurrentRun(response.run);

      if (response.events) {
        const endEvent = response.events.find((event): event is Extract<RunEvent, { type: 'run.end' }> => event.type === 'run.end');
        setRunState(endEvent?.status === 'error' || response.run.status === 'error' ? 'error' : 'success');
        appendMessageToSession(
          session.id,
          createChatMessage('assistant', assistantMessageFromEvents(response.events), {
            events: response.events,
            referencedFiles: response.run.referencedFiles,
            status: 'success',
          }),
        );
        await refreshWorkspaceAfterRun(selectedProjectId);
      } else {
        const assistantMessage = createChatMessage('assistant', '', {
          referencedFiles: response.run.referencedFiles,
          status: 'running',
        });
        appendMessageToSession(session.id, assistantMessage);
        apiClient.streamRunEvents(response.run.id, {
          onEvent: (event) => handleRunStreamEvent(session.id, assistantMessage.id, event),
          onError: (error) => {
            setRunState('error');
            setRunError(error.message);
            updateMessageInSession(session.id, assistantMessage.id, (message) => ({
              ...message,
              status: 'error',
              content: message.content || `运行失败：${error.message}`,
            }));
          },
        });
      }
    } catch (error) {
      setRunState('error');
      setRunError(errorToMessage(error));
      appendMessageToSession(
        session.id,
        createChatMessage('assistant', `运行失败：${errorToMessage(error)}`, { referencedFiles: attachedReferences }),
      );
    }
  }

  async function refreshWorkspaceAfterRun(projectId: string) {
    await loadEntries(projectId, { keepSelectedPath: selectedProjectPath, selectFirstTextFile: true });
    if (selectedProjectPath && isSupportedTextFile(selectedProjectPath)) {
      await loadFile(projectId, selectedProjectPath);
    }
  }

  function handleRunStreamEvent(sessionId: string, messageId: string, event: StreamEvent) {
    if (event.type === 'thread.started') {
      setChatSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.id === sessionId
            ? { ...session, codexThreadId: event.threadId, updatedAt: new Date().toISOString() }
            : session,
        ),
      );
      void apiClient.updateChatSession(sessionId, { codexThreadId: event.threadId }).catch((error) => {
        setRunError(errorToMessage(error));
      });
    }

    updateMessageInSession(sessionId, messageId, (message) => {
      const content = event.type === 'text.delta' ? message.content + event.delta : message.content;
      return {
        ...message,
        content,
        streamEvents: [...message.streamEvents, event],
        status: event.type === 'run.end' ? (event.status === 'success' ? 'success' : 'error') : 'running',
      };
    });

    if (event.type === 'run.end') {
      setRunState(event.status === 'success' ? 'success' : 'error');
      if (event.errorMessage) {
        setRunError(event.errorMessage);
      }
      if (selectedProjectId) {
        void refreshWorkspaceAfterRun(selectedProjectId);
      }
    }
  }

  function openSidebarContextMenu(
    event: React.MouseEvent,
    payload: { workspaceScope?: 'global' | 'project'; projectId?: string | null; entry?: WorkspaceEntry | null } = {},
  ) {
    event.preventDefault();
    event.stopPropagation();
    closeChatSessionContextMenu();
    closeSelectedTextContextMenu();
    const workspaceScope = payload.workspaceScope ?? 'project';
    setActiveWorkspaceScope(workspaceScope);
    if (payload.projectId) {
      setSelectedProjectId(payload.projectId);
    }
    if (payload.entry) {
      if (workspaceScope === 'global') {
        setSelectedGlobalPath(payload.entry.path);
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
      projectId: payload.projectId ?? selectedProjectId,
      entryPath: payload.entry?.path ?? null,
      entryType: payload.entry?.type ?? null,
    });
  }

  function closeSidebarContextMenu() {
    setSidebarContextMenu(null);
  }

  function openChatSessionContextMenu(event: React.MouseEvent, sessionId: string) {
    event.preventDefault();
    event.stopPropagation();
    closeSidebarContextMenu();
    closeSelectedTextContextMenu();
    const menuX = Math.min(event.clientX, window.innerWidth - SIDEBAR_CONTEXT_MENU_WIDTH - VIEWPORT_EDGE_GAP);
    const menuY = Math.min(event.clientY, window.innerHeight - 90 - VIEWPORT_EDGE_GAP);
    setChatSessionContextMenu({
      x: Math.max(VIEWPORT_EDGE_GAP, menuX),
      y: Math.max(VIEWPORT_EDGE_GAP, menuY),
      sessionId,
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
      sourcePath: selectedPath,
    });
  }

  function closeSelectedTextContextMenu() {
    setSelectedTextContextMenu(null);
  }

  function quoteSelectedTextToComposer() {
    if (!selectedTextContextMenu) return;
    const sourcePath = selectedTextContextMenu.sourcePath;
    const label = basename(sourcePath);
    const quote = selectedTextContextMenu.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const insertion = [`引用 @${label}：`, quote].join('\n');
    const separator = prompt.trim() ? '\n\n' : '';
    setPrompt((current) => `${current}${separator}${insertion}`);
    setReferencedFiles((current) =>
      current.some((item) => item.path === sourcePath)
        ? current
        : [...current, { path: sourcePath, label }],
    );
    closeSelectedTextContextMenu();
    closeReferenceMenu();
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      const end = composerRef.current?.value.length ?? 0;
      composerRef.current?.setSelectionRange(end, end);
    });
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

  function dragTargetKey(workspaceScope: 'global' | 'project', projectId: string | null, parentPath: string): string {
    return `${workspaceScope}:${projectId ?? ''}:${parentPath}`;
  }

  function canDropEntry(target: { workspaceScope: 'global' | 'project'; projectId: string | null; parentPath: string }): boolean {
    if (!dragEntry) return false;
    if (dragEntry.workspaceScope !== target.workspaceScope || dragEntry.projectId !== target.projectId) return false;
    if (dragEntry.entryType === 'directory' && (target.parentPath === dragEntry.entryPath || target.parentPath.startsWith(`${dragEntry.entryPath}/`))) return false;
    return joinWorkspacePath(target.parentPath, basename(dragEntry.entryPath)) !== dragEntry.entryPath;
  }

  function handleEntryDragStart(event: ReactDragEvent, workspaceScope: 'global' | 'project', projectId: string | null, entry: WorkspaceEntry) {
    const dragged: DragEntryDraft = { workspaceScope, projectId, entryPath: entry.path, entryType: entry.type };
    setDragEntry(dragged);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-viwork-entry', JSON.stringify(dragged));
  }

  function handleDropTargetDragOver(event: ReactDragEvent, target: { workspaceScope: 'global' | 'project'; projectId: string | null; parentPath: string }) {
    if (!canDropEntry(target)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverTargetKey(dragTargetKey(target.workspaceScope, target.projectId, target.parentPath));
  }

  async function handleDropOnDirectory(event: ReactDragEvent, target: { workspaceScope: 'global' | 'project'; projectId: string | null; parentPath: string }) {
    event.preventDefault();
    const droppedEntry = dragEntry;
    setDragEntry(null);
    setDragOverTargetKey(null);
    if (!droppedEntry) return;
    await moveEntryToDirectory(droppedEntry, target);
  }

  function dropTargetClass(workspaceScope: 'global' | 'project', projectId: string | null, parentPath: string): string {
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

  function workspaceGridColumns() {
    if (collapsedPanels.workspace) {
      return `0 0 minmax(520px, 1fr) 8px ${panelWidths.chat}px`;
    }

    return `${panelWidths.workspace}px 8px minmax(420px, 1fr) 8px ${panelWidths.chat}px`;
  }

  function openDirectoryForDraft(draft: CreateEntryDraft) {
    if (!draft.parentPath) return;

    if (draft.workspaceScope === 'global') {
      setCollapsedGlobalPaths((current) => current.filter((path) => path !== draft.parentPath));
      return;
    }

    const projectId = draft.projectId;
    if (!projectId) return;
    setCollapsedDirectoriesByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).filter((directoryPath) => directoryPath !== draft.parentPath),
    }));
  }

  function startCreateEntry(kind: CreateEntryDraft['kind'], context: SidebarContextMenu | null) {
    const workspaceScope = context?.workspaceScope ?? 'project';
    const projectId = workspaceScope === 'global' ? null : context?.projectId ?? selectedProjectId;
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
    if (projectId) {
      setSelectedProjectId(projectId);
    }
    setCreateEntryDraft(draft);
    setRenameEntryDraft(null);
    openDirectoryForDraft(draft);
  }

  function startRenameEntry(context: SidebarContextMenu | null) {
    if (!context?.entryPath) return;
    const workspaceScope = context.workspaceScope;
    const projectId = workspaceScope === 'global' ? null : context.projectId ?? selectedProjectId;
    setActiveWorkspaceScope(workspaceScope);
    if (projectId) {
      setSelectedProjectId(projectId);
    }
    if (workspaceScope === 'global') {
      setSelectedGlobalPath(context.entryPath);
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

  async function runSidebarAction(action: 'new-project' | 'new-folder' | 'new-file' | 'upload' | 'rename' | 'move' | 'delete') {
    const context = sidebarContextMenu;
    closeSidebarContextMenu();

    if (action === 'new-project') {
      await createProjectFromContext();
      return;
    }

    if (context?.projectId && context.projectId !== selectedProjectId) {
      setSelectedProjectId(context.projectId);
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

    if (action === 'rename') {
      startRenameEntry(context);
      return;
    }

    if (action === 'move' && context?.entryPath) {
      if (context.workspaceScope === 'global') {
        setSelectedGlobalPath(context.entryPath);
      } else {
        setSelectedProjectPath(context.entryPath);
      }
      const targetPath = window.prompt('移动到', context.entryPath);
      if (targetPath && targetPath !== context.entryPath) {
        await moveSelectedEntry(targetPath);
      }
      return;
    }

    if (action === 'delete' && context?.entryPath) {
      if (context.workspaceScope === 'global') {
        setSelectedGlobalPath(context.entryPath);
      } else {
        setSelectedProjectPath(context.entryPath);
      }
      if (window.confirm(`删除 ${context.entryPath}？`)) {
        await deleteSelectedEntry();
      }
    }
  }

  function renderCreateEntryDraft(workspaceScope: 'global' | 'project', projectId: string | null, parentPath: string, depth: number) {
    const draft = createEntryDraft;
    if (!draft || draft.workspaceScope !== workspaceScope || draft.projectId !== projectId || draft.parentPath !== parentPath) {
      return null;
    }

    const icon = draft.kind === 'folder' ? '▾' : '•';
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

  function renderRenameEntryDraft(entry: WorkspaceEntry, workspaceScope: 'global' | 'project', projectId: string | null) {
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
        <span className="file-node-icon">{entry.type === 'directory' ? '▾' : '•'}</span>
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
    if (!selectedProjectId) {
      return;
    }

    await createAndActivateChatSession(selectedProjectId);
    setPrompt('');
    setReferencedFiles([]);
    closeReferenceMenu();
    setRunError(null);
    setRunState('idle');
    setCurrentRun(null);
  }

  function openChatSession(sessionId: string) {
    closeChatSessionContextMenu();
    setActiveChatSessionId(sessionId);
    setPrompt('');
    setReferencedFiles([]);
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
    chatMessagePersistQueueRef.current = chatMessagePersistQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await apiClient.updateChatMessage(sessionId, messageId, message);
      })
      .catch((error) => {
        setRunError(errorToMessage(error));
      });
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
        closeSidebarContextMenu();
        closeChatSessionContextMenu();
        closeSelectedTextContextMenu();
      }}
    >
      <header className="top-bar">
        <div className="brand-line" aria-label="viwork">
          <span className="logo-mark">v</span>
          <strong>viwork</strong>
        </div>
        <nav className="toolbar-actions" aria-label="页面工具">
          <button type="button" className="toolbar-text-button" onClick={() => setActiveToolPanel('skills')}>
            技能广场
          </button>
          <button type="button" className="toolbar-text-button" onClick={() => setActiveToolPanel('wechat')}>
            微信接入
          </button>
          <button type="button" className="toolbar-button active" aria-label="浅色风格" title="浅色风格">
            ☼
          </button>
          <button type="button" className="toolbar-button" aria-label="深色风格" title="深色风格">
            ◐
          </button>
          <button type="button" className="toolbar-button" aria-label="紧凑布局" title="紧凑布局">
            ⊞
          </button>
          <button type="button" className="toolbar-button" aria-label="设置" title="设置">
            ⚙
          </button>
        </nav>
      </header>

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
        <main
          ref={workspaceGridRef}
          className={`workspace-grid ${collapsedPanels.workspace ? 'workspace-grid--workspace-collapsed' : ''}`}
          style={{ gridTemplateColumns: workspaceGridColumns() }}
        >
          <aside className="panel sidebar">
            <section>
              <div className="panel-heading">
                <h2>工作区</h2>
                <div className="sidebar-actions">
                  <button
                    type="button"
                    className="sidebar-tool-button"
                    onClick={() => setCollapsedPanels((current) => ({ ...current, workspace: true }))}
                    aria-label="折叠工作区"
                    title="折叠工作区"
                  >
                    ‹
                  </button>
                  <button type="button" className="sidebar-tool-button" onClick={() => void loadProjects()} aria-label="刷新项目" title="刷新项目">
                    ↻
                  </button>
                  <button type="button" className="sidebar-tool-button" onClick={() => void loadGlobalEntries()} aria-label="刷新全局" title="刷新全局">
                    ◎
                  </button>
                  <button type="button" className="sidebar-tool-button" onClick={() => startUpload()} aria-label="上传素材" title="上传素材">
                    ↑
                  </button>
                </div>
              </div>
              <input
                ref={fileUploadRef}
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void uploadAsset(file);
                  else setUploadTarget(null);
                }}
              />

              {createProjectError ? <p className="inline-error">{createProjectError}</p> : null}

              <div className="workspace-tree">
                <div className="workspace-section">
                  <button
                    type="button"
                    className={`workspace-section-root${dropTargetClass('global', null, '')}`}
                    title={WORKSPACE_SECTIONS[0].description}
                    onClick={() => setActiveWorkspaceScope('global')}
                    onDragOver={(event) => handleDropTargetDragOver(event, { workspaceScope: 'global', projectId: null, parentPath: '' })}
                    onDragLeave={() => setDragOverTargetKey(null)}
                    onDrop={(event) => void handleDropOnDirectory(event, { workspaceScope: 'global', projectId: null, parentPath: '' })}
                    onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'global', projectId: null })}
                  >
                    <span className="node-icon">◇</span>
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
                              if (entry.type === 'directory') {
                                toggleGlobalDirectory(entry.path);
                              }
                            }}
                            onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'global', entry })}
                            title={entry.path}
                          >
                            <span className="file-node-label">
                              <span className="file-node-icon">
                                {entry.type === 'directory'
                                  ? collapsedGlobalPaths.includes(entry.path) ? '▸' : '▾'
                                  : '•'}
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
                    <span className="node-icon">▦</span>
                    <span className="node-main">
                      <strong>{WORKSPACE_SECTIONS[1].title}</strong>
                      <small>{WORKSPACE_SECTIONS[1].description}</small>
                    </span>
                  </button>
                  <div className="project-list">
                    {projects.length === 0 ? <p className="muted">暂无情景剧项目。</p> : null}
                    {projects.map((project) => {
                      const isSelectedProject = project.id === selectedProjectId;
                      return (
                        <div key={project.id} className={`project-node ${isSelectedProject ? 'selected' : ''}`}>
                          <button
                            type="button"
                            className={`project-root${dropTargetClass('project', project.id, '')}`}
                            onClick={() => {
                              setActiveWorkspaceScope('project');
                              setSelectedProjectId(project.id);
                            }}
                            onDragOver={(event) => handleDropTargetDragOver(event, { workspaceScope: 'project', projectId: project.id, parentPath: '' })}
                            onDragLeave={() => setDragOverTargetKey(null)}
                            onDrop={(event) => void handleDropOnDirectory(event, { workspaceScope: 'project', projectId: project.id, parentPath: '' })}
                            onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'project', projectId: project.id })}
                          >
                            <span className="node-icon">▣</span>
                            <span className="node-main">
                              <strong>{project.name}</strong>
                            </span>
                          </button>
                          {isSelectedProject ? (
                            <div className="file-tree nested-tree">
                              {entriesState === 'error' ? <p className="inline-error">{entriesError}</p> : null}
                              {entriesState === 'loading' ? <p className="muted">正在加载文件...</p> : null}
                              {renderCreateEntryDraft('project', project.id, '', 0)}
                              {visibleEntries.map((entry) => (
                                <Fragment key={entry.path}>
                                  {renderRenameEntryDraft(entry, 'project', project.id) ?? (
                                    <button
                                      type="button"
                                      className={`file-node ${entry.type === 'directory' ? `directory-node${dropTargetClass('project', project.id, entry.path)}` : 'document-node'} ${entry.path === selectedPath ? 'selected' : ''}`}
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
                                        if (entry.type === 'directory') {
                                          toggleDirectory(project.id, entry.path);
                                        }
                                      }}
                                      onContextMenu={(event) => openSidebarContextMenu(event, { workspaceScope: 'project', projectId: project.id, entry })}
                                      title={entry.path}
                                    >
                                      <span className="file-node-label">
                                        <span className="file-node-icon">
                                          {entry.type === 'directory'
                                            ? (collapsedDirectoriesByProject[project.id] ?? []).includes(entry.path) ? '▸' : '▾'
                                            : '•'}
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
              </div>
              {quickActionError ? <p className="inline-error">{quickActionError}</p> : null}
            </section>
          </aside>

          <div
            className="panel-resizer"
            role="separator"
            aria-label="调整工作区宽度"
            aria-orientation="vertical"
            onPointerDown={(event) => startPanelResize(event, 'workspace')}
          />

          <section className="panel editor-panel">
            <div className="panel-heading editor-heading">
              <div>
                <p className="eyebrow">编辑器</p>
                <h2>{selectedPath ?? '选择文件'}</h2>
              </div>
              <div className="editor-actions">
                {hasUnsavedChanges ? <span className="dirty-marker">未保存</span> : null}
                <button type="button" disabled={!hasUnsavedChanges || saveState === 'saving'} onClick={() => void saveFile()}>
                  {saveState === 'saving' ? '保存中...' : '保存'}
                </button>
              </div>
            </div>

            <div className="editor-scroll" onContextMenu={openSelectedTextContextMenu}>
              {!selectedEntry ? <div className="editor-empty">从左侧选择一个 Markdown 或文本文件。</div> : null}
              {selectedEntry?.type === 'directory' ? <div className="editor-empty">这是目录，请选择其中的文本文件进行编辑。</div> : null}
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
                          } else if (selectedProjectId) {
                            void loadFile(selectedProjectId, selectedPath);
                          }
                        }}
                      >
                        重试读取
                      </button>
                    </div>
                  ) : null}
                  {renderEditorViewer({
                    entry: selectedEntry,
                    selectedProjectId: selectedProjectId ?? 'global',
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

          <div
            className="panel-resizer"
            role="separator"
            aria-label="调整创作助手宽度"
            aria-orientation="vertical"
            onPointerDown={(event) => startPanelResize(event, 'chat')}
          />

          <aside className={`panel session-panel ${chatReadingMode ? 'session-panel--reading' : ''}`}>
            <div className="panel-heading session-heading">
              <div>
                <p className="eyebrow">AI Session</p>
                <h2>创作助手</h2>
              </div>
              <div className="session-heading-actions">
                <span className={`status-pill ${runState}`}>{runStatusLabel(runState, currentRun)}</span>
                <button
                  type="button"
                  className={`toolbar-button text-mode-button ${chatReadingMode ? 'active' : ''}`}
                  onClick={() => setChatReadingMode((current) => !current)}
                  aria-label={chatReadingMode ? '切换为紧凑字号' : '切换为阅读字号'}
                  title={chatReadingMode ? '紧凑字号' : '阅读字号'}
                >
                  Aa
                </button>
                <button type="button" className="toolbar-button" onClick={createNewChatSession} aria-label="新建会话" title="新建会话">
                  +
                </button>
              </div>
            </div>

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
                  onContextMenu={(event) => openChatSessionContextMenu(event, session.id)}
                  title={session.title}
                >
                  <span className="chat-session-tab__title">{session.title}</span>
                  <span className="chat-session-tab__meta">
                    {session.messages.length} 条 · {formatChatTime(session.updatedAt)}
                  </span>
                </button>
              ))}
              {displayedChatSessions.length === 0 ? (
                <span className="chat-session-empty">{chatSessionView === 'archived' ? '暂无归档会话' : '暂无最近会话'}</span>
              ) : null}
            </section>

            <section className="chat-thread">
              {activeChatSession?.messages.length ? (
                activeChatSession.messages.map((message) => (
                  <article key={message.id} className={`chat-message chat-message--${message.role}`}>
                    <div className="chat-avatar">{message.role === 'user' ? '我' : 'AI'}</div>
                    <div className="chat-bubble-wrap">
                      <div className="chat-meta">
                        <span>{message.role === 'user' ? '你' : '创作助手'}</span>
                        <time dateTime={message.createdAt}>{formatChatTime(message.createdAt)}</time>
                      </div>
                      {message.referencedFiles.length > 0 ? (
                        <div className="chat-reference-row">
                          {message.referencedFiles.map((reference) => (
                            <span key={`${message.id}-${reference.path}`} className="ctx-chip" title={reference.path}>
                              @{reference.label}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className={`chat-bubble ${message.role === 'assistant' ? 'chat-bubble--assistant' : 'chat-bubble--user'}`}>
                        {message.role === 'assistant' ? (
                          <AssistantStreamBody message={message} />
                        ) : (
                          <p>{message.content}</p>
                        )}
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
                ))
              ) : (
                <div className="chat-empty">
                  <p>从右侧直接开始和创作助手对话。</p>
                  <p className="muted">输入 `@` 可以引用当前项目里的剧本、人物设定、分镜或制作文档。</p>
                </div>
              )}
            </section>

            <section className="composer">
              {referencedFiles.length > 0 ? (
                <div className="composer__ctx-row" role="list">
                  {referencedFiles.map((reference) => (
                    <span key={reference.path} className="ctx-chip" title={reference.path}>
                      <span className="ctx-chip__label">@{reference.label}</span>
                      <button type="button" className="ctx-chip__remove" onClick={() => removeReferencedFile(reference.path)} aria-label={`移除 ${reference.label}`}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
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
	                  placeholder={activeChatSessionArchived ? '归档会话只读，恢复后可继续对话' : '描述这一场戏、角色动机或对白要求，输入 @ 引用项目文件'}
	                  disabled={activeChatSessionArchived}
	                  onChange={handleComposerChange}
                  onClick={(event) => updateReferenceMenu(prompt, event.currentTarget.selectionStart ?? prompt.length)}
                  onKeyDown={handleComposerKeyDown}
                />
                <div className="composer__toolbar">
                  <div className="composer__left">
                    <span className="muted">{selectedProject ? selectedProject.name : '未选择项目'}</span>
                  </div>
                  <div className="composer__right">
                    {runError ? <span className="inline-error">运行失败：{runError}</span> : null}
                    <button
	                      type="button"
	                      className="composer__send"
	                      disabled={activeChatSessionArchived || !selectedProjectId || !prompt.trim() || runState === 'running'}
                      onClick={() => void submitPrompt()}
                      aria-label="发送"
                      title="发送"
                    >
                      ↑
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </aside>
          {collapsedPanels.workspace ? (
            <button
              type="button"
              className="workspace-expand-button"
              onClick={() => setCollapsedPanels((current) => ({ ...current, workspace: false }))}
              aria-label="展开工作区"
              title="展开工作区"
            >
              ›
            </button>
          ) : null}
        </main>
      ) : null}

      {activeToolPanel ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setActiveToolPanel(null)}>
          <section className="modal-panel" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{activeToolPanel === 'skills' ? 'Skills Plaza' : 'Remote WeChat'}</p>
                <h2>{activeToolPanel === 'skills' ? '情景剧技能广场' : '远程微信接入'}</h2>
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
                      <button type="button" onClick={() => void toggleSkill(skill)}>
                        {skill.enabled ? '已启用' : '已停用'}
                      </button>
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
                <p className={`status-pill ${wechatStatus?.state === 'connected' ? 'success' : 'idle'}`}>
                  {wechatStatus?.state === 'connected' ? `已连接：${wechatStatus.connection?.displayName}` : '未连接'}
                </p>
                <div className="wechat-card">
                  <button type="button" onClick={() => void createWechatSetup()}>生成连接码</button>
                  {wechatSetup ? (
                    <>
                      <code>{wechatSetup.qrUrl}</code>
                      <button type="button" onClick={() => void completeWechatSetup()}>模拟扫码完成</button>
                    </>
                  ) : null}
                </div>
                <p className="muted">微信入站消息会写入当前工作区的 remote-wechat 目录，作为远程灵感和修改请求。</p>
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
          {chatSessions.find((session) => session.id === chatSessionContextMenu.sessionId)?.archivedAt ? (
            <button type="button" onClick={() => void restoreChatSession(chatSessionContextMenu.sessionId)}>恢复会话</button>
          ) : (
            <button type="button" onClick={() => void archiveChatSession(chatSessionContextMenu.sessionId)}>归档会话</button>
          )}
        </div>
      ) : null}
      {selectedTextContextMenu ? (
        <div
          className="sidebar-context-menu"
          style={{ left: selectedTextContextMenu.x, top: selectedTextContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={quoteSelectedTextToComposer}>引用到对话</button>
        </div>
      ) : null}
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

function timestampFromIso(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
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

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function joinWorkspacePath(base: string | null, leaf: string): string {
  return [base, leaf].filter(Boolean).join('/');
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
    case 'run.end':
      return event.error ? `${event.status}: ${event.error}` : event.status;
  }
}

function createChatMessage(
  role: ChatMessage['role'],
  content: string,
  options: { events?: RunEvent[]; referencedFiles?: ReferencedFile[]; streamEvents?: StreamEvent[]; status?: RunState } = {},
): ChatMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    events: options.events,
    referencedFiles: options.referencedFiles ?? [],
    streamEvents: options.streamEvents ?? [],
    status: options.status,
  };
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

function AssistantStreamBody({ message }: { message: ChatMessage }): JSX.Element {
  if (message.streamEvents.length === 0) {
    return (
      <div className="chat-markdown">
        <MarkdownReadPreview content={message.content || (message.status === 'running' ? '正在思考...' : '')} />
      </div>
    );
  }

  const thinking = collectThinkingBlocks(message.streamEvents);
  const tools = collectToolCalls(message.streamEvents);

  return (
    <div className="assistant-stream">
      {thinking.map((block) => (
        <details key={block.sequence} className="thinking-block" open={message.status === 'running'}>
          <summary>思考过程</summary>
          <div>{block.text || '正在思考...'}</div>
        </details>
      ))}
      {tools.length > 0 ? (
        <div className="tool-call-list">
          {tools.map((toolCall) => (
            <details key={toolCall.id} className="tool-call-card">
              <summary>
                <span>{toolCall.name}</span>
                <em>{toolCall.status}</em>
              </summary>
              {toolCall.input ? (
                <pre>{toolCall.input}</pre>
              ) : null}
              {toolCall.output ? (
                <pre>{toolCall.output}</pre>
              ) : null}
            </details>
          ))}
        </div>
      ) : null}
      <div className="chat-markdown">
        <MarkdownReadPreview content={message.content || (message.status === 'running' ? '正在生成...' : '')} />
      </div>
    </div>
  );
}

function collectThinkingBlocks(events: StreamEvent[]): Array<{ sequence: number; text: string }> {
  const blocks = new Map<number, string>();

  for (const event of events) {
    if (event.type === 'thinking.delta') {
      blocks.set(event.sequence, (blocks.get(event.sequence) ?? '') + event.delta);
    }
    if (event.type === 'thinking.end') {
      blocks.set(event.sequence, event.text);
    }
  }

  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sequence, text]) => ({ sequence, text }));
}

function collectToolCalls(events: StreamEvent[]): Array<{
  id: string;
  name: string;
  input: string;
  output: string;
  status: string;
}> {
  const toolCalls = new Map<string, { id: string; name: string; input: string; output: string; status: string }>();

  for (const event of events) {
    if (event.type === 'tool_use.start') {
      toolCalls.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        input: '',
        output: '',
        status: 'running',
      });
    }
    if (event.type === 'tool_use.delta') {
      const toolCall = toolCalls.get(event.toolCallId);
      if (!toolCall) continue;
      if (event.stream === 'input') {
        toolCall.input += event.delta;
      } else {
        toolCall.output += event.delta;
      }
    }
    if (event.type === 'tool_use.end') {
      const toolCall = toolCalls.get(event.toolCallId) ?? {
        id: event.toolCallId,
        name: event.toolCallId,
        input: '',
        output: '',
        status: event.status,
      };
      toolCall.status = event.status;
      toolCall.output = event.outputText ?? toolCall.output;
      if (event.errorMessage) {
        toolCall.output = event.errorMessage;
      }
      toolCalls.set(event.toolCallId, toolCall);
    }
  }

  return [...toolCalls.values()];
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function formatChatTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
