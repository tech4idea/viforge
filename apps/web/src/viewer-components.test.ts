import { createElement, Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownReadPreview, buildMarkdownInstanceKey, renderEditorViewer } from './viewer-components';
import { buildMarkdownRawUrl, resolveMarkdownWorkspacePath } from './markdown-workspace';
import { MarkdownEditor, detectLanguage } from './editors';

describe('buildMarkdownInstanceKey', () => {
  it('changes when switching files', () => {
    expect(buildMarkdownInstanceKey('script.md', '# scene')).not.toBe(
      buildMarkdownInstanceKey('notes.md', '# scene'),
    );
  });

  it('changes when a newly loaded file has different saved content', () => {
    expect(buildMarkdownInstanceKey('script.md', '')).not.toBe(
      buildMarkdownInstanceKey('script.md', '# loaded'),
    );
  });
});

describe('text editor viewer selection', () => {
  it('wraps code editor in Suspense for lazy loading', () => {
    const viewer = renderEditorViewer({
      entry: { name: 'config.toml', path: 'agent/config.toml', type: 'file', size: 18 },
      selectedProjectId: 'global',
      fileContent: 'model = "gpt-5"',
      savedContent: 'model = "gpt-5"',
      fileState: 'idle',
      fileError: null,
      rawPreviewUrl: '/raw/agent/config.toml',
      onChange: () => undefined,
    });

    expect(viewer.type).toBe(Suspense);
    expect(viewer.props.fallback.props.label).toBe('代码编辑器');
  });

  it('maps toml to toml syntax highlighting', () => {
    expect(detectLanguage('agent/config.toml')).toBe('toml');
  });
});

describe('markdown workspace references', () => {
  it('resolves relative links beside the current markdown file', () => {
    expect(resolveMarkdownWorkspacePath('docs/episode-1/outline.md', './assets/scene.png')).toBe('docs/episode-1/assets/scene.png');
  });

  it('resolves parent directory links without escaping workspace root', () => {
    expect(resolveMarkdownWorkspacePath('docs/episode-1/outline.md', '../characters.md#lead')).toBe('docs/characters.md');
  });

  it('ignores external links', () => {
    expect(resolveMarkdownWorkspacePath('docs/outline.md', 'https://example.com/ref.md')).toBeNull();
  });

  it('builds raw image urls for local markdown assets with encoded paths', () => {
    expect(buildMarkdownRawUrl(
      '/api/projects/project-1/raw/docs/episode-1/outline.md',
      'docs/episode-1/outline.md',
      'docs/episode-1/assets/场景 图.png',
    )).toBe('/api/projects/project-1/raw/docs/episode-1/assets/%E5%9C%BA%E6%99%AF%20%E5%9B%BE.png');
  });

  it('preserves desktop token query params when switching markdown asset paths', () => {
    expect(buildMarkdownRawUrl(
      '/api/global/raw/%E6%A8%A1%E6%9D%BF/outline.md?desktopToken=token-1',
      '模板/outline.md',
      '模板/assets/参考.png',
    )).toBe('/api/global/raw/%E6%A8%A1%E6%9D%BF/assets/%E5%8F%82%E8%80%83.png?desktopToken=token-1');
  });

  it('builds from the raw route prefix when the current document suffix does not match', () => {
    expect(buildMarkdownRawUrl(
      '/api/projects/822abc50-0d54-4162-95e9-56603c77d94d/raw/current.md?desktopToken=token-1',
      '01 学习目标/世界观设定.md',
      '生成图片/世界观/2026-07-13T16-10-57-924Z.png',
    )).toBe('/api/projects/822abc50-0d54-4162-95e9-56603c77d94d/raw/%E7%94%9F%E6%88%90%E5%9B%BE%E7%89%87/%E4%B8%96%E7%95%8C%E8%A7%82/2026-07-13T16-10-57-924Z.png?desktopToken=token-1');
  });

  it('renders workspace image and file references through raw urls', () => {
    const html = renderToStaticMarkup(createElement(MarkdownReadPreview, {
      content: '![图](../生成图片/世界观/2026-07-13T16-10-57-924Z.png)\n\n[设定](../生成图片/世界观/2026-07-13T16-10-57-924Z.png)',
      currentPath: '01 学习目标/世界观设定.md',
      rawPreviewUrl: '/api/projects/822abc50-0d54-4162-95e9-56603c77d94d/raw/01%20%E5%AD%A6%E4%B9%A0%E7%9B%AE%E6%A0%87/%E4%B8%96%E7%95%8C%E8%A7%82%E8%AE%BE%E5%AE%9A.md',
    }));

    expect(html).toContain('src="/api/projects/822abc50-0d54-4162-95e9-56603c77d94d/raw/%E7%94%9F%E6%88%90%E5%9B%BE%E7%89%87/%E4%B8%96%E7%95%8C%E8%A7%82/2026-07-13T16-10-57-924Z.png"');
    expect(html).toContain('href="/api/projects/822abc50-0d54-4162-95e9-56603c77d94d/raw/%E7%94%9F%E6%88%90%E5%9B%BE%E7%89%87/%E4%B8%96%E7%95%8C%E8%A7%82/2026-07-13T16-10-57-924Z.png"');
  });
  it('uses the lazy rich Markdown editor for interactive GFM editing by default', () => {
    const viewer = renderEditorViewer({
      entry: { name: '世界观设定.md', path: '01 学习目标/世界观设定.md', type: 'file', size: 42 },
      selectedProjectId: 'project-1',
      fileContent: '| A | B |\n| - | - |\n| 1 | 2 |',
      savedContent: '| A | B |\n| - | - |\n| 1 | 2 |',
      fileState: 'idle',
      fileError: null,
      rawPreviewUrl: '/api/projects/project-1/raw/01%20%E5%AD%A6%E4%B9%A0%E7%9B%AE%E6%A0%87/%E4%B8%96%E7%95%8C%E8%A7%82%E8%AE%BE%E5%AE%9A.md',
      onChange: () => undefined,
    });

    expect(viewer.type).toBe(Suspense);
    expect(viewer.props.fallback.props.label).toBe('Markdown 编辑器');
  });
  it('renders source markdown mode for direct path editing', () => {
    const html = renderToStaticMarkup(createElement(MarkdownEditor, {
      filePath: '01 学习目标/世界观设定.md',
      value: '![图](../生成图片/世界观/2026-07-13T16-10-57-924Z.png)',
      rawPreviewUrl: '/api/projects/project-1/raw/01%20%E5%AD%A6%E4%B9%A0%E7%9B%AE%E6%A0%87/%E4%B8%96%E7%95%8C%E8%A7%82%E8%AE%BE%E5%AE%9A.md',
      mode: 'source',
      onChange: () => undefined,
    }));

    expect(html).toContain('markdown-editor-viewer--source');
    expect(html).toContain('../生成图片/世界观/2026-07-13T16-10-57-924Z.png');
    expect(html).not.toContain('markdown-image-node-view');
  });
});

