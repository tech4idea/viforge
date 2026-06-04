import { Suspense } from 'react';
import { describe, expect, it } from 'vitest';

import { buildMarkdownInstanceKey, renderEditorViewer } from './viewer-components';
import { detectLanguage } from './editors';

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
