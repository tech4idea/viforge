import { Workbook } from '@fortune-sheet/react';
import type { Sheet } from '@fortune-sheet/core';
import hljs from 'highlight.js/lib/common';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github.css';
import '@fortune-sheet/react/dist/index.css';
import { useEffect, useMemo, useState } from 'react';

import { buildMarkdownRawUrl, resolveMarkdownWorkspacePath } from './markdown-workspace';

export function MarkdownEditor({
  filePath,
  value,
  rawPreviewUrl,
  mode = 'split',
  onChange,
}: {
  filePath: string;
  value: string;
  rawPreviewUrl?: string;
  mode?: 'source' | 'split';
  onChange: (content: string) => void;
}): JSX.Element {
  return (
    <div className={`markdown-editor-viewer markdown-editor-viewer--${mode}`}>
      <textarea
        className="markdown-source-editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      {mode === 'split' ? (
        <div className="markdown-live-preview markdown-read-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a({ href, children, ...anchorProps }) {
                const targetPath = href ? resolveMarkdownWorkspacePath(filePath, href) : null;
                const resolvedHref = targetPath && rawPreviewUrl
                  ? buildMarkdownRawUrl(rawPreviewUrl, filePath, targetPath)
                  : href;
                return <a {...anchorProps} href={resolvedHref}>{children}</a>;
              },
              img({ src, alt, ...imageProps }) {
                const targetPath = src ? resolveMarkdownWorkspacePath(filePath, src) : null;
                const resolvedSrc = targetPath && rawPreviewUrl
                  ? buildMarkdownRawUrl(rawPreviewUrl, filePath, targetPath)
                  : src;
                return <img {...imageProps} src={resolvedSrc} alt={alt ?? ''} />;
              },
            }}
          >
            {value}
          </ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
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
