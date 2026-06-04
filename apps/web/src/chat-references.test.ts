import { describe, expect, it } from 'vitest';

import { buildReferenceSuggestions, getActiveReferenceQuery, insertReference, type FileReference } from './chat-references';
import type { WorkspaceEntry } from './api';

const entries: WorkspaceEntry[] = [
  { path: 'script.md', name: 'script.md', type: 'file' },
  { path: 'characters.md', name: 'characters.md', type: 'file' },
  { path: 'episodes/episode-01/outline.md', name: 'outline.md', type: 'file' },
  { path: 'episodes', name: 'episodes', type: 'directory' },
];

describe('chat references', () => {
  it('detects an active @ query at the caret', () => {
    expect(getActiveReferenceQuery('请参考 @scr', '请参考 @scr'.length)).toEqual({
      query: 'scr',
      start: 4,
      end: 8,
    });
  });

  it('ranks matching file suggestions and excludes existing ones', () => {
    const existing: FileReference[] = [{ path: 'script.md', label: 'script.md' }];

    expect(buildReferenceSuggestions(entries, 'out', existing)).toEqual([
      expect.objectContaining({ path: 'episodes/episode-01/outline.md', label: 'outline.md' }),
    ]);
  });

  it('inserts the selected reference into the composer text', () => {
    expect(insertReference('请参考 @scr 生成一版', '请参考 @scr'.length, { path: 'script.md', label: 'script.md' })).toEqual({
      nextText: '请参考 @script.md 生成一版',
      nextCaret: 15,
    });
  });
});
