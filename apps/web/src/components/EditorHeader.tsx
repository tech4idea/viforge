import { Braces, Palette, X } from './icons';
import type { MarkdownMode, PreviewTab } from '../usePreviewTabs';

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function EditorHeader({
  tabs,
  selectedTabId,
  selectedMarkdownMode,
  showMarkdownModeSwitch,
  onSelectTab,
  onCloseTab,
  onOpenTabContextMenu,
  onSetMarkdownMode,
}: {
  tabs: PreviewTab[];
  selectedTabId: string | null;
  selectedMarkdownMode: MarkdownMode;
  showMarkdownModeSwitch: boolean;
  onSelectTab: (tab: PreviewTab) => void;
  onCloseTab: (tabId: string) => void;
  onOpenTabContextMenu: (event: React.MouseEvent, tabId: string) => void;
  onSetMarkdownMode: (mode: MarkdownMode) => void;
}): JSX.Element {
  return (
    <div className="editor-header">
      {tabs.length > 0 ? (
        <div className="editor-tab-strip" role="tablist" aria-label="预览历史">
          {tabs.map((tab) => {
            const active = tab.id === selectedTabId;
            const label = basename(tab.path);
            return (
              <button
                key={tab.id}
                type="button"
                className={`editor-tab${active ? ' active' : ''}`}
                role="tab"
                aria-selected={active}
                title={tab.path}
                onClick={() => onSelectTab(tab)}
                onContextMenu={(event) => onOpenTabContextMenu(event, tab.id)}
              >
                <span>{label}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="editor-tab__close"
                  aria-label={`关闭 ${label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }
                  }}
                >
                  <X size={12} />
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showMarkdownModeSwitch ? (
        <div className="editor-inline-tools">
          <div className="markdown-mode-switch" role="tablist" aria-label="Markdown 编辑模式">
            <button
              type="button"
              className={selectedMarkdownMode === 'wysiwyg' ? 'active' : ''}
              aria-label="富文本编辑"
              title="富文本编辑"
              onClick={() => onSetMarkdownMode('wysiwyg')}
            >
              <Palette size={15} />
            </button>
            <button
              type="button"
              className={selectedMarkdownMode === 'source' ? 'active' : ''}
              aria-label="源码编辑"
              title="源码编辑"
              onClick={() => onSetMarkdownMode('source')}
            >
              <Braces size={15} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

