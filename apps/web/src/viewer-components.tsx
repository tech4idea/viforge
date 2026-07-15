import { lazy, memo, Suspense, useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { WorkspaceEntry } from './api';
import { buildMarkdownRawUrl, resolveMarkdownWorkspacePath } from './markdown-workspace';
import { detectViewerKind, type ViewerKind } from './viewers';
import { ZoomIn, ZoomOut, Maximize2, RotateCcw } from './components/icons';

const LazyMarkdownEditor = lazy(() => import('./editors').then((m) => ({ default: m.MarkdownEditor })));
const LazySheetEditor = lazy(() => import('./editors').then((m) => ({ default: m.SheetEditor })));
const LazyCodeEditor = lazy(() => import('./editors').then((m) => ({ default: m.CodeEditor })));

interface EditorViewerProps {
  entry: WorkspaceEntry;
  selectedProjectId: string;
  fileContent: string;
  savedContent: string;
  fileState: 'idle' | 'loading' | 'error';
  fileError: string | null;
  rawPreviewUrl: string;
  workspaceEntries?: WorkspaceEntry[];
  markdownMode?: 'source' | 'split' | 'preview';
  onChange: (content: string) => void;
  onNavigateToPath?: (path: string) => void;
}

function EditorFallback({ label }: { label: string }): JSX.Element {
  return <div className="editor-empty">正在加载{label}...</div>;
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 10;
const ZOOM_STEP = 0.15;

function ImageViewer({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const handleImageLoad = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const cw = canvas.clientWidth - 16;
    const ch = canvas.clientHeight - 16;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw === 0 || nh === 0) return;
    const fit = Math.min(cw / nw, ch / nh, 1);
    setFitScale(fit);
    setScale(fit);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const zoom = useCallback((factor: number) => {
    setScale((s) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s * factor)));
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: event.clientX, y: event.clientY };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent) => {
    if (!dragging.current) return;
    const dx = event.clientX - lastPos.current.x;
    const dy = event.clientY - lastPos.current.y;
    lastPos.current = { x: event.clientX, y: event.clientY };
    setTranslate((t) => ({ x: t.x + dx, y: t.y + dy }));
  }, []);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const handleDoubleClick = useCallback(() => {
    setScale(fitScale);
    setTranslate({ x: 0, y: 0 });
  }, [fitScale]);

  const resetView = useCallback(() => {
    setScale(fitScale);
    setTranslate({ x: 0, y: 0 });
  }, [fitScale]);

  const percent = Math.round(scale * 100);

  return (
    <div className="image-viewer">
      <div className="image-viewer__toolbar">
        <button type="button" onClick={() => zoom(1 - ZOOM_STEP)} aria-label="缩小" title="缩小">
          <ZoomOut size={16} />
        </button>
        <span className="image-viewer__zoom-label">{percent}%</span>
        <button type="button" onClick={() => zoom(1 + ZOOM_STEP)} aria-label="放大" title="放大">
          <ZoomIn size={16} />
        </button>
        <span className="image-viewer__separator" />
        <button type="button" onClick={resetView} aria-label="适应窗口" title="适应窗口">
          <Maximize2 size={16} />
        </button>
        <button type="button" onClick={() => { setScale(1); setTranslate({ x: 0, y: 0 }); }} aria-label="原始大小" title="原始大小 (1:1)">
          <RotateCcw size={16} />
        </button>
      </div>
      <div
        className="image-viewer__canvas"
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className="image-viewer__img"
          style={{ transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})` }}
          onLoad={handleImageLoad}
          draggable={false}
        />
      </div>
    </div>
  );
}

export function renderEditorViewer(props: EditorViewerProps): JSX.Element {
  const kind = detectViewerKind(props.entry.path);

  if (kind === 'image') {
    return <ImageViewer src={props.rawPreviewUrl} alt={props.entry.name} />;
  }

  if (kind === 'pdf' || kind === 'html') {
    return <iframe className="document-preview" src={props.rawPreviewUrl} title={props.entry.name} />;
  }

  if (kind === 'markdown') {
    if (props.fileState === 'loading') {
      return <EditorFallback label="Markdown 文档" />;
    }

    if (props.markdownMode === 'preview') {
      return (
        <MarkdownReadPreview
          content={props.fileContent}
          currentPath={props.entry.path}
          rawPreviewUrl={props.rawPreviewUrl}
          workspaceEntries={props.workspaceEntries ?? []}
          onNavigateToPath={props.onNavigateToPath}
        />
      );
    }

    return (
      <Suspense fallback={<EditorFallback label="Markdown 编辑器" />}>
        <LazyMarkdownEditor
          key={buildMarkdownInstanceKey(props.entry.path, props.savedContent)}
          filePath={props.entry.path}
          value={props.fileContent}
          rawPreviewUrl={props.rawPreviewUrl}
          mode={props.markdownMode === 'source' ? 'source' : 'split'}
          onChange={props.onChange}
        />
      </Suspense>
    );
  }

  if (kind === 'sheet') {
    if (props.fileState === 'loading') {
      return <EditorFallback label="表格文件" />;
    }

    return (
      <Suspense fallback={<EditorFallback label="表格编辑器" />}>
        <LazySheetEditor
          filePath={props.entry.path}
          content={props.fileContent}
          onChange={props.onChange}
        />
      </Suspense>
    );
  }

  if (kind === 'code') {
    if (props.fileState === 'loading') {
      return <EditorFallback label="文本文件" />;
    }

    return (
      <Suspense fallback={<EditorFallback label="代码编辑器" />}>
        <LazyCodeEditor
          content={props.fileContent}
          filePath={props.entry.path}
          onChange={props.onChange}
        />
      </Suspense>
    );
  }

  return <div className="editor-empty">该素材可以保存在项目中，但当前没有可视预览。</div>;
}

export function ViewerPreviewLabel(path: string): ViewerKind {
  return detectViewerKind(path);
}

export function buildMarkdownInstanceKey(filePath: string, savedContent: string): string {
  let hash = 0;
  for (let index = 0; index < savedContent.length; index += 1) {
    hash = (hash * 31 + savedContent.charCodeAt(index)) >>> 0;
  }
  return `${filePath}:${savedContent.length}:${hash}`;
}

export const MarkdownReadPreview = memo(function MarkdownReadPreview({
  content,
  currentPath,
  rawPreviewUrl,
  workspaceEntries = [],
  onNavigateToPath,
}: {
  content: string;
  currentPath?: string;
  rawPreviewUrl?: string;
  workspaceEntries?: WorkspaceEntry[];
  onNavigateToPath?: (path: string) => void;
}): JSX.Element {
  const filePaths = useMemo(() => new Set(workspaceEntries.filter((entry) => entry.type === 'file').map((entry) => entry.path)), [workspaceEntries]);

  return (
    <div className="markdown-read-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...anchorProps }) {
            const targetPath = currentPath && href ? resolveMarkdownWorkspacePath(currentPath, href) : null;
            const resolvedHref = targetPath && rawPreviewUrl && currentPath
              ? buildMarkdownRawUrl(rawPreviewUrl, currentPath, targetPath)
              : href;
            const canNavigate = Boolean(targetPath && filePaths.has(targetPath) && onNavigateToPath);
            return (
              <a
                {...anchorProps}
                href={resolvedHref}
                onClick={canNavigate ? (event) => {
                  event.preventDefault();
                  onNavigateToPath?.(targetPath!);
                } : anchorProps.onClick}
              >
                {children}
              </a>
            );
          },
          img({ src, alt, ...imageProps }) {
            const targetPath = currentPath && src ? resolveMarkdownWorkspacePath(currentPath, src) : null;
            const resolvedSrc = targetPath && rawPreviewUrl && currentPath
              ? buildMarkdownRawUrl(rawPreviewUrl, currentPath, targetPath)
              : src;
            return <img {...imageProps} src={resolvedSrc} alt={alt ?? ''} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
