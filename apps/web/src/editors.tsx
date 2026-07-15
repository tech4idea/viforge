import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/core';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { nord } from '@milkdown/theme-nord';
import { $prose, getMarkdown, replaceAll } from '@milkdown/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { Workbook } from '@fortune-sheet/react';
import type { Sheet } from '@fortune-sheet/core';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import '@milkdown/theme-nord/style.css';
import '@fortune-sheet/react/dist/index.css';
import { useEffect, useMemo, useRef, useState } from 'react';

import { buildMarkdownRawUrl, resolveMarkdownWorkspacePath } from './markdown-workspace';

export function MarkdownEditor({
  filePath,
  value,
  rawPreviewUrl,
  mode = 'wysiwyg',
  onChange,
}: {
  filePath: string;
  value: string;
  rawPreviewUrl?: string;
  mode?: 'source' | 'wysiwyg';
  onChange: (content: string) => void;
}): JSX.Element {
  if (mode === 'source') {
    return (
      <div className="markdown-editor-viewer markdown-editor-viewer--source">
        <textarea
          className="markdown-source-editor"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div className="markdown-editor-viewer markdown-editor-viewer--wysiwyg" data-color-mode="light">
      <MilkdownProvider>
        <MilkdownEditorInner filePath={filePath} value={value} rawPreviewUrl={rawPreviewUrl} onChange={onChange} />
      </MilkdownProvider>
    </div>
  );
}

function MilkdownEditorInner({
  filePath,
  value,
  rawPreviewUrl,
  onChange,
}: {
  filePath: string;
  value: string;
  rawPreviewUrl?: string;
  onChange: (content: string) => void;
}): JSX.Element {
  const latestOnChange = useRef(onChange);
  const lastSyncedValue = useRef(value);
  const skipNextMarkdownUpdate = useRef(false);
  latestOnChange.current = onChange;

  const editor = useEditor((root) =>
    Editor.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, value);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { class: 'milkdown-editor', spellcheck: 'false' },
        }));
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          lastSyncedValue.current = md;
          if (skipNextMarkdownUpdate.current) {
            skipNextMarkdownUpdate.current = false;
            return;
          }
          latestOnChange.current(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(markdownWorkspaceImageView(filePath, rawPreviewUrl))
      .use(listener), [filePath, rawPreviewUrl]);

  useEffect(() => {
    const instance = editor.get();
    if (!instance) {
      lastSyncedValue.current = value;
      return;
    }
    if (value === lastSyncedValue.current) return;

    const currentMarkdown = instance.action(getMarkdown());
    if (currentMarkdown === value) {
      lastSyncedValue.current = value;
      return;
    }

    skipNextMarkdownUpdate.current = true;
    lastSyncedValue.current = value;
    instance.action(replaceAll(value, true));
  }, [editor, value]);

  return (
    <div className="markdown-rich-scroll">
      <Milkdown />
    </div>
  );
}

function markdownWorkspaceImageView(filePath: string, rawPreviewUrl?: string) {
  return $prose(() => new Plugin({
    props: {
      nodeViews: {
        image: (node, view, getPos) => new WorkspaceImageNodeView(node, view, getPos, filePath, rawPreviewUrl),
      },
    },
  }));
}

class WorkspaceImageNodeView implements NodeView {
  dom: HTMLElement;
  private image: HTMLImageElement;
  private input: HTMLInputElement;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: (() => number | undefined) | boolean,
    private readonly filePath: string,
    private readonly rawPreviewUrl?: string,
  ) {
    this.node = node;
    this.dom = document.createElement('figure');
    this.dom.className = 'markdown-image-node-view';
    this.dom.contentEditable = 'false';

    this.image = document.createElement('img');
    this.image.draggable = false;
    this.image.addEventListener('click', () => {
      this.input.focus();
      this.input.select();
    });

    this.input = document.createElement('input');
    this.input.className = 'markdown-image-node-view__src';
    this.input.type = 'text';
    this.input.setAttribute('aria-label', 'Markdown 图片路径');
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitSrc();
        this.view.focus();
      }
      if (event.key === 'Escape') {
        this.input.value = this.rawSrc();
        this.view.focus();
      }
    });
    this.input.addEventListener('blur', () => this.commitSrc());

    this.dom.append(this.image, this.input);
    this.syncDom();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.syncDom();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target === this.input;
  }

  ignoreMutation(): boolean {
    return true;
  }

  private syncDom(): void {
    const src = this.rawSrc();
    this.image.src = this.displaySrc(src);
    this.image.alt = typeof this.node.attrs.alt === 'string' ? this.node.attrs.alt : '';
    this.image.title = src;
    if (document.activeElement !== this.input) this.input.value = src;
  }

  private rawSrc(): string {
    return typeof this.node.attrs.src === 'string' ? this.node.attrs.src : '';
  }

  private displaySrc(src: string): string {
    const targetPath = resolveMarkdownWorkspacePath(this.filePath, src);
    return targetPath && this.rawPreviewUrl
      ? buildMarkdownRawUrl(this.rawPreviewUrl, this.filePath, targetPath)
      : src;
  }

  private commitSrc(): void {
    if (typeof this.getPos !== 'function') return;
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const nextSrc = this.input.value.trim();
    if (!nextSrc || nextSrc === this.rawSrc()) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      src: nextSrc,
    }));
  }
}

export function SheetEditor({
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

export function CodeEditor({
  content,
  filePath,
  onChange,
}: {
  content: string;
  filePath: string;
  onChange: (content: string) => void;
}): JSX.Element {
  const language = detectLanguage(filePath);
  const [highlighted, setHighlighted] = useState(
    () => hljs.highlight(content || '', { language, ignoreIllegals: true }).value,
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setHighlighted(hljs.highlight(content || '', { language, ignoreIllegals: true }).value);
    }, 150);
    return () => clearTimeout(timer);
  }, [content, language]);

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



