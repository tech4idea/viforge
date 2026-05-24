import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { Workbook } from '@fortune-sheet/react';
import type { Sheet } from '@fortune-sheet/core';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import '@milkdown/theme-nord/style.css';
import '@fortune-sheet/react/dist/index.css';
import { useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { WorkspaceEntry } from './api';
import { detectViewerKind, type ViewerKind } from './viewers';

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
      return <div className="editor-empty">正在加载 Markdown 文档...</div>;
    }

    return (
      <MarkdownEditor
        key={buildMarkdownInstanceKey(props.entry.path, props.savedContent)}
        filePath={props.entry.path}
        value={props.fileContent}
        onChange={props.onChange}
      />
    );
  }

  if (kind === 'sheet') {
    if (props.fileState === 'loading') {
      return <div className="editor-empty">正在加载表格文件...</div>;
    }

    return <SheetEditor filePath={props.entry.path} content={props.fileContent} onChange={props.onChange} />;
  }

  if (kind === 'code') {
    if (props.fileState === 'loading') {
      return <div className="editor-empty">正在加载文本文件...</div>;
    }

    return <CodeEditor content={props.fileContent} filePath={props.entry.path} onChange={props.onChange} />;
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

function MarkdownEditor({
  filePath,
  value,
  onChange,
}: {
  filePath: string;
  value: string;
  onChange: (content: string) => void;
}): JSX.Element {
  return (
    <div className="markdown-editor-viewer" data-color-mode="light">
      <MilkdownProvider>
        <MilkdownEditorInner filePath={filePath} value={value} onChange={onChange} />
      </MilkdownProvider>
    </div>
  );
}

function MilkdownEditorInner({
  filePath,
  value,
  onChange,
}: {
  filePath: string;
  value: string;
  onChange: (content: string) => void;
}): JSX.Element {
  const initialMarkdown = useRef(value);
  const currentPath = useRef(filePath);
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  if (currentPath.current !== filePath) {
    currentPath.current = filePath;
    initialMarkdown.current = value;
  }

  useEditor((root) =>
    Editor.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialMarkdown.current);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { class: 'milkdown-editor', spellcheck: 'false' },
        }));
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          latestOnChange.current(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(listener), [filePath]);

  return <Milkdown />;
}

function SheetEditor({
  filePath,
  content,
  onChange,
}: {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
}): JSX.Element {
  const data = useMemo(() => parseSheetContent(filePath, content), [content, filePath]);

  return (
    <div className="sheet-editor-viewer">
      <Workbook
        data={data}
        onChange={(next) => onChange(serializeSheet(next))}
        allowEdit={true}
        showToolbar={true}
        showFormulaBar={true}
        showSheetTabs={true}
      />
    </div>
  );
}

function CodeEditor({
  content,
  filePath,
  onChange,
}: {
  content: string;
  filePath: string;
  onChange: (content: string) => void;
}): JSX.Element {
  const language = detectLanguage(filePath);
  const highlighted = useMemo(
    () => hljs.highlight(content || '', { language, ignoreIllegals: true }).value,
    [content, language],
  );

  return (
    <div className="code-editor-viewer">
      <textarea value={content} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      <pre className="code-editor-preview">
        <span className="code-preview-label">{language.toUpperCase()}</span>
        <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

export function MarkdownReadPreview({ content }: { content: string }): JSX.Element {
  return (
    <div className="markdown-read-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function parseSheetContent(filePath: string, content: string): Sheet[] {
  if (/\.csv$/i.test(filePath)) {
    const rows = content.split('\n').map((line) => line.split(','));
    return [{
      id: 'sheet-1',
      name: 'Sheet1',
      celldata: rows.flatMap((cells, row) =>
        cells.map((value, column) => ({
          r: row,
          c: column,
          v: { v: value, m: value, ct: { fa: 'General', t: 'g' } },
        })),
      ),
      order: 0,
      status: 1,
      row: rows.length,
      column: Math.max(...rows.map((row) => row.length), 1),
    } as unknown as Sheet];
  }

  try {
    return JSON.parse(content) as Sheet[];
  } catch {
    return [{
      id: 'sheet-1',
      name: 'Sheet1',
      celldata: [],
      order: 0,
      status: 1,
      row: 20,
      column: 8,
    } as unknown as Sheet];
  }
}

function serializeSheet(sheets: Sheet[]): string {
  return JSON.stringify(sheets);
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    toml: 'toml',
    css: 'css',
    html: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    txt: 'plaintext',
    pug: 'haml',
  };
  return map[ext] ?? 'plaintext';
}
