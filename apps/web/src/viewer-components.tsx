import { lazy, memo, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { WorkspaceEntry } from './api';
import { detectViewerKind, type ViewerKind } from './viewers';

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
  onChange: (content: string) => void;
}

function EditorFallback({ label }: { label: string }): JSX.Element {
  return <div className="editor-empty">正在加载{label}...</div>;
}

export function renderEditorViewer(props: EditorViewerProps): JSX.Element {
  const kind = detectViewerKind(props.entry.path);

  if (kind === 'image') {
    return <img className="asset-preview" src={props.rawPreviewUrl} alt={props.entry.name} />;
  }

  if (kind === 'pdf' || kind === 'html') {
    return <iframe className="document-preview" src={props.rawPreviewUrl} title={props.entry.name} />;
  }

  if (kind === 'markdown') {
    if (props.fileState === 'loading') {
      return <EditorFallback label="Markdown 文档" />;
    }

    return (
      <Suspense fallback={<EditorFallback label="Markdown 编辑器" />}>
        <LazyMarkdownEditor
          key={buildMarkdownInstanceKey(props.entry.path, props.savedContent)}
          filePath={props.entry.path}
          value={props.fileContent}
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

export const MarkdownReadPreview = memo(function MarkdownReadPreview({ content }: { content: string }): JSX.Element {
  return (
    <div className="markdown-read-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
});
