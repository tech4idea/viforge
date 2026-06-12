import {
  Diamond,
  FileText,
  GitBranch,
  LayoutPanelLeft,
  MessageCircle,
  Moon,
  Palette,
  Settings,
  Smartphone,
  Sun,
} from './icons';

export type ThemeMode = 'light' | 'dark' | 'soft';

function themeIcon(mode: ThemeMode): JSX.Element {
  if (mode === 'dark') return <Moon size={20} />;
  if (mode === 'soft') return <Palette size={20} />;
  return <Sun size={20} />;
}

export function ActivityRail({
  sidebarOpen,
  editorOpen,
  chatOpen,
  themeMode,
  onToggleSidebar,
  onToggleEditor,
  onToggleChat,
  onToggleTheme,
  onOpenSettings,
  onOpenWechat,
  onOpenGitSync,
}: {
  sidebarOpen: boolean;
  editorOpen: boolean;
  chatOpen: boolean;
  themeMode: ThemeMode;
  onToggleSidebar: () => void;
  onToggleEditor: () => void;
  onToggleChat: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenWechat: () => void;
  onOpenGitSync: () => void;
}): JSX.Element {
  return (
    <nav className="activity-rail" aria-label="主导航">
      <img className="rail-logo" src="/viwork-logo.svg" alt="viwork" />

      <button
        type="button"
        className={`rail-button ${sidebarOpen ? 'active' : ''}`}
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? '关闭工作区' : '打开工作区'}
        title={sidebarOpen ? '关闭工作区' : '打开工作区'}
      >
        <LayoutPanelLeft size={20} />
      </button>

      <div className="rail-divider" />

      <button
        type="button"
        className={`rail-button ${editorOpen ? 'active' : ''}`}
        onClick={onToggleEditor}
        aria-label={editorOpen ? '收起编辑器' : '展开编辑器'}
        title={editorOpen ? '收起编辑器' : '展开编辑器'}
      >
        <FileText size={20} />
      </button>

      <button
        type="button"
        className={`rail-button ${chatOpen ? 'active' : ''}`}
        onClick={onToggleChat}
        aria-label={chatOpen ? '关闭创作助手' : '打开创作助手'}
        title={chatOpen ? '关闭创作助手' : '打开创作助手'}
      >
        <MessageCircle size={20} />
      </button>

      <div className="rail-spacer" />

      <button
        type="button"
        className="rail-button"
        onClick={onOpenWechat}
        aria-label="微信接入"
        title="微信接入"
      >
        <Smartphone size={20} />
      </button>

      <button
        type="button"
        className="rail-button"
        onClick={onOpenGitSync}
        aria-label="版本管理"
        title="版本管理"
      >
        <GitBranch size={20} />
      </button>

      <button
        type="button"
        className="rail-button"
        onClick={onOpenSettings}
        aria-label="Agent 设置"
        title="Agent 设置"
      >
        <Settings size={20} />
      </button>

      <button
        type="button"
        className="rail-button"
        onClick={onToggleTheme}
        aria-label="切换主题"
        title="切换主题"
      >
        {themeIcon(themeMode)}
      </button>
    </nav>
  );
}
