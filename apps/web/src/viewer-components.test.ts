import { describe, expect, it } from 'vitest';

import { buildMarkdownInstanceKey, detectLanguage, renderEditorViewer } from './viewer-components';

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
  it('uses code editing for toml instead of markdown editing', () => {
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

    expect(typeof viewer.type).toBe('function');
    expect((viewer.type as { name?: string }).name).toBe('CodeEditor');
  });

  it('maps toml to toml syntax highlighting', () => {
    expect(detectLanguage('agent/config.toml')).toBe('toml');
  });
});
