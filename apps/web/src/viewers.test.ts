import { describe, expect, it } from 'vitest';

import { detectViewerKind } from './viewers';

describe('detectViewerKind', () => {
  it('detects markdown viewers', () => {
    expect(detectViewerKind('script.md')).toBe('markdown');
    expect(detectViewerKind('notes.markdown')).toBe('markdown');
  });

  it('detects sheet viewers', () => {
    expect(detectViewerKind('storyboard.xlsx')).toBe('sheet');
    expect(detectViewerKind('shot-list.xls')).toBe('sheet');
    expect(detectViewerKind('assets.csv')).toBe('sheet');
  });

  it('detects image/pdf/html viewers', () => {
    expect(detectViewerKind('location.png')).toBe('image');
    expect(detectViewerKind('lookbook.pdf')).toBe('pdf');
    expect(detectViewerKind('moodboard.html')).toBe('html');
  });

  it('detects code viewers for text-like files', () => {
    expect(detectViewerKind('project.json')).toBe('code');
    expect(detectViewerKind('scene.txt')).toBe('code');
    expect(detectViewerKind('agent/config.toml')).toBe('code');
    expect(detectViewerKind('layout.css')).toBe('code');
  });

  it('falls back to binary for unsupported assets', () => {
    expect(detectViewerKind('voice.wav')).toBe('binary');
    expect(detectViewerKind('archive.zip')).toBe('binary');
  });
});
